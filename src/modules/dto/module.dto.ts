import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../common/trim.decorator.js';

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

// Weekly slot in local America/Bogota time: day 1 (Monday) to 7 (Sunday) and "HH:mm" hours.
export class ScheduleDto {
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @Matches(TIME_FORMAT)
  startTime!: string;

  @Matches(TIME_FORMAT)
  endTime!: string;
}

export class CreateModuleDto {
  @IsUUID()
  periodId!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsUUID()
  teacherId!: string;

  @IsUUID()
  roomId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ScheduleDto)
  schedules!: ScheduleDto[];
}
