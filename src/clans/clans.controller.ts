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
import { ClansService } from './clans.service.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

interface CreateClanBody {
  name?: unknown;
}

@Controller('clans')
export class ClansController {
  constructor(private readonly clans: ClansService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.clans.list(parsed && Number.isFinite(parsed) ? parsed : undefined);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  mine(@Req() req: { player: { id: string } }) {
    return this.clans.getForPlayer(req.player.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: { player?: { id: string } }) {
    return this.clans.getDetail(id, req.player?.id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(
    @Req() req: { player: { id: string } },
    @Body() body: CreateClanBody,
  ) {
    return this.clans.create(req.player.id, asString(body?.name));
  }

  @Post(':id/join')
  @UseGuards(JwtAuthGuard)
  join(@Param('id') id: string, @Req() req: { player: { id: string } }) {
    return this.clans.join(id, req.player.id);
  }

  @Post('leave')
  @UseGuards(JwtAuthGuard)
  async leave(@Req() req: { player: { id: string } }) {
    await this.clans.leave(req.player.id);
    return { left: true };
  }

  @Delete(':id/members/:playerId')
  @UseGuards(JwtAuthGuard)
  async kick(
    @Param('id') id: string,
    @Param('playerId') playerId: string,
    @Req() req: { player: { id: string } },
  ) {
    await this.clans.kick(id, req.player.id, playerId);
    return { removed: true };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
