import { Body, Controller, Delete, HttpCode, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, type AuthContext } from '../common/guards/decorators.js';
import { DevicesService } from './devices.service.js';
import { RegisterDeviceDto } from './dto/notifications.dto.js';

// Any signed-in role can register its own device (FR-025); the user always comes from the token.
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Put()
  @HttpCode(204)
  register(@CurrentAuth() { user, sessionId }: AuthContext, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(user.id, sessionId, dto);
  }

  @Delete(':token')
  @HttpCode(204)
  discard(@CurrentAuth() { user }: AuthContext, @Param('token') token: string) {
    return this.devices.discard(user.id, token);
  }
}
