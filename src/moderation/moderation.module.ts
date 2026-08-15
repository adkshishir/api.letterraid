import { Global, Module } from '@nestjs/common';
import { ModerationService } from './moderation.service';

/**
 * Global so both game modules can inject the filter without each re-importing
 * it — building the matcher is non-trivial work we only want done once.
 */
@Global()
@Module({
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
