import { Module } from '@nestjs/common';
import { TournamentsController } from './tournaments.controller.js';
import { TournamentsService } from './tournaments.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [TournamentsController],
  providers: [TournamentsService],
  exports: [TournamentsService],
})
export class TournamentsModule {}
