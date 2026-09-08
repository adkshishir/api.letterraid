import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Player } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { generateRoomCode } from '../rooms/room-code.js';
import { DEFAULT_ROOM_MODE } from '../rooms/room.types.js';
import { BotTier } from './heist-bot.service.js';

export interface PracticeMatch {
  roomCode: string;
  botName: string;
  tier: BotTier;
}

/**
 * Practice matches against a bot of an explicitly chosen tier (see
 * `BOT_TIERS` in `heist-bot.service.ts`) — a deliberate, low-stakes rematch
 * of the ranked bot-fallback flow in `MatchmakerService`, reached directly
 * rather than after a real matchmaking wait.
 *
 * Deliberately outside the ranked pipeline: a practice room is never handed
 * to `HeistResultsService` (see `HeistGateway`'s checks against
 * `isPractice`), so trophies, XP and match history never move because of
 * one — the whole point is a no-stakes way to warm up or try a harder bot
 * without risking rank.
 */
@Injectable()
export class PracticeService {
  /** roomCode -> the tier its bot is playing at. Doubles as "is this room a practice room". */
  private readonly tiers = new Map<string, BotTier>();
  private botRoster: Player[] | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsService,
  ) {}

  async start(
    human: { id: string; displayName: string },
    tier: BotTier,
  ): Promise<PracticeMatch> {
    const bot = await this.pickBot();
    if (!bot) {
      throw new ServiceUnavailableException(
        'No practice bots are set up yet — try a moment later.',
      );
    }

    const roomCode = generateRoomCode(
      (candidate) => this.rooms.getRoom(candidate) !== null,
    );

    this.rooms.createRoom(
      'heist',
      human.id,
      human.displayName,
      `practice:${human.id}`,
      roomCode,
      DEFAULT_ROOM_MODE,
    );
    this.rooms.joinRoom(
      roomCode,
      bot.id,
      bot.displayName,
      `bot:${bot.id}:${roomCode}`,
      true,
    );

    this.tiers.set(roomCode, tier);

    return { roomCode, botName: bot.displayName, tier };
  }

  tierFor(roomCode: string): BotTier | null {
    return this.tiers.get(roomCode) ?? null;
  }

  isPractice(roomCode: string): boolean {
    return this.tiers.has(roomCode);
  }

  /** Called once the room is fully torn down (deliberate leave, not a rematch). */
  clear(roomCode: string): void {
    this.tiers.delete(roomCode);
  }

  /** Queried once and cached — the roster barely ever changes. */
  private async pickBot(): Promise<Player | null> {
    if (!this.botRoster) {
      this.botRoster = await this.prisma.player.findMany({
        where: { isBot: true },
      });
    }
    if (this.botRoster.length === 0) return null;
    return this.botRoster[Math.floor(Math.random() * this.botRoster.length)];
  }
}
