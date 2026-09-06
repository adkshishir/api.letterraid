import { Module } from '@nestjs/common';
import { MatchController } from './match.controller.js';
import { MatchmakerService } from './matchmaker.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [MatchController],
  providers: [MatchmakerService],
  exports: [MatchmakerService],
})
export class MatchModule {}
