import { IsBoolean, IsIn, IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';
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

export const SCOPES = ['SESSION', 'SERIES'] as const;

// SESSION: only the chosen session. SERIES: it and the future ones of the same weekly slot.
export class ScopeDto {
  @IsIn(SCOPES)
  scope!: (typeof SCOPES)[number];
}

export class RescheduleDto extends ScopeDto {
  // New start of the chosen session; the others of the series move the same amount.
  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
