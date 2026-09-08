import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  Body,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TournamentsService } from './tournaments.service.js';
import { CreateTournamentDto } from './tournament.dto.js';
import { TournamentDetail, TournamentSummary } from './tournament.types.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

type PlayerReq = { player: { id: string; displayName: string } };

@ApiTags('tournaments')
@ApiBearerAuth('bearer')
@Controller('tournaments')
@UseGuards(JwtAuthGuard)
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  // Order matters: literal-prefixed routes must come before `:idOrCode`.

  @Get('mine')
  @ApiOperation({ summary: 'Tournaments the caller is participating in' })
  mine(@Req() req: PlayerReq): Promise<TournamentSummary[]> {
    return this.tournaments.listForPlayer(req.player.id);
  }

  @Get('clan/:clanId')
  @ApiOperation({
    summary: 'A clan’s hosted tournaments',
    description: 'The caller must be a member of that clan.',
  })
  forClan(
    @Param('clanId') clanId: string,
    @Req() req: PlayerReq,
  ): Promise<TournamentSummary[]> {
    return this.tournaments.listForClan(clanId, req.player.id);
  }

  @Get()
  @ApiOperation({
    summary: 'Browse open public tournaments',
    description: 'Excludes clan-private tournaments and ones that are already full or ended.',
  })
  list(@Query('limit') limit?: string): Promise<TournamentSummary[]> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.tournaments.listOpen(parsed && Number.isFinite(parsed) ? parsed : undefined);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a tournament',
    description:
      'The caller auto-joins as the first participant. Clash-Royale style: ' +
      'a member cap and a countdown, not a bracket — see GET /tournaments/:idOrCode.',
  })
  create(@Req() req: PlayerReq, @Body() body: CreateTournamentDto): Promise<TournamentDetail> {
    return this.tournaments.create(req.player, {
      name: body.name,
      maxMembers: body.maxMembers,
      durationMin: body.durationMin,
      clanId: body.clanId ?? null,
    });
  }

  @Get(':idOrCode')
  @ApiOperation({
    summary: 'Tournament detail and standings',
    description:
      'Accepts either the tournament’s id or its short join code in the same ' +
      'param. Standings are sorted by points, then wins.',
  })
  get(
    @Param('idOrCode') idOrCode: string,
    @Req() req: PlayerReq,
  ): Promise<TournamentDetail> {
    return this.tournaments.getDetail(idOrCode, req.player.id);
  }

  @Post(':idOrCode/join')
  @ApiOperation({ summary: 'Join a tournament (by id or join code)' })
  join(
    @Param('idOrCode') idOrCode: string,
    @Req() req: PlayerReq,
  ): Promise<TournamentDetail> {
    return this.tournaments.join(idOrCode, req.player);
  }

  @Post(':idOrCode/queue')
  @ApiOperation({
    summary: 'Queue for a 1v1 match against another participant',
    description:
      'Open matchmaking: pairs with whoever else is queued in the same ' +
      'tournament, no ranking-based matching. Auto-joins the tournament first ' +
      'if the caller hasn’t already.',
  })
  enqueue(
    @Param('idOrCode') idOrCode: string,
    @Req() req: PlayerReq,
  ): Promise<{ queued: boolean; queueSize: number }> {
    return this.tournaments.enqueue(idOrCode, req.player);
  }

  @Delete(':idOrCode/queue')
  @ApiOperation({ summary: 'Cancel an in-progress matchmaking search' })
  dequeue(
    @Param('idOrCode') idOrCode: string,
    @Req() req: PlayerReq,
  ): Promise<{ removed: boolean; queueSize: number }> {
    return this.tournaments.dequeue(idOrCode, req.player.id);
  }

  @Get(':idOrCode/queue/status')
  @ApiOperation({ summary: 'Is the caller currently queued for this tournament' })
  queueStatus(
    @Param('idOrCode') idOrCode: string,
    @Req() req: PlayerReq,
  ): Promise<{ queued: boolean; queueSize: number }> {
    return this.tournaments.queueStatus(idOrCode, req.player.id);
  }

  @Get(':idOrCode/active')
  @ApiOperation({
    summary: 'The caller’s in-progress tournament match, if any',
    description:
      'Poll this after calling the queue endpoint; once matched it returns ' +
      'the room to join over the `/heist` socket namespace. Scoped to the ' +
      'caller globally, not per-tournament — a player can only have one ' +
      'active tournament match at a time.',
  })
  active(@Req() req: PlayerReq): { match: { roomCode: string; opponentName: string } | null } {
    return { match: this.tournaments.getActive(req.player.id) };
  }
}
