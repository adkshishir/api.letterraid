import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ModerationService } from '../moderation/moderation.service.js';
import {
  CLAN_NAME_MAX_LENGTH,
  CLAN_NAME_MIN_LENGTH,
  ClanDetail,
  ClanRosterEntry,
  ClanSummary,
  MAX_CLAN_MEMBERS,
} from './clan.types.js';

@Injectable()
export class ClansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  // ── Validation ────────────────────────────────────────────────────────────

  private validateName(raw: string): string {
    const name = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < CLAN_NAME_MIN_LENGTH || name.length > CLAN_NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `Clan names must be ${CLAN_NAME_MIN_LENGTH}-${CLAN_NAME_MAX_LENGTH} characters.`,
      );
    }
    if (this.moderation.isProfane(name)) {
      throw new ConflictException('Please choose a different name.');
    }
    return name;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async create(playerId: string, rawName: string): Promise<ClanDetail> {
    const existing = await this.prisma.clanMember.findUnique({ where: { playerId } });
    if (existing) {
      throw new ConflictException('Leave your current clan first.');
    }
    const name = this.validateName(rawName);

    let clanId: string;
    try {
      const clan = await this.prisma.clan.create({ data: { name } });
      clanId = clan.id;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException('That clan name is taken.');
      }
      throw err;
    }

    await this.prisma.clanMember.create({
      data: { clanId, playerId, role: 'LEADER' },
    });

    return this.getDetail(clanId, playerId);
  }

  async join(clanId: string, playerId: string): Promise<ClanDetail> {
    const existing = await this.prisma.clanMember.findUnique({ where: { playerId } });
    if (existing) {
      throw new ConflictException('Leave your current clan first.');
    }
    const clan = await this.prisma.clan.findUnique({ where: { id: clanId } });
    if (!clan) throw new NotFoundException('No clan with that id.');

    const count = await this.prisma.clanMember.count({ where: { clanId } });
    if (count >= MAX_CLAN_MEMBERS) {
      throw new ConflictException('This clan is full.');
    }

    await this.prisma.clanMember.create({
      data: { clanId, playerId, role: 'MEMBER' },
    });

    return this.getDetail(clanId, playerId);
  }

  /**
   * Leaves the caller's clan. If they were the leader, leadership passes to
   * whoever joined earliest; if they were the only member, the clan itself
   * is removed rather than left as an empty husk nobody can revive.
   */
  async leave(playerId: string): Promise<void> {
    const membership = await this.prisma.clanMember.findUnique({ where: { playerId } });
    if (!membership) throw new NotFoundException('You are not in a clan.');

    const { clanId, role } = membership;
    await this.prisma.clanMember.delete({ where: { playerId } });

    if (role !== 'LEADER') return;

    const successor = await this.prisma.clanMember.findFirst({
      where: { clanId },
      orderBy: { joinedAt: 'asc' },
    });

    if (successor) {
      await this.prisma.clanMember.update({
        where: { playerId: successor.playerId },
        data: { role: 'LEADER' },
      });
    } else {
      await this.prisma.clan.delete({ where: { id: clanId } });
    }
  }

  /** Leader-only removal of another member. */
  async kick(clanId: string, requesterId: string, targetPlayerId: string): Promise<void> {
    const requester = await this.prisma.clanMember.findUnique({ where: { playerId: requesterId } });
    if (!requester || requester.clanId !== clanId || requester.role !== 'LEADER') {
      throw new ForbiddenException('Only the clan leader can remove members.');
    }
    const target = await this.prisma.clanMember.findUnique({ where: { playerId: targetPlayerId } });
    if (!target || target.clanId !== clanId) {
      throw new NotFoundException('That player is not in this clan.');
    }
    if (target.role === 'LEADER') {
      throw new ForbiddenException('The leader can’t be removed — leave the clan instead.');
    }
    await this.prisma.clanMember.delete({ where: { playerId: targetPlayerId } });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getDetail(clanId: string, requesterId?: string): Promise<ClanDetail> {
    const clan = await this.prisma.clan.findUnique({
      where: { id: clanId },
      include: {
        members: {
          include: {
            player: {
              select: { id: true, displayName: true, avatarUrl: true, trophies: true },
            },
          },
        },
      },
    });
    if (!clan) throw new NotFoundException('No clan with that id.');

    const roster: ClanRosterEntry[] = clan.members
      .map((m) => ({
        playerId: m.player.id,
        displayName: m.player.displayName,
        avatarUrl: m.player.avatarUrl,
        trophies: m.player.trophies,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
      }))
      .sort((a, b) => b.trophies - a.trophies);

    const totalTrophies = roster.reduce((sum, m) => sum + m.trophies, 0);
    const mine = requesterId ? clan.members.find((m) => m.playerId === requesterId) : undefined;

    return {
      id: clan.id,
      name: clan.name,
      createdAt: clan.createdAt.toISOString(),
      memberCount: roster.length,
      totalTrophies,
      myRole: mine?.role ?? null,
      roster,
    };
  }

  /** Null if the player isn't in a clan — not an error, just an empty state on the frontend. */
  async getForPlayer(playerId: string): Promise<ClanDetail | null> {
    const membership = await this.prisma.clanMember.findUnique({ where: { playerId } });
    if (!membership) return null;
    return this.getDetail(membership.clanId, playerId);
  }

  /**
   * Top clans by combined member trophies — the closest thing to a "clan
   * leaderboard" without a whole separate ranking system. Candidate pool is
   * capped rather than aggregated in SQL: clan counts are small enough for
   * now that an in-memory sort is simpler than a raw query, and this reads
   * the same `members`/`player.trophies` data `getDetail` already does.
   */
  async list(limit = 20): Promise<ClanSummary[]> {
    const clans = await this.prisma.clan.findMany({
      include: { members: { select: { player: { select: { trophies: true } } } } },
      take: 200,
    });

    return clans
      .map((c) => ({
        id: c.id,
        name: c.name,
        memberCount: c.members.length,
        totalTrophies: c.members.reduce((sum, m) => sum + m.player.trophies, 0),
      }))
      .sort((a, b) => b.totalTrophies - a.totalTrophies)
      .slice(0, Math.min(limit, 50));
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
