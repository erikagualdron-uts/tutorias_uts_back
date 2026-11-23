import { IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { Trim } from '../../common/trim.decorator.js';

// The maximum lengths live in settings (`pqrs.*MaxLength`) and are checked by the service.
export class CreatePqrsDto {
  @IsUUID()
  clientRequestId!: string;

  @IsUUID()
  typeId!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  subject!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  description!: string;
}
