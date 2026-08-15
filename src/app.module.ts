import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { HeistModule } from './heist/heist.module';
import { ModerationModule } from './moderation/moderation.module';
import { RoomsModule } from './rooms/rooms.module';

@Module({
  imports: [
    // Both @Global — one room registry and one text filter shared by every game.
    ModerationModule,
    RoomsModule,
    HealthModule,
    // One module per game, each owning its own socket namespace. Heist is the
    // only one so far; the adjacent modes in docs/HEIST_IDEAS.md (Fence, Crack,
    // Turf, Cutpurse) slot in here as siblings without touching anything above.
    HeistModule,
  ],
})
export class AppModule {}
