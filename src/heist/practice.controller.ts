import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PracticeService, PracticeMatch } from './practice.service.js';
import { StartPracticeDto } from './practice.dto.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

@ApiTags('practice')
@ApiBearerAuth('bearer')
@Controller('practice')
@UseGuards(JwtAuthGuard)
export class PracticeController {
  constructor(private readonly practice: PracticeService) {}

  @Post('start')
  @ApiOperation({
    summary: 'Start a no-stakes match against a bot',
    description:
      'Seats a bot from the seeded roster at the requested difficulty and ' +
      'returns a room to join immediately — no matchmaking wait. Outside the ' +
      'ranked pipeline: trophies, XP and match history never move because of ' +
      'a practice game.',
  })
  start(
    @Req() req: { player: { id: string; displayName: string } },
    @Body() body: StartPracticeDto,
  ): Promise<PracticeMatch> {
    return this.practice.start(req.player, body.tier);
  }
}
