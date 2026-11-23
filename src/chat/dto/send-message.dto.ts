import { MessageKind } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { Trim } from '../../common/trim.decorator.js';

// The maximum length lives in settings (`chat.messageMaxLength`) and is checked by the service.
export class SendMessageDto {
  @IsUUID()
  clientMessageId!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  body!: string;

  @IsOptional()
  @IsEnum(MessageKind)
  kind?: MessageKind;
}
