import { IsOptional, IsUUID, Matches } from 'class-validator';
import { PageQuery } from '../../common/page-query.js';

export class TeacherModulesQueryDto extends PageQuery {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class TeacherSessionsQueryDto extends PageQuery {
  @IsOptional()
  @IsUUID()
  moduleId?: string;

  @IsOptional()
  @Matches(DAY)
  from?: string;

  @IsOptional()
  @Matches(DAY)
  to?: string;
}
