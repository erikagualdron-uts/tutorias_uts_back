import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { SessionService } from '../auth/session.service.js';
import { AppException } from '../common/errors/app.exception.js';
import { ChatBroadcaster } from './chat-broadcaster.js';
import { ChatPresence } from './chat-presence.js';
import { ChatService, type Actor } from './chat.service.js';

interface Identity {
  userId?: string;
  role?: Actor['role'];
}

// The delivery side of the chat (contracts/chat-socket.md). The commands go by REST; this only
// authenticates, remembers which conversation each device has open and lets the broadcaster emit.
@WebSocketGateway({ namespace: '/chat', cors: { origin: true } })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
    private readonly chat: ChatService,
    private readonly presence: ChatPresence,
    private readonly broadcaster: ChatBroadcaster,
  ) {}

  afterInit(server: Server) {
    this.broadcaster.attach(server);
    server.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (error: unknown) => {
          const code = error instanceof AppException ? error.code : 'TOKEN_INVALID';
          next(Object.assign(new Error(code), { data: { code } }));
        },
      );
    });
  }

  handleConnection(socket: Socket) {
    const { userId } = socket.data as Identity;
    if (!userId) return;
    void socket.join(`user:${userId}`);
    this.presence.bind(socket.id, userId);
  }

  handleDisconnect(socket: Socket) {
    this.presence.drop(socket.id);
  }

  @SubscribeMessage('conversation:open')
  async open(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    const { userId, role } = socket.data as Identity;
    try {
      if (!userId || !role || !body?.conversationId) throw new Error('invalid');
      await this.chat.assertAccess({ id: userId, role }, body.conversationId);
      this.presence.open(socket.id, body.conversationId);
      return { ok: true };
    } catch {
      return { ok: false, code: 'CHAT_NOT_FOUND' };
    }
  }

  @SubscribeMessage('conversation:close')
  close(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) this.presence.close(socket.id, body.conversationId);
    return { ok: true };
  }

  // The same rule of the HTTP guard: a valid token of a live session of an account that can sign in.
  private async authenticate(socket: Socket) {
    const token = (socket.handshake.auth as { token?: string }).token;
    if (!token) throw new AppException(401, 'TOKEN_INVALID', 'Missing token');
    const payload = await this.jwt.verifyAsync<{ sub: string; sid: string }>(token).catch(() => {
      throw new AppException(401, 'TOKEN_INVALID', 'Invalid or expired token');
    });
    const session = await this.sessions.validate(payload.sid, payload.sub);
    if (session.user.mustChangePassword) throw new AppException(403, 'PASSWORD_CHANGE_REQUIRED', 'Change the temporary password first');
    socket.data = { userId: session.user.id, role: session.user.role } satisfies Identity;
  }
}
