import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../src/common/guards/decorators.js';

// Test-only routes that stand in for role-restricted endpoints.
@Controller('probe')
export class RoleProbeController {
  @Roles('SUPERADMIN')
  @Get('admin')
  admin() {
    return { ok: true };
  }

  @Get('any')
  any() {
    return { ok: true };
  }
}
