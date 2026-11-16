import { Trim } from '../../common/trim.decorator.js';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class RegisterDto {
  @Trim()
  @IsEmail()
  email!: string;

  // The strength policy lives in settings and is checked by the service (PASSWORD_TOO_WEAK).
  @IsString()
  @MaxLength(128)
  password!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @IsIn(['es', 'en'])
  locale!: 'es' | 'en';
}

export class EmailDto {
  @Trim()
  @IsEmail()
  email!: string;
}

export class VerifyEmailDto extends EmailDto {
  @Matches(/^[0-9]{6}$/)
  code!: string;
}

export class ResetPasswordDto extends VerifyEmailDto {
  @IsString()
  @MaxLength(128)
  newPassword!: string;
}
