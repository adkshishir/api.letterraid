import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { generateRoomCode } from '../rooms/room-code.js';
import { DEFAULT_ROOM_MODE } from '../rooms/room.types.js';
import type { HeistResult } from '../heist/heist.types.js';
import {
  TOURNAMENT_DURATIONS_MIN,
  TOURNAMENT_NAME_MAX_LENGTH,
  TOURNAMENT_SIZES,
  TournamentDetail,
  TournamentDurationMin,
  TournamentSize,
  TournamentStanding,
  TournamentSummary,
  deriveStatus,
} from './tournament.types.js';

interface CreateTournamentInput {
  name: string;
  maxMembers: number;
  durationMin: number;
  clanId?: string | null;
}

interface QueueEntry {
  playerId: string;
  displayName: string;
  joinedAt: number;
}

interface ActiveEntry {
  tournamentId: string;
  roomCode: string;
  opponentId: string;
  opponentName: string;
}

const TOURNAMENT_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TICK_INTERVAL_MS = 1_000;

/**
 * Open-matchmaking tournaments — Clash Royale's model, not a bracket. A fixed
 * member cap and countdown; anyone in it can queue for a 1v1 Heist match
 * against another participant at any point before time runs out, and
 * standings rank by league-style points, never elimination.
 *
 * Deliberately decoupled from `HeistResultsService`: a tournament match is a
 * completely ordinary two-real-player Heist room from the ranked pipeline's
 * point of view (trophies/XP update exactly like any other match, the same
 * way a private "play with friends" room already does today) — this service
 * only layers `TournamentParticipant` standings on top via `recordResult`,
 * which `HeistGateway` calls for every room regardless of how it started and
 * which is a no-op for the vast majority that aren't tournament rooms.
 */
@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  private readonly queues = new Map<string, QueueEntry[]>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /** roomCode -> the tournament match it was seated for. */
  private readonly rooms = new Map<
    string,
    { tournamentId: string; player1Id: string; player2Id: string }
  >();
  /** playerId -> their current in-flight tournament match, if any. */
  private readonly activeByPlayer = new Map<string, ActiveEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly roomsService: RoomsService,
  ) {}

  // ── Validation ────────────────────────────────────────────────────────────

  private validateCreateInput(input: CreateTournamentInput): {
    name: string;
    maxMembers: TournamentSize;
    durationMin: TournamentDurationMin;
  } {
    const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > TOURNAMENT_NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `Please enter a name up to ${TOURNAMENT_NAME_MAX_LENGTH} characters.`,
      );
    }
    if (!TOURNAMENT_SIZES.includes(input.maxMembers as TournamentSize)) {
      throw new BadRequestException(
        `Size must be one of: ${TOURNAMENT_SIZES.join(', ')}.`,
      );
    }
    if (!TOURNAMENT_DURATIONS_MIN.includes(input.durationMin as TournamentDurationMin)) {
      throw new BadRequestException(
        `Duration must be one of: ${TOURNAMENT_DURATIONS_MIN.join(', ')} minutes.`,
      );
    }
    return {
      name,
      maxMembers: input.maxMembers as TournamentSize,
      durationMin: input.durationMin as TournamentDurationMin,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async create(
    creator: { id: string; displayName: string },
    input: CreateTournamentInput,
  ): Promise<TournamentDetail> {
    const { name, maxMembers, durationMin } = this.validateCreateInput(input);

    if (input.clanId) {
      await this.requireClanMember(input.clanId, creator.id);
    }

    const code = await this.generateCode();

    const tournament = await this.prisma.tournament.create({
      data: {
        code,
        name,
        maxMembers,
        durationMin,
        // Lobby until the host explicitly starts it — see `start()`.
        startedAt: null,
        endsAt: null,
        creatorId: creator.id,
        clanId: input.clanId ?? null,
      },
    });

    await this.prisma.tournamentParticipant.create({
      data: { tournamentId: tournament.id, playerId: creator.id },
    });

    return this.getDetail(tournament.id, creator.id);
  }

  async join(idOrCode: string, player: { id: string }): Promise<TournamentDetail> {
    const tournament = await this.findRaw(idOrCode);
    if (!tournament) throw new NotFoundException('No tournament with that code.');
    if (deriveStatus(tournament.startedAt, tournament.endsAt) === 'COMPLETE') {
      throw new ConflictException('This tournament has already ended.');
    }
    if (tournament.clanId) {
      await this.requireClanMember(tournament.clanId, player.id);
    }

    const existing = await this.prisma.tournamentParticipant.findUnique({
      where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: player.id } },
    });
    if (!existing) {
      const count = await this.prisma.tournamentParticipant.count({
        where: { tournamentId: tournament.id },
      });
      if (count >= tournament.maxMembers) {
        throw new ConflictException('This tournament is full.');
      }
      await this.prisma.tournamentParticipant.create({
        data: { tournamentId: tournament.id, playerId: player.id },
      });
    }

    return this.getDetail(tournament.id, player.id);
  }

  /**
   * Host-only: moves the tournament out of the lobby and starts the
   * duration countdown from now. Requires at least 2 joined participants —
   * matchmaking needs a pair.
   */
  async start(idOrCode: string, requesterId: string): Promise<TournamentDetail> {
    const tournament = await this.findRaw(idOrCode);
    if (!tournament) throw new NotFoundException('No tournament with that code.');
    if (tournament.creatorId !== requesterId) {
      throw new ForbiddenException('Only the host can start this tournament.');
    }
    if (tournament.startedAt) {
      throw new ConflictException('This tournament has already started.');
    }

    const count = await this.prisma.tournamentParticipant.count({
      where: { tournamentId: tournament.id },
    });
    if (count < 2) {
      throw new BadRequestException('Need at least 2 players joined to start.');
    }

    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + tournament.durationMin * 60_000);
    await this.prisma.tournament.update({
      where: { id: tournament.id },
      data: { startedAt, endsAt },
    });

    return this.getDetail(tournament.id, requesterId);
  }

  private async requireClanMember(clanId: string, playerId: string): Promise<void> {
    const membership = await this.prisma.clanMember.findUnique({ where: { playerId } });
    if (!membership || membership.clanId !== clanId) {
      throw new ForbiddenException('This tournament is only open to clan members.');
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private async findRaw(idOrCode: string) {
    return this.prisma.tournament.findFirst({
      where: { OR: [{ id: idOrCode }, { code: idOrCode.toUpperCase() }] },
    });
  }

  async getDetail(idOrCode: string, requesterId?: string): Promise<TournamentDetail> {
    const tournament = await this.prisma.tournament.findFirst({
      where: { OR: [{ id: idOrCode }, { code: idOrCode.toUpperCase() }] },
      include: {
        clan: { select: { name: true } },
        participants: {
          include: { player: { select: { id: true, displayName: true } } },
        },
      },
    });
    if (!tournament) throw new NotFoundException('No tournament with that code.');

    const standings: TournamentStanding[] = tournament.participants
      .map((p) => ({
        playerId: p.player.id,
        displayName: p.player.displayName,
        wins: p.wins,
        losses: p.losses,
        points: p.points,
      }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins);

    return {
      id: tournament.id,
      code: tournament.code,
      name: tournament.name,
      maxMembers: tournament.maxMembers,
      durationMin: tournament.durationMin,
      memberCount: tournament.participants.length,
      startedAt: tournament.startedAt?.toISOString() ?? null,
      endsAt: tournament.endsAt?.toISOString() ?? null,
      status: deriveStatus(tournament.startedAt, tournament.endsAt),
      clanId: tournament.clanId,
      createdAt: tournament.createdAt.toISOString(),
      creatorId: tournament.creatorId,
      clanName: tournament.clan?.name ?? null,
      isParticipant: requesterId
        ? tournament.participants.some((p) => p.playerId === requesterId)
        : false,
      standings,
    };
  }

  /** Open, public (non-clan) tournaments still worth browsing into. */
  async listOpen(limit = 20): Promise<TournamentSummary[]> {
    const candidates = await this.prisma.tournament.findMany({
      where: {
        clanId: null,
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { _count: { select: { participants: true } } },
    });

    return candidates
      .filter((t) => t._count.participants < t.maxMembers)
      .slice(0, Math.min(limit, 50))
      .map((t) => this.toSummary(t, t._count.participants));
  }

  async listForPlayer(playerId: string): Promise<TournamentSummary[]> {
    const tournaments = await this.prisma.tournament.findMany({
      where: { participants: { some: { playerId } } },
      orderBy: { endsAt: 'desc' },
      include: { _count: { select: { participants: true } } },
    });
    return tournaments.map((t) => this.toSummary(t, t._count.participants));
  }

  async listForClan(clanId: string, requesterId: string): Promise<TournamentSummary[]> {
    await this.requireClanMember(clanId, requesterId);
    const tournaments = await this.prisma.tournament.findMany({
      where: { clanId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { participants: true } } },
    });
    return tournaments.map((t) => this.toSummary(t, t._count.participants));
  }

  private toSummary(
    t: {
      id: string;
      code: string;
      name: string;
      maxMembers: number;
      durationMin: number;
      startedAt: Date | null;
      endsAt: Date | null;
      clanId: string | null;
    },
    memberCount: number,
  ): TournamentSummary {
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      maxMembers: t.maxMembers,
      durationMin: t.durationMin,
      memberCount,
      startedAt: t.startedAt?.toISOString() ?? null,
      endsAt: t.endsAt?.toISOString() ?? null,
      status: deriveStatus(t.startedAt, t.endsAt),
      clanId: t.clanId,
    };
  }

  // ── Matchmaking ───────────────────────────────────────────────────────────

  async enqueue(idOrCode: string, player: { id: string; displayName: string }): Promise<{ queued: boolean; queueSize: number }> {
    const tournament = await this.findRaw(idOrCode);
    if (!tournament) throw new NotFoundException('No tournament with that code.');
    const status = deriveStatus(tournament.startedAt, tournament.endsAt);
    if (status === 'LOBBY') {
      throw new ConflictException('The host hasn’t started this tournament yet.');
    }
    if (status === 'COMPLETE') {
      throw new ConflictException('This tournament has already ended.');
    }
    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: player.id } },
    });
    if (!participant) throw new ForbiddenException('Join this tournament first.');

    if (this.activeByPlayer.has(player.id)) {
      // Already mid-match — nothing to queue.
      return { queued: false, queueSize: this.queueSize(tournament.id) };
    }

    const queue = this.queues.get(tournament.id) ?? [];
    const next = queue.filter((e) => e.playerId !== player.id);
    next.push({ playerId: player.id, displayName: player.displayName, joinedAt: Date.now() });
    this.queues.set(tournament.id, next);
    this.ensureTick();

    return { queued: true, queueSize: next.length };
  }

  async dequeue(idOrCode: string, playerId: string): Promise<{ removed: boolean; queueSize: number }> {
    const tournament = await this.findRaw(idOrCode);
    if (!tournament) throw new NotFoundException('No tournament with that code.');

    const queue = this.queues.get(tournament.id);
    if (!queue) return { removed: false, queueSize: 0 };
    const next = queue.filter((e) => e.playerId !== playerId);
    this.queues.set(tournament.id, next);
    return { removed: next.length !== queue.length, queueSize: next.length };
  }

  async queueStatus(idOrCode: string, playerId: string): Promise<{ queued: boolean; queueSize: number }> {
    const tournament = await this.findRaw(idOrCode);
    if (!tournament) throw new NotFoundException('No tournament with that code.');

    const queue = this.queues.get(tournament.id) ?? [];
    return { queued: queue.some((e) => e.playerId === playerId), queueSize: queue.length };
  }

  getActive(playerId: string): { roomCode: string; opponentName: string } | null {
    const entry = this.activeByPlayer.get(playerId);
    if (!entry) return null;
    return { roomCode: entry.roomCode, opponentName: entry.opponentName };
  }

  private queueSize(tournamentId: string): number {
    return this.queues.get(tournamentId)?.length ?? 0;
  }

  private ensureTick(): void {
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }
  }

  private tick(): void {
    let anyoneWaiting = false;

    for (const [tournamentId, entries] of this.queues) {
      while (entries.length >= 2) {
        const a = entries.shift();
        const b = entries.shift();
        if (!a || !b) break;
        this.createMatch(tournamentId, a, b).catch((err) => {
          this.logger.error('Failed to create tournament match', err);
        });
      }
      if (entries.length > 0) anyoneWaiting = true;
    }

    if (!anyoneWaiting && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private async createMatch(tournamentId: string, a: QueueEntry, b: QueueEntry): Promise<void> {
    const roomCode = generateRoomCode(
      (candidate) => this.roomsService.getRoom(candidate) !== null,
    );

    this.roomsService.createRoom(
      'heist',
      a.playerId,
      a.displayName,
      `tournament:${a.playerId}`,
      roomCode,
      DEFAULT_ROOM_MODE,
    );
    this.roomsService.joinRoom(roomCode, b.playerId, b.displayName, `tournament:${b.playerId}`);

    this.rooms.set(roomCode, { tournamentId, player1Id: a.playerId, player2Id: b.playerId });
    this.activeByPlayer.set(a.playerId, {
      tournamentId,
      roomCode,
      opponentId: b.playerId,
      opponentName: b.displayName,
    });
    this.activeByPlayer.set(b.playerId, {
      tournamentId,
      roomCode,
      opponentId: a.playerId,
      opponentName: a.displayName,
    });

    this.logger.log(`Tournament ${tournamentId}: matched ${a.displayName} vs ${b.displayName}`);
  }

  // ── Completion hook ──────────────────────────────────────────────────────

  /**
   * Called by `HeistGateway` for every room's round completion, tournament or
   * not — a no-op unless `roomCode` is one this service seated. Updates
   * league-style standings only; trophies/XP for the underlying match are
   * already handled independently by `HeistResultsService`.
   */
  recordResult(roomCode: string, result: HeistResult): void {
    const entry = this.rooms.get(roomCode);
    if (!entry) return;
    this.rooms.delete(roomCode);
    this.activeByPlayer.delete(entry.player1Id);
    this.activeByPlayer.delete(entry.player2Id);

    const outcomeFor = (playerId: string): 'W' | 'L' | 'T' => {
      if (result.tied) return 'T';
      return result.winnerId === playerId ? 'W' : 'L';
    };

    this.applyOutcome(entry.tournamentId, entry.player1Id, outcomeFor(entry.player1Id)).catch(
      (err) => this.logger.error('Failed to record tournament result', err),
    );
    this.applyOutcome(entry.tournamentId, entry.player2Id, outcomeFor(entry.player2Id)).catch(
      (err) => this.logger.error('Failed to record tournament result', err),
    );
  }

  private async applyOutcome(
    tournamentId: string,
    playerId: string,
    outcome: 'W' | 'L' | 'T',
  ): Promise<void> {
    const points = outcome === 'W' ? 3 : outcome === 'T' ? 1 : 0;
    await this.prisma.tournamentParticipant.update({
      where: { tournamentId_playerId: { tournamentId, playerId } },
      data: {
        wins: outcome === 'W' ? { increment: 1 } : undefined,
        losses: outcome === 'L' ? { increment: 1 } : undefined,
        points: { increment: points },
      },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async generateCode(): Promise<string> {
    let code: string;
    let attempts = 0;
    do {
      code = Array.from(
        { length: 5 },
        () => TOURNAMENT_CODE_CHARSET[Math.floor(Math.random() * TOURNAMENT_CODE_CHARSET.length)],
      ).join('');
      attempts += 1;
    } while (attempts < 10 && (await this.prisma.tournament.findUnique({ where: { code } })));
    return code;
  }
}
