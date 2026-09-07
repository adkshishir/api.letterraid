import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface LeaderboardEntry {
  rank: number;
  id: string;
  displayName: string;
  avatarUrl: string | null;
  trophies: number;
  level: number;
}

export interface MyRank {
  rank: number;
  trophies: number;
  totalPlayers: number;
}

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async top(limit = DEFAULT_LIMIT): Promise<LeaderboardEntry[]> {
    const players = await this.prisma.player.findMany({
      orderBy: { trophies: 'desc' },
      take: Math.min(limit, MAX_LIMIT),
      select: { id: true, displayName: true, avatarUrl: true, trophies: true, level: true },
    });

    return players.map((player, index) => ({ rank: index + 1, ...player }));
  }

  async myRank(playerId: string): Promise<MyRank | null> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { trophies: true },
    });
    if (!player) return null;

    const [ahead, totalPlayers] = await Promise.all([
      this.prisma.player.count({ where: { trophies: { gt: player.trophies } } }),
      this.prisma.player.count(),
    ]);

    return { rank: ahead + 1, trophies: player.trophies, totalPlayers };
  }
}
