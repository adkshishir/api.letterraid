import { Module } from '@nestjs/common';
import { HeistGateway } from './heist.gateway';
import { HeistService } from './heist.service';

@Module({
  providers: [HeistGateway, HeistService],
})
export class HeistModule {}
