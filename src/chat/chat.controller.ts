import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth, type AuthContext } from '../common/guards/decorators.js';
import { ChatService } from './chat.service.js';
import { ContactsQuery } from './dto/contacts.query.js';
import { CreateDirectDto } from './dto/create-direct.dto.js';
import { ListMessagesQuery } from './dto/list-messages.query.js';
import { SendMessageDto } from './dto/send-message.dto.js';

// No @Roles: the three roles chat. What each one may see or write is decided by the service on every call,
// and a conversation that is not mine answers 404 (spec 018).
@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('contacts')
  contacts(@CurrentAuth() { user }: AuthContext, @Query() query: ContactsQuery) {
    return this.chat.contacts(user, query.search);
  }

  @Get('conversations')
  list(@CurrentAuth() { user }: AuthContext) {
    return this.chat.listConversations(user);
  }

  @Post('conversations')
  async createDirect(@CurrentAuth() { user }: AuthContext, @Body() dto: CreateDirectDto, @Res({ passthrough: true }) res: Response) {
    const { created, conversation } = await this.chat.createDirect(user, dto.userId);
    res.status(created ? 201 : 200);
    return conversation;
  }

  @Get('conversations/:id')
  detail(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.getConversation(user, id);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ListMessagesQuery) {
    return this.chat.listMessages(user, id, query);
  }

  @Post('conversations/:id/messages')
  async send(
    @CurrentAuth() { user }: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, message } = await this.chat.sendMessage(user, id, dto);
    res.status(created ? 201 : 200);
    return message;
  }

  @HttpCode(200)
  @Post('conversations/:id/read')
  read(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.markRead(user, id);
  }

  @Get('unread-count')
  async unread(@CurrentAuth() { user }: AuthContext) {
    return { unread: await this.chat.unreadTotal(user.id) };
  }
}
