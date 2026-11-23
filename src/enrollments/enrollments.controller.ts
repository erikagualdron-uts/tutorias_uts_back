import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Roles, type AuthContext } from '../common/guards/decorators.js';
import { CreateEnrollmentDto, MyEnrollmentsQueryDto, OfferQueryDto } from './dto/enrollment.dto.js';
import { StudentCalendarQueryDto } from './dto/student-calendar-query.dto.js';
import { EnrollmentsService } from './enrollments.service.js';
import { OfferService } from './offer.service.js';
import { StudentCalendarService } from './student-calendar.service.js';

// The student is always the token's user, never a parameter: someone else's id is a 404.
@ApiTags('student')
@ApiBearerAuth()
@Roles('STUDENT')
@Controller('student')
export class EnrollmentsController {
  constructor(
    private readonly offer: OfferService,
    private readonly enrollments: EnrollmentsService,
    private readonly calendar: StudentCalendarService,
  ) {}

  // Sessions of one week (past and future, any state) for the weekly calendar (spec 021).
  @Get('calendar')
  weekly(@CurrentAuth() { user }: AuthContext, @Query() query: StudentCalendarQueryDto) {
    return this.calendar.calendar(user.id, query);
  }

  @Get('modules')
  modules(@CurrentAuth() { user }: AuthContext, @Query() query: OfferQueryDto) {
    return this.offer.list(user.id, query);
  }

  @Get('modules/:id')
  module(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.offer.detail(user.id, id);
  }

  @Post('enrollments')
  enroll(@CurrentAuth() { user }: AuthContext, @Body() dto: CreateEnrollmentDto) {
    return this.enrollments.enroll(user.id, dto.moduleId);
  }

  @Get('enrollments')
  mine(@CurrentAuth() { user }: AuthContext, @Query() query: MyEnrollmentsQueryDto) {
    return this.offer.myEnrollments(user.id, query);
  }

  @Delete('enrollments/:id')
  cancelModule(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.enrollments.cancelModule(user.id, id);
  }

  @Post('enrollments/:id/sessions/:sessionId/cancel')
  @HttpCode(200)
  cancelSession(
    @CurrentAuth() { user }: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.enrollments.cancelSession(user.id, id, sessionId);
  }

  @Post('enrollments/:id/sessions/:sessionId/restore')
  @HttpCode(200)
  restoreSession(
    @CurrentAuth() { user }: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.enrollments.restoreSession(user.id, id, sessionId);
  }
}
