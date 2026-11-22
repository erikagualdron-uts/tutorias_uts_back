import type { MessageKind } from '@prisma/client';
import { io, type Socket } from 'socket.io-client';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { TestContext } from './test-app.js';

export const directKeyOf = (a: string, b: string) => [a, b].sort().join(':');

// A direct conversation between two users, with both members, as the service creates it.
export async function createDirectConversation(prisma: PrismaService, { a, b }: { a: string; b: string }) {
  return prisma.conversation.create({
    data: {
      type: 'DIRECT',
      directKey: directKeyOf(a, b),
      members: { create: [{ userId: a }, { userId: b }] },
    },
  });
}

export const createModuleConversation = (prisma: PrismaService, { moduleId }: { moduleId: string }) =>
  prisma.conversation.create({ data: { type: 'MODULE', moduleId } });

// A message inserted directly, with `lastMessageAt` kept up to date like the service does.
export async function createChatMessage(
  prisma: PrismaService,
  overrides: { conversationId: string; senderId: string; body?: string; kind?: MessageKind; createdAt?: Date; deletedAt?: Date | null },
) {
  const createdAt = overrides.createdAt ?? new Date();
  const message = await prisma.message.create({
    data: {
      conversationId: overrides.conversationId,
      senderId: overrides.senderId,
      body: overrides.body ?? 'Hola',
      kind: overrides.kind ?? 'TEXT',
      clientMessageId: crypto.randomUUID(),
      createdAt,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
  await prisma.conversation.update({ where: { id: overrides.conversationId }, data: { lastMessageAt: createdAt } });
  return message;
}

export interface ChatClient {
  socket: Socket;
  connected: boolean;
  // The error of a rejected connection, with the stable code in `data.code`.
  error?: Error & { data?: { code?: string } };
  events: { name: string; payload: unknown }[];
  waitFor: <T = unknown>(name: string, ms?: number) => Promise<T>;
  emitWithAck: <T = unknown>(name: string, payload: object) => Promise<T>;
  close: () => void;
}

const opened: ChatClient[] = [];
export const closeAllChatClients = () => opened.splice(0).forEach((client) => client.close());

// Connects to the `/chat` namespace. The app has to listen on a real port for this, so the first call
// makes it listen on a free one. A rejected connection resolves with `connected: false` and `error`.
export async function connectChat(ctx: TestContext, token: string): Promise<ChatClient> {
  const server = ctx.app.getHttpServer();
  if (!server.listening) await ctx.app.listen(0);
  const { port } = server.address() as { port: number };
  const socket = io(`http://127.0.0.1:${port}/chat`, { auth: { token }, transports: ['websocket'], reconnection: false });
  const events: ChatClient['events'] = [];
  socket.onAny((name: string, payload: unknown) => events.push({ name, payload }));
  const client: ChatClient = {
    socket,
    connected: false,
    events,
    close: () => void socket.close(),
    emitWithAck: <T>(name: string, payload: object) => socket.timeout(3000).emitWithAck(name, payload) as Promise<T>,
    waitFor: <T>(name: string, ms = 3000) =>
      new Promise<T>((resolve, reject) => {
        const seen = events.find((e) => e.name === name);
        if (seen) return resolve(seen.payload as T);
        const timer = setTimeout(() => reject(new Error(`no ${name} event in ${ms} ms`)), ms);
        socket.once(name, (payload: T) => {
          clearTimeout(timer);
          resolve(payload);
        });
      }),
  };
  opened.push(client);
  await new Promise<void>((resolve) => {
    socket.once('connect', () => {
      client.connected = true;
      resolve();
    });
    socket.once('connect_error', (error) => {
      client.error = error as ChatClient['error'];
      resolve();
    });
  });
  return client;
}
