import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../common/trim.decorator.js';

// `PATCH /teachers/:id` (spec 016). The email is not editable: the global pipe rejects any other field.
export class UpdateTeacherDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName!: string;

  // `null` clears the phone; leaving it out keeps it.
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(30)
  phone?: string | null;
}
