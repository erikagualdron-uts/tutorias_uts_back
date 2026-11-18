import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserStatus } from '@prisma/client';
import { PageQuery } from '../../common/page-query.js';
import { Trim } from '../../common/trim.decorator.js';

// `GET /teachers?search=&status=&page=&limit=` (spec 010: the module form picks a teacher).
export class ListTeachersQuery extends PageQuery {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
