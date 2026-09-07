import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
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

export interface ActiveMatch {
  matchId: string;
  roomCode: string;
  opponentName: string;
}

export interface MatchHistoryEntry {
  matchId: string;
  opponentName: string;
  result: 'W' | 'L' | 'T';
  score: number;
  words: number;
  endedAt: string;
}

const TROPHY_RANGE_INITIAL = 200;
const TROPHY_RANGE_EXPANDED = 500;
const EXPAND_AFTER_MS = 30_000;
const MATCH_ANY_AFTER_MS = 60_000;
const TICK_INTERVAL_MS = 1_000;

@Injectable()
export class MatchmakerService {
  private readonly logger = new Logger(MatchmakerService.name);
  private queue: QueueEntry[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;

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

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
}
