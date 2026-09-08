import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LeaderboardService, LeaderboardEntry, MyRank } from './leaderboard.service.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

@ApiTags('leaderboard')
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @ApiOperation({
    summary: 'Top players by trophies',
    description: 'Public — no auth required. Bots never appear here.',
  })
  top(@Query('limit') limit?: string): Promise<LeaderboardEntry[]> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.leaderboard.top(
      parsed && Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'The caller’s own rank, even if outside the top list' })
  async myRank(@Req() req: { player: { id: string } }): Promise<MyRank> {
    const rank = await this.leaderboard.myRank(req.player.id);
    if (!rank) throw new NotFoundException('Player not found');
    return rank;
  }
}
