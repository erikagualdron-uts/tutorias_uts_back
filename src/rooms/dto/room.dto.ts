import { RoomStatus } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PageQuery } from '../../common/page-query.js';
import { Trim } from '../../common/trim.decorator.js';

export class LocationInputDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;
}

// Capacity is checked in the service (positive whole number) so the app gets the specific
// ROOM_CAPACITY_INVALID code instead of a generic validation error.
export class CreateRoomDto {
  @IsUUID()
  locationId!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name!: string;

  @IsNumber()
  capacity!: number;
}

export class UpdateRoomDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name?: string;

  @IsOptional()
  @IsNumber()
  capacity?: number;
}

export class ListRoomsQuery extends PageQuery {
  @IsOptional()
  @Trim()
  @IsString()
  search?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;
}
