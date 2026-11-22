import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserStatus } from '@prisma/client';
import { PageQuery } from '../common/page-query.js';
import { Trim } from '../common/trim.decorator.js';

// `?search=&status=&page=&limit=` of the teacher and student account lists.
export class ListAccountsQuery extends PageQuery {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
