import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { HeistGateway } from './heist.gateway';
import { HeistService } from './heist.service';
import { HeistResultsService } from './heist-results.service';
import { HeistBotService } from './heist-bot.service';

@Module({
  imports: [PrismaModule],
  providers: [HeistGateway, HeistService, HeistResultsService, HeistBotService],
})
export class HeistModule {}
