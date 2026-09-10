import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TournamentsModule } from '../tournaments/tournaments.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { HeistGateway } from './heist.gateway';
import { HeistService } from './heist.service';
import { HeistResultsService } from './heist-results.service';
import { HeistBotService } from './heist-bot.service';
import { BotDifficultyService } from './bot-difficulty.service';
import { PracticeService } from './practice.service';
import { PracticeController } from './practice.controller';

@Module({
  imports: [PrismaModule, TournamentsModule, AuthModule],
  controllers: [PracticeController],
  providers: [
    HeistGateway,
    HeistService,
    HeistResultsService,
    HeistBotService,
    BotDifficultyService,
    PracticeService,
  ],
})
export class HeistModule {}
