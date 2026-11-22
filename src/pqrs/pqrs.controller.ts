import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth, Roles, type AuthContext } from '../common/guards/decorators.js';
import { CreatePqrsDto } from './dto/create-pqrs.dto.js';
import { ListMinePqrsQuery, ListPqrsQuery } from './dto/list-pqrs.query.js';
import { RespondDto } from './dto/respond.dto.js';
import { PqrsService } from './pqrs.service.js';

// Teachers and students file and read their own PQRS; only the CAE manages them (spec 017).
// The fixed paths (`limits`, `mine`) come before `:id` so they are never read as an id.
@ApiTags('pqrs')
@ApiBearerAuth()
@Controller('pqrs')
export class PqrsController {
  constructor(private readonly pqrs: PqrsService) {}

  // No @Roles: the CAE needs the reply limit and the authors need the rest.
  @Get('limits')
  limits() {
    return this.pqrs.limits();
  }

  @Roles('STUDENT', 'TEACHER')
  @Get('mine')
  listMine(@CurrentAuth() { user }: AuthContext, @Query() query: ListMinePqrsQuery) {
    return this.pqrs.listMine(user.id, query);
  }

  @Roles('STUDENT', 'TEACHER')
  @Get('mine/:id')
  getMine(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pqrs.getMine(user.id, id);
  }

  @Roles('STUDENT', 'TEACHER')
  @Post()
  async create(@CurrentAuth() { user }: AuthContext, @Body() dto: CreatePqrsDto, @Res({ passthrough: true }) res: Response) {
    const { created, pqrs } = await this.pqrs.create(user.id, dto);
    res.status(created ? 201 : 200);
    return pqrs;
  }

  @Roles('SUPERADMIN')
  @Get()
  listAll(@Query() query: ListPqrsQuery) {
    return this.pqrs.listAll(query);
  }

  @Roles('SUPERADMIN')
  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.pqrs.getOne(id);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/review')
  review(@Param('id', ParseUUIDPipe) id: string) {
    return this.pqrs.review(id);
  }

  @Roles('SUPERADMIN')
  @Post(':id/responses')
  respond(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RespondDto) {
    return this.pqrs.respond(id, user.id, dto.body);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/resolve')
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.pqrs.resolve(id);
  }
}
