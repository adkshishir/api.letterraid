import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { HeistModule } from './heist/heist.module.js';
import { ModerationModule } from './moderation/moderation.module.js';
import { RoomsModule } from './rooms/rooms.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { MatchModule } from './match/match.module.js';

@Module({
  imports: [
    PrismaModule,
    ModerationModule,
    RoomsModule,
    HealthModule,
    AuthModule,
    MatchModule,
    HeistModule,
  ],
})
export class AppModule {}
