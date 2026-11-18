import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from '../../common/trim.decorator.js';

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export class HolidayDto {
  @Matches(DAY_FORMAT)
  date!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

export class YearQuery {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}

export class ImportHolidaysDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsArray()
  @ArrayMinSize(1)
  @Matches(DAY_FORMAT, { each: true })
  dates!: string[];
}
