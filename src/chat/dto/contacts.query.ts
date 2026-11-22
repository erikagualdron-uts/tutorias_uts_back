import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ContactsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
