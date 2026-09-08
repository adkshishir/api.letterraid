import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TournamentsService } from './tournaments.service.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

interface CreateTournamentBody {
  name?: unknown;
  maxMembers?: unknown;
  durationMin?: unknown;
  clanId?: unknown;
}

type PlayerReq = { player: { id: string; displayName: string } };

@Controller('tournaments')
@UseGuards(JwtAuthGuard)
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  // Order matters: literal-prefixed routes must come before `:idOrCode`.

  @Get('mine')
  mine(@Req() req: PlayerReq) {
    return this.tournaments.listForPlayer(req.player.id);
  }

  @Get('clan/:clanId')
  forClan(@Param('clanId') clanId: string, @Req() req: PlayerReq) {
    return this.tournaments.listForClan(clanId, req.player.id);
  }

  @Get()
  list(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.tournaments.listOpen(parsed && Number.isFinite(parsed) ? parsed : undefined);
  }

  @Post()
  create(@Req() req: PlayerReq, @Body() body: CreateTournamentBody) {
    return this.tournaments.create(req.player, {
      name: asString(body?.name),
      maxMembers: asNumber(body?.maxMembers),
      durationMin: asNumber(body?.durationMin),
      clanId: typeof body?.clanId === 'string' ? body.clanId : null,
    });
  }

  @Get(':idOrCode')
  get(@Param('idOrCode') idOrCode: string, @Req() req: PlayerReq) {
    return this.tournaments.getDetail(idOrCode, req.player.id);
  }

  @Post(':idOrCode/join')
  join(@Param('idOrCode') idOrCode: string, @Req() req: PlayerReq) {
    return this.tournaments.join(idOrCode, req.player);
  }

  @Post(':idOrCode/queue')
  enqueue(@Param('idOrCode') idOrCode: string, @Req() req: PlayerReq) {
    return this.tournaments.enqueue(idOrCode, req.player);
  }

  @Delete(':idOrCode/queue')
  dequeue(@Param('idOrCode') idOrCode: string, @Req() req: PlayerReq) {
    return this.tournaments.dequeue(idOrCode, req.player.id);
  }

  @Get(':idOrCode/queue/status')
  queueStatus(@Param('idOrCode') idOrCode: string, @Req() req: PlayerReq) {
    return this.tournaments.queueStatus(idOrCode, req.player.id);
  }

  @Get(':idOrCode/active')
  active(@Req() req: PlayerReq) {
    return { match: this.tournaments.getActive(req.player.id) };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}
