import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '../../common/page-query.js';
import { Trim } from '../../common/trim.decorator.js';

export class CreateEnrollmentDto {
  @IsUUID()
  moduleId!: string;
}

export class OfferQueryDto extends PageQuery {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export const ENROLLMENT_FILTERS = ['ACTIVE', 'CANCELLED', 'ALL'] as const;

export class MyEnrollmentsQueryDto extends PageQuery {
  @IsOptional()
  @IsIn(ENROLLMENT_FILTERS)
  status: (typeof ENROLLMENT_FILTERS)[number] = 'ACTIVE';
}
