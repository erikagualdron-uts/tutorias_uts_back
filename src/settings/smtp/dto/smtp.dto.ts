import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Trim } from '../../../common/trim.decorator.js';

// Everything is required when the settings are created; on an edit an empty or missing password
// keeps the stored one (FR-027). The service answers SMTP_PASSWORD_REQUIRED when there is none yet.
export class SaveSmtpDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  user!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  password?: string;

  @Trim()
  @IsEmail()
  @MaxLength(255)
  from!: string;
}
