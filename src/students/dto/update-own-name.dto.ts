import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../common/trim.decorator.js';

export class UpdateOwnNameDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;
}
