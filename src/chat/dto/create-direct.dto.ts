import { IsUUID } from 'class-validator';

export class CreateDirectDto {
  @IsUUID()
  userId!: string;
}
