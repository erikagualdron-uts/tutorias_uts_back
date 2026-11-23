import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Roles, type AuthContext } from '../common/guards/decorators.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { ChangesQueryDto } from './dto/changes-query.dto.js';
import { PersonDashboardService } from './person-dashboard.service.js';

// Read-only summaries, one set per role (spec 019). Personal figures come from the signed-in user.
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly admin: AdminDashboardService,
    private readonly person: PersonDashboardService,
  ) {}

  @Roles('SUPERADMIN')
  @Get('admin/overview')
  overview() {
    return this.admin.overview();
  }

  @Roles('SUPERADMIN')
  @Get('admin/changes')
  changes(@Query() query: ChangesQueryDto) {
    return this.admin.changes(query.page, query.limit);
  }

  @Roles('SUPERADMIN')
  @Get('admin/rooms')
  rooms() {
    return this.admin.rooms();
  }

  @Roles('TEACHER')
  @Get('teacher')
  teacher(@CurrentAuth() { user }: AuthContext) {
    return this.person.teacher(user.id);
  }

  @Roles('STUDENT')
  @Get('student')
  student(@CurrentAuth() { user }: AuthContext) {
    return this.person.student(user.id);
  }
}
