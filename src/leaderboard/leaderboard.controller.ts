import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  top(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.leaderboard.top(
      parsed && Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async myRank(@Req() req: { player: { id: string } }) {
    const rank = await this.leaderboard.myRank(req.player.id);
    if (!rank) throw new NotFoundException('Player not found');
    return rank;
  }
}
