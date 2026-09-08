import {
  Controller,
  Post,
  Delete,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MatchmakerService, ActiveMatch, MatchHistoryEntry } from './matchmaker.service.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

@ApiTags('match')
@ApiBearerAuth('bearer')
@Controller('match')
@UseGuards(JwtAuthGuard)
export class MatchController {
  constructor(private readonly matchmaker: MatchmakerService) {}

  @Post('queue')
  @ApiOperation({
    summary: 'Join the ranked 1v1 matchmaking queue',
    description:
      'Trophy-range matching that widens the longer the wait; falls back to ' +
      'a bot opponent after ~15s with no human match. Poll GET /match/active ' +
      'to find out when a match is ready.',
  })
  enqueue(
    @Req()
    req: {
      player: { id: string; displayName: string; trophies: number };
    },
  ): { queued: boolean; queueSize: number } {
    this.matchmaker.enqueue({
      playerId: req.player.id,
      displayName: req.player.displayName,
      trophies: req.player.trophies,
      joinedAt: Date.now(),
    });
    return { queued: true, queueSize: this.matchmaker.getQueueSize() };
  }

  @Delete('queue')
  @ApiOperation({ summary: 'Leave the ranked matchmaking queue' })
  dequeue(
    @Req() req: { player: { id: string } },
  ): { removed: boolean; queueSize: number } {
    const removed = this.matchmaker.dequeue(req.player.id);
    return { removed, queueSize: this.matchmaker.getQueueSize() };
  }

  @Get('queue/status')
  @ApiOperation({ summary: 'Current ranked queue size' })
  queueStatus(): { queueSize: number } {
    return { queueSize: this.matchmaker.getQueueSize() };
  }

  @Get('active')
  @ApiOperation({
    summary: 'The caller’s in-progress ranked match, if any',
    description:
      'Poll this after joining the queue; once matched it returns the room ' +
      'to join over the `/heist` socket namespace.',
  })
  async getActiveMatch(
    @Req() req: { player: { id: string } },
  ): Promise<{ match: ActiveMatch | null }> {
    const match = await this.matchmaker.getActiveMatch(req.player.id);
    return { match };
  }

  @Get('history')
  @ApiOperation({ summary: 'The caller’s recent ranked match results' })
  async getHistory(
    @Req() req: { player: { id: string } },
    @Query('limit') limit?: string,
  ): Promise<{ matches: MatchHistoryEntry[] }> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    const matches = await this.matchmaker.getHistory(
      req.player.id,
      parsed && Number.isFinite(parsed) ? parsed : undefined,
    );
    return { matches };
  }
}
