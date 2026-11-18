import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PeriodStatus } from '@prisma/client';
import { Trim } from '../../common/trim.decorator.js';

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export class CreatePeriodDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  @Matches(DAY_FORMAT)
  startsOn!: string;

  @Matches(DAY_FORMAT)
  endsOn!: string;
}

export class UpdatePeriodDto {
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @Matches(DAY_FORMAT)
  startsOn?: string;

  @IsOptional()
  @Matches(DAY_FORMAT)
  endsOn?: string;
}

export class ActivatePeriodDto {
  @IsOptional()
  @IsBoolean()
  confirmCloseActive?: boolean;
}

export class ListPeriodsQuery {
  @IsOptional()
  @IsEnum(PeriodStatus)
  status?: PeriodStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

