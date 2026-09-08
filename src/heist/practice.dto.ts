import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { BOT_TIERS } from './heist-bot.service.js';
import type { BotTier } from './heist-bot.service.js';

export class StartPracticeDto {
  @ApiProperty({
    enum: BOT_TIERS,
    description: 'Bot difficulty, chosen explicitly rather than derived from trophies.',
  })
  @IsIn(BOT_TIERS)
  tier!: BotTier;
}
