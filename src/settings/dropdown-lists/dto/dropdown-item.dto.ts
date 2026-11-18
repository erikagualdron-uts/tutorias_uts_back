import { ItemStatus } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Trim } from '../../../common/trim.decorator.js';

// Empty labels are rejected by the service with DROPDOWN_LABEL_REQUIRED, so the app gets a
// specific message instead of a generic validation error.
export class CreateDropdownItemDto {
  @Trim()
  @IsString()
  @MaxLength(80)
  labelEs!: string;

  @Trim()
  @IsString()
  @MaxLength(80)
  labelEn!: string;
}

export class UpdateDropdownItemDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  labelEs?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  labelEn?: string;

  @IsOptional()
  @IsEnum(ItemStatus)
  status?: ItemStatus;
}

export class ReorderDropdownItemsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  itemIds!: string[];
}
