import { Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export class LeaderboardEntry {
  @ApiProperty() rank!: number;
  @ApiProperty() id!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty() trophies!: number;
  @ApiProperty() level!: number;
}

export class MyRank {
  @ApiProperty() rank!: number;
  @ApiProperty() trophies!: number;
  @ApiProperty() totalPlayers!: number;
}

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async top(limit = DEFAULT_LIMIT): Promise<LeaderboardEntry[]> {
    const players = await this.prisma.player.findMany({
      where: { isBot: false },
      orderBy: { trophies: 'desc' },
      take: Math.min(limit, MAX_LIMIT),
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        trophies: true,
        level: true,
      },
    });

    return players.map((player, index) => ({ rank: index + 1, ...player }));
  }

  async myRank(playerId: string): Promise<MyRank | null> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { trophies: true },
    });
    if (!player) return null;

    // Bots are real Player rows (see prisma/schema.prisma) so they never show
    // up here or skew totalPlayers — the public leaderboard is a ranking of
    // real players, and a matchmaker fallback opponent isn't one.
    const [ahead, totalPlayers] = await Promise.all([
      this.prisma.player.count({
        where: { trophies: { gt: player.trophies }, isBot: false },
      }),
      this.prisma.player.count({ where: { isBot: false } }),
    ]);

    return { rank: ahead + 1, trophies: player.trophies, totalPlayers };
  }
}
