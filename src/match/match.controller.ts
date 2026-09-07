import {
  Controller,
  Post,
  Delete,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MatchmakerService } from './matchmaker.service.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

@Controller('match')
export class MatchController {
  constructor(private readonly matchmaker: MatchmakerService) {}

  @Post('queue')
  @UseGuards(JwtAuthGuard)
  enqueue(
    @Req()
    req: {
      player: { id: string; displayName: string; trophies: number };
    },
  ) {
    this.matchmaker.enqueue({
      playerId: req.player.id,
      displayName: req.player.displayName,
      trophies: req.player.trophies,
      joinedAt: Date.now(),
    });
    return { queued: true, queueSize: this.matchmaker.getQueueSize() };
  }

  @Delete('queue')
  @UseGuards(JwtAuthGuard)
  dequeue(@Req() req: { player: { id: string } }) {
    const removed = this.matchmaker.dequeue(req.player.id);
    return { removed, queueSize: this.matchmaker.getQueueSize() };
  }

  @Get('queue/status')
  @UseGuards(JwtAuthGuard)
  queueStatus() {
    return { queueSize: this.matchmaker.getQueueSize() };
  }

  @Get('active')
  @UseGuards(JwtAuthGuard)
  async getActiveMatch(@Req() req: { player: { id: string } }) {
    const match = await this.matchmaker.getActiveMatch(req.player.id);
    return { match };
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  async getHistory(
    @Req() req: { player: { id: string } },
    @Query('limit') limit?: string,
  ) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    const matches = await this.matchmaker.getHistory(
      req.player.id,
      parsed && Number.isFinite(parsed) ? parsed : undefined,
    );
    return { matches };
  }
}
