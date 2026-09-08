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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClansService } from './clans.service.js';
import { CreateClanDto } from './clan.dto.js';
import { ClanDetail, ClanSummary } from './clan.types.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

@ApiTags('clans')
@Controller('clans')
export class ClansController {
  constructor(private readonly clans: ClansService) {}

  @Get()
  @ApiOperation({
    summary: 'Top clans by combined member trophies',
    description: 'Public — no auth required. Browse/discovery list.',
  })
  list(@Query('limit') limit?: string): Promise<ClanSummary[]> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.clans.list(parsed && Number.isFinite(parsed) ? parsed : undefined);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'The caller’s own clan',
    description: 'Returns null (not a 404) when the caller isn’t in a clan.',
  })
  mine(@Req() req: { player: { id: string } }): Promise<ClanDetail | null> {
    return this.clans.getForPlayer(req.player.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Clan detail and roster',
    description:
      'Public — no auth required, though `myRole` in the response is only ' +
      'populated when a valid bearer token is sent.',
  })
  get(
    @Param('id') id: string,
    @Req() req: { player?: { id: string } },
  ): Promise<ClanDetail> {
    return this.clans.getDetail(id, req.player?.id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Create a clan',
    description: 'The caller becomes its leader. Fails if already in a clan.',
  })
  create(
    @Req() req: { player: { id: string } },
    @Body() body: CreateClanDto,
  ): Promise<ClanDetail> {
    return this.clans.create(req.player.id, body.name);
  }

  @Post(':id/join')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Join a clan' })
  join(
    @Param('id') id: string,
    @Req() req: { player: { id: string } },
  ): Promise<ClanDetail> {
    return this.clans.join(id, req.player.id);
  }

  @Post('leave')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Leave the caller’s clan',
    description:
      'Leadership passes to the earliest-joined remaining member; the clan ' +
      'is deleted if the caller was the only member.',
  })
  async leave(@Req() req: { player: { id: string } }): Promise<{ left: true }> {
    await this.clans.leave(req.player.id);
    return { left: true };
  }

  @Delete(':id/members/:playerId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Remove a member (leader only)' })
  async kick(
    @Param('id') id: string,
    @Param('playerId') playerId: string,
    @Req() req: { player: { id: string } },
  ): Promise<{ removed: true }> {
    await this.clans.kick(id, req.player.id, playerId);
    return { removed: true };
  }
}
