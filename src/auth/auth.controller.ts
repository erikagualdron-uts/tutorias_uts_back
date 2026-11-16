import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

// Routes are added per story (register, login, refresh, recovery, change-password).
@ApiTags('auth')
@Controller('auth')
export class AuthController {}
