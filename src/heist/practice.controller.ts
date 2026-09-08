import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { PracticeService } from './practice.service.js';
import { BOT_TIERS, BotTier } from './heist-bot.service.js';
import { JwtAuthGuard } from '../auth/auth.guard.js';

interface StartPracticeBody {
  tier?: unknown;
}

function asTier(value: unknown): BotTier | null {
  return typeof value === 'string' && (BOT_TIERS as readonly string[]).includes(value)
    ? (value as BotTier)
    : null;
}

@Controller('practice')
@UseGuards(JwtAuthGuard)
export class PracticeController {
  constructor(private readonly practice: PracticeService) {}

  @Post('start')
  start(
    @Req() req: { player: { id: string; displayName: string } },
    @Body() body: StartPracticeBody,
  ) {
    const tier = asTier(body?.tier);
    if (!tier) {
      throw new BadRequestException(`tier must be one of: ${BOT_TIERS.join(', ')}.`);
    }
    return this.practice.start(req.player, tier);
  }
}
