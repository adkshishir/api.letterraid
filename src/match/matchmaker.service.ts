import { Injectable, Logger } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { DEFAULT_ROOM_MODE } from '../rooms/room.types.js';
import type { Player, Match } from '@prisma/client';

export interface QueueEntry {
  playerId: string;
  displayName: string;
  trophies: number;
  joinedAt: number;
}

export interface MatchResult {
  match: Match;
  roomCode: string;
  player1: Player;
  player2: Player;
}

export class ActiveMatch {
  @ApiProperty() matchId!: string;
  @ApiProperty({ description: 'Join /room/:roomCode over the /heist socket namespace.' })
  roomCode!: string;
  @ApiProperty() opponentName!: string;
}

export class MatchHistoryEntry {
  @ApiProperty() matchId!: string;
  @ApiProperty() opponentName!: string;
  @ApiProperty({ enum: ['W', 'L', 'T'] }) result!: 'W' | 'L' | 'T';
  @ApiProperty() score!: number;
  @ApiProperty() words!: number;
  @ApiProperty() endedAt!: string;
}

const TROPHY_RANGE_INITIAL = 200;
const TROPHY_RANGE_EXPANDED = 500;
const EXPAND_AFTER_MS = 30_000;
const MATCH_ANY_AFTER_MS = 60_000;
const TICK_INTERVAL_MS = 1_000;

/**
 * How long a queued player waits with no human opponent found before the
 * matchmaker seats a bot instead. Deliberately well inside `EXPAND_AFTER_MS`
 * — a bot fallback is meant to end the wait, not compete with the human
 * search's own range expansion.
 */
const BOT_FALLBACK_MS = 15_000;

/**
 * How close (in trophies) a bot persona has to be to the human's own trophies
 * to count as a "close" pick — see `pickBot`. Several bots can fall inside
 * this band, so the pick is randomized among them rather than always taking
 * the single nearest one.
 */
const BOT_MATCH_RANGE = 200;

@Injectable()
export class MatchmakerService {
  private readonly logger = new Logger(MatchmakerService.name);
  private queue: QueueEntry[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The seeded bot roster (`scripts/seed-bots.mjs`), queried once and kept
   * for the service's lifetime — it barely ever changes, so there's nothing
   * worth re-querying per fallback.
   */
  private botRoster: Player[] | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsService,
  ) {}

  enqueue(entry: QueueEntry): void {
    this.queue = this.queue.filter((e) => e.playerId !== entry.playerId);
    this.queue.push(entry);
    this.logger.log(
      `Player ${entry.displayName} joined queue (${this.queue.length} in queue)`,
    );

    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }
  }

  dequeue(playerId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.playerId !== playerId);
    const removed = this.queue.length < before;

    if (this.queue.length === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    return removed;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  async getHistory(playerId: string, limit = 10): Promise<MatchHistoryEntry[]> {
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'COMPLETE',
        OR: [{ player1Id: playerId }, { player2Id: playerId }],
      },
      orderBy: { endedAt: 'desc' },
      take: Math.min(limit, 50),
      include: {
        player1: { select: { id: true, displayName: true } },
        player2: { select: { id: true, displayName: true } },
      },
    });

    return matches.map((match) => {
      const isPlayer1 = match.player1Id === playerId;
      const opponent = isPlayer1 ? match.player2 : match.player1;
      const ownScore = isPlayer1 ? match.player1Score : match.player2Score;
      const ownWords = isPlayer1 ? match.player1Words : match.player2Words;
      const result: MatchHistoryEntry['result'] = match.tied
        ? 'T'
        : match.winnerId === playerId
          ? 'W'
          : 'L';

      return {
        matchId: match.id,
        opponentName: opponent?.displayName ?? 'Unknown',
        result,
        score: ownScore,
        words: ownWords,
        endedAt: (match.endedAt ?? match.startedAt).toISOString(),
      };
    });
  }

  async getActiveMatch(playerId: string): Promise<ActiveMatch | null> {
    const match = await this.prisma.match.findFirst({
      where: {
        status: 'PLAYING',
        OR: [{ player1Id: playerId }, { player2Id: playerId }],
      },
      orderBy: { startedAt: 'desc' },
    });

    if (!match) return null;

    const opponentId =
      match.player1Id === playerId ? match.player2Id : match.player1Id;
    if (!opponentId) return null;

    const opponent = await this.prisma.player.findUnique({
      where: { id: opponentId },
      select: { displayName: true },
    });

    return {
      matchId: match.id,
      roomCode: match.roomCode,
      opponentName: opponent?.displayName ?? 'Unknown',
    };
  }

  private tick(): void {
    const now = Date.now();

    for (let i = 0; i < this.queue.length; i++) {
      const a = this.queue[i];
      if (!a) continue;

      const waitTime = now - a.joinedAt;
      let range = TROPHY_RANGE_INITIAL;
      if (waitTime > MATCH_ANY_AFTER_MS) {
        range = Infinity;
      } else if (waitTime > EXPAND_AFTER_MS) {
        range = TROPHY_RANGE_EXPANDED;
      }

      let bestIdx = -1;
      let bestDist = Infinity;

      for (let j = i + 1; j < this.queue.length; j++) {
        const b = this.queue[j];
        if (!b) continue;
        const dist = Math.abs(a.trophies - b.trophies);
        if (dist <= range && dist < bestDist) {
          bestDist = dist;
          bestIdx = j;
        }
      }

      if (bestIdx !== -1) {
        const b = this.queue[bestIdx];
        if (!b) continue;

        const matched = [a, b].sort((p) => p.joinedAt);
        this.queue.splice(Math.max(i, bestIdx), 1);
        this.queue.splice(Math.min(i, bestIdx), 1);
        i--;

        this.logger.log(
          `Matched: ${matched[0].displayName} vs ${matched[1].displayName}`,
        );

        this.createMatch(matched[0], matched[1]).catch((err) => {
          this.logger.error('Failed to create match', err);
        });
      } else if (waitTime > BOT_FALLBACK_MS) {
        // Nobody else in the queue this tick, and this entry has waited long
        // enough — a human opponent may simply never show up, and an
        // "expanding range" has nothing to expand into against an empty
        // queue. Fall back to a bot rather than leaving the player stuck.
        this.queue.splice(i, 1);
        i--;

        this.logger.log(
          `No human match for ${a.displayName} after ${waitTime}ms; falling back to a bot`,
        );

        this.matchWithBot(a).catch((err) => {
          this.logger.error('Failed to create bot match', err);
        });
      }
    }

    if (this.queue.length === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private async createMatch(
    player1: QueueEntry,
    player2: QueueEntry,
  ): Promise<MatchResult> {
    const roomCode = this.generateRoomCode();

    const match = await this.prisma.match.create({
      data: {
        game: 'heist',
        roomCode,
        player1Id: player1.playerId,
        player2Id: player2.playerId,
      },
    });

    // Pre-create the room so both players can join immediately
    this.rooms.createRoom(
      'heist',
      player1.playerId,
      player1.displayName,
      `match:${player1.playerId}`,
      roomCode,
    );
    this.rooms.joinRoom(
      roomCode,
      player2.playerId,
      player2.displayName,
      `match:${player2.playerId}`,
    );

    const [p1, p2] = await Promise.all([
      this.prisma.player.findUnique({ where: { id: player1.playerId } }),
      this.prisma.player.findUnique({ where: { id: player2.playerId } }),
    ]);

    return { match, roomCode, player1: p1!, player2: p2! };
  }

  // ── Bot fallback ──────────────────────────────────────────────────────────

  private async matchWithBot(human: QueueEntry): Promise<void> {
    const bot = await this.pickBot(human.trophies);
    if (!bot) {
      // No bot roster seeded (see scripts/seed-bots.mjs) — put the player
      // back in queue with a fresh wait rather than dropping them, so a
      // misconfigured environment degrades to "waits longer" instead of
      // silently losing their spot.
      this.logger.error('Bot fallback triggered but no bot roster is seeded');
      this.queue.push({ ...human, joinedAt: Date.now() });
      if (!this.tickTimer) {
        this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
      }
      return;
    }

    this.logger.log(`Bot fallback: ${human.displayName} vs ${bot.displayName}`);
    await this.createBotMatch(human, bot);
  }

  /** Queried once and cached — the roster barely ever changes. */
  private async getBotRoster(): Promise<Player[]> {
    if (this.botRoster) return this.botRoster;
    this.botRoster = await this.prisma.player.findMany({
      where: { isBot: true },
    });
    return this.botRoster;
  }

  /**
   * Picks a bot persona near the human's trophies, randomized among the
   * close ones so a given trophy band doesn't always draw the same bot.
   * Falls back to the single globally-nearest bot when nothing is close.
   */
  private async pickBot(humanTrophies: number): Promise<Player | null> {
    const roster = await this.getBotRoster();
    if (roster.length === 0) return null;

    const close = roster.filter(
      (b) => Math.abs(b.trophies - humanTrophies) <= BOT_MATCH_RANGE,
    );
    if (close.length > 0) {
      return close[Math.floor(Math.random() * close.length)];
    }

    return roster.reduce((nearest, b) =>
      Math.abs(b.trophies - humanTrophies) <
      Math.abs(nearest.trophies - humanTrophies)
        ? b
        : nearest,
    );
  }

  /**
   * Same shape as `createMatch` — a `Match` row plus a pre-created room — but
   * the second seat is joined in directly as the bot rather than waiting for
   * a socket. `RoomsService`'s socket index is keyed by socket id, so the bot
   * gets a stable synthetic one instead of a real connection.
   *
   * The human's live trophies are stashed on their in-memory `Player` (via
   * `createRoom`'s `trophies` param) so `HeistGateway` can tune the bot's
   * difficulty to them once the round starts — see `Player.trophies` in
   * `room.types.ts`.
   */
  private async createBotMatch(
    human: QueueEntry,
    bot: Player,
  ): Promise<MatchResult> {
    const roomCode = this.generateRoomCode();

    const match = await this.prisma.match.create({
      data: {
        game: 'heist',
        roomCode,
        player1Id: human.playerId,
        player2Id: bot.id,
      },
    });

    this.rooms.createRoom(
      'heist',
      human.playerId,
      human.displayName,
      `match:${human.playerId}`,
      roomCode,
      DEFAULT_ROOM_MODE,
      false,
      human.trophies,
    );
    this.rooms.joinRoom(
      roomCode,
      bot.id,
      bot.displayName,
      `bot:${bot.id}:${roomCode}`,
      true,
    );

    const p1 = await this.prisma.player.findUnique({
      where: { id: human.playerId },
    });

    return { match, roomCode, player1: p1!, player2: bot };
  }

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
}
