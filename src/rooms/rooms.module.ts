import { Global, Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

/**
 * Global so both game gateways share one room registry — room codes are unique
 * across games, which is what lets a single `/room/CODE` link resolve to the
 * right one.
 */
@Global()
@Module({
  controllers: [RoomsController],
  providers: [RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}
