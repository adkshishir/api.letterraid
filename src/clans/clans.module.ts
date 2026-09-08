import { Module } from '@nestjs/common';
import { ClansController } from './clans.controller.js';
import { ClansService } from './clans.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [ClansController],
  providers: [ClansService],
  exports: [ClansService],
})
export class ClansModule {}
