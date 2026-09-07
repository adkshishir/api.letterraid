import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ClaimOutcome, HeistResult } from './heist.types';

const K_FACTOR = 32;
const XP_PER_GAME = 20;
const XP_WIN_BONUS = 30;
const XP_PER_LEVEL = 500;

/**
 * Bridges the in-memory Heist engine to Postgres.
 *
 * Heist itself stays entirely in-memory (see `HeistService`) — this is the
 * one place a round's outcome touches the database, so a game with no real
 * `Player` on either side (anonymous play on the legacy `/heist` route) can
 * be skipped cheaply without the engine needing to know or care.
 *
 * One `matchId` (or explicit `null` for "don't persist") is cached per room
 * for the room's lifetime, so a claim never re-queries to find out whether
 * this game counts.
 */
@Injectable()
export class HeistResultsService {
  private readonly logger = new Logger(HeistResultsService.name);

  /** roomCode -> matchId, or null when this room isn't backed by real players. */
  private readonly matchIds = new Map<string, string | null>();

  constructor(private readonly prisma: PrismaService) {}

  async startMatch(
    roomCode: string,
    playerIds: readonly string[],
  ): Promise<void> {
    if (this.matchIds.has(roomCode)) return;
    if (playerIds.length !== 2) {
      this.matchIds.set(roomCode, null);
      return;
    }

    try {
      const [player1Id, player2Id] = playerIds;

      const existing = await this.prisma.match.findUnique({
        where: { roomCode },
      });
      if (existing) {
        this.matchIds.set(roomCode, existing.id);
        return;
      }

      const players = await this.prisma.player.findMany({
        where: { id: { in: [player1Id, player2Id] } },
        select: { id: true },
      });
      if (players.length !== 2) {
        // Anonymous or mixed anonymous/authenticated game — nothing to record.
        this.matchIds.set(roomCode, null);
        return;
      }

      const match = await this.prisma.match.create({
        data: { game: 'heist', roomCode, player1Id, player2Id },
      });
      this.matchIds.set(roomCode, match.id);
    } catch (err) {
      this.logger.error(
        `Failed to start match for room ${roomCode}`,
        err as Error,
      );
      this.matchIds.set(roomCode, null);
    }
  }

  async recordClaim(roomCode: string, outcome: ClaimOutcome): Promise<void> {
    const matchId = this.matchIds.get(roomCode);
    if (!matchId) return;

    try {
      await this.prisma.claim.create({
        data: {
          matchId,
          playerId: outcome.playerId,
          word: outcome.word,
          points: outcome.points,
          type: outcome.type === 'steal' ? 'STEAL' : 'POOL',
          stolenFromPlayerId: outcome.stolenFrom,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to record claim for room ${roomCode}`,
        err as Error,
      );
    }
  }

  /** Applies the finished round to `Match` and both players' stats. Returns trophy deltas, or null if unranked/unpersisted. */
  async finishMatch(
    roomCode: string,
    result: HeistResult,
  ): Promise<Record<string, number> | null> {
    const matchId = this.matchIds.get(roomCode);
    this.matchIds.delete(roomCode);
    if (!matchId) return null;

    const [a, b] = result.scores;
    if (!a || !b) return null;

    try {
      const match = await this.prisma.match.update({
        where: { id: matchId },
        data: {
          status: 'COMPLETE',
          endedAt: new Date(),
          winnerId: result.winnerId,
          tied: result.tied,
          player1Score: a.score,
          player1Words: a.words,
          player2Score: b.score,
          player2Words: b.words,
        },
      });

      const [playerA, playerB] = await Promise.all([
        this.prisma.player.findUnique({ where: { id: a.playerId } }),
        this.prisma.player.findUnique({ where: { id: b.playerId } }),
      ]);
      if (!playerA || !playerB) return null;

      const deltaA = this.trophyDelta(
        playerA.trophies,
        playerB.trophies,
        a,
        result,
      );
      const deltaB = this.trophyDelta(
        playerB.trophies,
        playerA.trophies,
        b,
        result,
      );

      await Promise.all([
        this.applyResult(playerA.id, deltaA, a, result),
        this.applyResult(playerB.id, deltaB, b, result),
      ]);

      void match;
      return { [a.playerId]: deltaA, [b.playerId]: deltaB };
    } catch (err) {
      this.logger.error(
        `Failed to finish match for room ${roomCode}`,
        err as Error,
      );
      return null;
    }
  }

  /** Frees the room's slot without recording a result — an abandoned or never-started game. */
  discard(roomCode: string): void {
    this.matchIds.delete(roomCode);
  }

  // ── Scoring ─────────────────────────────────────────────────────────────

  private actualScore(
    playerId: string,
    result: Pick<HeistResult, 'winnerId' | 'tied'>,
  ): number {
    if (result.tied) return 0.5;
    return result.winnerId === playerId ? 1 : 0;
  }

  /** Standard Elo expectation + K-factor delta, so an upset moves trophies more than a expected win. */
  private trophyDelta(
    ownTrophies: number,
    opponentTrophies: number,
    own: { playerId: string },
    result: HeistResult,
  ): number {
    const expected = 1 / (1 + 10 ** ((opponentTrophies - ownTrophies) / 400));
    const actual = this.actualScore(own.playerId, result);
    return Math.round(K_FACTOR * (actual - expected));
  }

  private async applyResult(
    playerId: string,
    trophyDelta: number,
    score: { playerId: string; score: number },
    result: HeistResult,
  ): Promise<void> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
    });
    if (!player) return;

    const won = !result.tied && result.winnerId === playerId;
    const xpGain = XP_PER_GAME + score.score + (won ? XP_WIN_BONUS : 0);
    const nextXp = player.xp + xpGain;
    const nextStreak = won ? player.winStreak + 1 : 0;

    await this.prisma.player.update({
      where: { id: playerId },
      data: {
        trophies: Math.max(0, player.trophies + trophyDelta),
        xp: nextXp,
        level: Math.floor(nextXp / XP_PER_LEVEL) + 1,
        totalGames: { increment: 1 },
        totalWins: won ? { increment: 1 } : undefined,
        winStreak: nextStreak,
        bestStreak: Math.max(player.bestStreak, nextStreak),
      },
    });
  }
}
