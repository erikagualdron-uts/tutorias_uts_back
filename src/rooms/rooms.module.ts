import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller.js';
import { LocationsService } from './locations.service.js';
import { RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  controllers: [LocationsController, RoomsController],
  providers: [LocationsService, RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}
