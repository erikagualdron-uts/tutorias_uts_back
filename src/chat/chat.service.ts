import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { AppException } from '../common/errors/app.exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { canPair, directDecision, moduleDecision, type ReadOnlyReason } from './chat-access.js';
import { ChatBroadcaster } from './chat-broadcaster.js';
import { ChatPushService } from './chat-push.service.js';
import { moduleParticipants, visibleTo } from './chat-visibility.js';
import { available, fold, MESSAGE_INCLUDE, messageView, PERSON, person, type PersonRow } from './chat-views.js';
import type { SendMessageDto } from './dto/send-message.dto.js';

export interface Actor {
  id: string;
  role: Role;
}

const CONVERSATION_INCLUDE = {
  members: { include: { user: { select: PERSON } } },
  module: { select: { id: true, name: true, teacherId: true, period: { select: { status: true } } } },
} satisfies Prisma.ConversationInclude;
type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof CONVERSATION_INCLUDE }>;

interface Access {
  conversation: ConversationRow;
  canWrite: boolean;
  reason: ReadOnlyReason | null;
  canAnnounce: boolean;
}

const notFound = () => new AppException(404, 'CHAT_NOT_FOUND', 'The conversation does not exist');
const notAllowed = () => new AppException(403, 'CHAT_PARTNER_NOT_ALLOWED', 'These two people cannot chat');
const invalid = (field: string, rule: string) => new AppException(400, 'VALIDATION_FAILED', 'Validation failed', { fields: { [field]: rule } });

const directKey = (a: string, b: string) => [a, b].sort().join(':');
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) throw invalid('before', 'invalid');
  return { at, id };
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly broadcaster: ChatBroadcaster,
    private readonly push: ChatPushService,
  ) {}

  // ---- who I can write to -------------------------------------------------------------------------

  async contacts(me: Actor, search?: string) {
    const found = new Map<string, { person: PersonRow; modules: Set<string> }>();
    const add = (user: PersonRow, module?: string) => {
      if (!available(user)) return;
      const entry = found.get(user.id) ?? { person: user, modules: new Set<string>() };
      if (module) entry.modules.add(module);
      found.set(user.id, entry);
    };
    const live = { deletedAt: null, period: { status: { not: 'CLOSED' as const }, deletedAt: null } };
    if (me.role === 'SUPERADMIN') {
      for (const t of await this.prisma.user.findMany({ where: { role: 'TEACHER', status: 'ACTIVE', deletedAt: null }, select: PERSON })) add(t);
    } else if (me.role === 'TEACHER') {
      const rows = await this.prisma.enrollment.findMany({
        where: { status: 'ACTIVE', deletedAt: null, module: { teacherId: me.id, ...live }, student: { emailVerifiedAt: { not: null } } },
        select: { module: { select: { name: true } }, student: { select: PERSON } },
      });
      for (const r of rows) add(r.student, r.module.name);
      for (const cae of await this.prisma.user.findMany({ where: { role: 'SUPERADMIN', status: 'ACTIVE', deletedAt: null }, select: PERSON })) add(cae);
    } else {
      const rows = await this.prisma.enrollment.findMany({
        where: { studentId: me.id, status: 'ACTIVE', deletedAt: null, module: live },
        select: { module: { select: { name: true, teacher: { select: PERSON } } } },
      });
      for (const r of rows) add(r.module.teacher, r.module.name);
    }
    const term = search ? fold(search.trim()) : '';
    return [...found.values()]
      .map(({ person: p, modules }) => ({ ...person(p), modules: [...modules].sort() }))
      .filter((c) => !term || fold(`${c.firstName} ${c.lastName}`).includes(term))
      .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
  }

  // ---- conversations ------------------------------------------------------------------------------

  async createDirect(me: Actor, userId: string) {
    const partner = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: PERSON });
    if (!partner || partner.id === me.id || !canPair(me.role, partner.role)) throw notAllowed();
    const key = directKey(me.id, partner.id);
    const existing = await this.prisma.conversation.findUnique({ where: { directKey: key }, select: { id: true } });
    if (existing) return { created: false, conversation: await this.getConversation(me, existing.id) };
    const decision = directDecision({
      meRole: me.role,
      partnerRole: partner.role,
      partnerAvailable: available(partner),
      sharedActiveModule: await this.sharedActiveModule(me, partner),
    });
    if (!decision.canWrite) throw notAllowed();
    try {
      const created = await this.prisma.conversation.create({
        data: { type: 'DIRECT', directKey: key, members: { create: [{ userId: me.id }, { userId: partner.id }] } },
        select: { id: true },
      });
      return { created: true, conversation: await this.getConversation(me, created.id) };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const winner = await this.prisma.conversation.findUniqueOrThrow({ where: { directKey: key }, select: { id: true } });
      return { created: false, conversation: await this.getConversation(me, winner.id) };
    }
  }

  async getConversation(me: Actor, id: string) {
    const access = await this.access(me, id);
    const [summary] = await this.summarize(me, [access.conversation]);
    const limits = { messageMaxLength: await this.settings.get('chat.messageMaxLength') };
    return { ...summary, canWrite: access.canWrite, readOnlyReason: access.reason, canAnnounce: access.canAnnounce, limits };
  }

  // Direct chats with at least one live message, and the chat of every module of the user (also empty).
  async listConversations(me: Actor) {
    const modules = await this.moduleIdsOf(me);
    if (modules.length > 0) {
      await this.prisma.conversation.createMany({ data: modules.map((moduleId) => ({ type: 'MODULE' as const, moduleId })), skipDuplicates: true });
    }
    const rows = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        OR: [
          { type: 'DIRECT', members: { some: { userId: me.id } }, messages: { some: { deletedAt: null } } },
          { type: 'MODULE', moduleId: { in: modules } },
        ],
      },
      include: CONVERSATION_INCLUDE,
    });
    const summaries = await this.summarize(me, rows);
    const label = (s: (typeof summaries)[number]) => s.module?.name ?? `${s.partner?.lastName} ${s.partner?.firstName}`;
    return summaries.sort((a, b) => {
      const byDate = (b.lastMessageAt?.getTime() ?? -1) - (a.lastMessageAt?.getTime() ?? -1);
      return byDate || label(a).localeCompare(label(b));
    });
  }

  // ---- messages -----------------------------------------------------------------------------------

  async listMessages(me: Actor, id: string, { before, limit }: { before?: string; limit: number }) {
    await this.access(me, id);
    const cursor = before ? decodeCursor(before) : null;
    const rows = await this.prisma.$queryRaw<{ id: string; at: string }[]>`
      SELECT m.id, m.created_at::text AS "at"
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = ${id}::uuid AND m.deleted_at IS NULL AND ${visibleTo(me.id)}
        ${cursor ? Prisma.sql`AND (m.created_at, m.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : Prisma.empty}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const messages = await this.prisma.message.findMany({ where: { id: { in: page.map((r) => r.id) } }, include: MESSAGE_INCLUDE });
    const byId = new Map(messages.map((m) => [m.id, m]));
    const last = page.at(-1);
    return {
      data: page.map((r) => messageView(byId.get(r.id)!)),
      next: rows.length > limit && last ? encodeCursor(last.at, last.id) : null,
    };
  }

  // A retry with the same `clientMessageId` returns the message already saved (`created: false`).
  async sendMessage(me: Actor, id: string, dto: SendMessageDto) {
    const access = await this.access(me, id);
    const key = { conversationId_senderId_clientMessageId: { conversationId: id, senderId: me.id, clientMessageId: dto.clientMessageId } };
    const existing = await this.prisma.message.findUnique({ where: key, include: MESSAGE_INCLUDE });
    if (existing) return { created: false, message: messageView(existing) };

    const kind = dto.kind ?? 'TEXT';
    if (!access.canWrite) throw new AppException(409, 'CHAT_READ_ONLY', 'The conversation is read-only', { reason: access.reason });
    if (kind === 'ANNOUNCEMENT' && !access.canAnnounce) {
      throw new AppException(403, 'CHAT_ANNOUNCEMENT_FORBIDDEN', 'Only the teacher of the module can announce');
    }
    if (dto.body.length > (await this.settings.get('chat.messageMaxLength'))) throw invalid('body', 'maxLength');

    let saved;
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: { conversationId: id, senderId: me.id, kind, body: dto.body, clientMessageId: dto.clientMessageId },
          include: MESSAGE_INCLUDE,
        });
        await tx.conversation.update({ where: { id }, data: { lastMessageAt: message.createdAt } });
        await tx.conversationMember.createMany({ data: [{ conversationId: id, userId: me.id }], skipDuplicates: true });
        return message;
      });
    } catch (error) {
      // Two identical sends at once: the unique index let one through; answer with that one.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      return { created: false, message: messageView(await this.prisma.message.findUniqueOrThrow({ where: key, include: MESSAGE_INCLUDE })) };
    }
    const view = messageView(saved);
    await this.deliver(me, access.conversation, view);
    return { created: true, message: view };
  }

  async markRead(me: Actor, id: string) {
    await this.access(me, id);
    const now = new Date();
    await this.prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: id, userId: me.id } },
      create: { conversationId: id, userId: me.id, lastReadAt: now },
      update: { lastReadAt: now },
    });
    const unread = await this.unreadTotal(me.id);
    this.broadcaster.unreadChanged(me.id, unread);
    return { unread };
  }

  async unreadTotal(userId: string): Promise<number> {
    let total = 0;
    for (const n of (await this.unreadMap(userId)).values()) total += n;
    return total;
  }

  // The socket opens a conversation only if it is mine.
  async assertAccess(me: Actor, id: string): Promise<void> {
    await this.access(me, id);
  }

  // Who should hear that `me` is typing: the other person of a direct chat I can write in. Nobody in a module chat
  // or in a read-only conversation (spec 022).
  async typingRecipients(me: Actor, id: string): Promise<string[]> {
    const { conversation, canWrite } = await this.access(me, id);
    if (conversation.type !== 'DIRECT' || !canWrite) return [];
    return conversation.members.filter((m) => m.userId !== me.id && available(m.user)).map((m) => m.userId);
  }

  // ---- delivery after saving ----------------------------------------------------------------------

  // Realtime to everyone who can see the message today (and to the other devices of the sender), then the
  // push for who does not have it open. Failures here never reach the sender: the message is saved.
  private async deliver(sender: Actor, conversation: ConversationRow, message: ReturnType<typeof messageView>) {
    try {
      const everyone = await this.participants(conversation);
      const recipients = everyone.filter((p) => p.id !== sender.id);
      this.broadcaster.messageNew([sender.id, ...recipients.map((p) => p.id)], message);
      for (const r of recipients) this.broadcaster.unreadChanged(r.id, await this.unreadTotal(r.id));
      void this.push.notify({
        conversationId: conversation.id,
        senderName: `${message.sender.firstName} ${message.sender.lastName}`.trim(),
        kind: message.kind,
        body: message.body,
        moduleName: conversation.module?.name ?? null,
        recipients: recipients.map((p) => ({ id: p.id, locale: p.locale })),
      });
    } catch (error) {
      this.logger.error(`Could not deliver a chat message: ${error instanceof Error ? error.name : 'Error'}`);
    }
  }

  // The people who take part in a conversation today and can receive.
  private async participants(c: ConversationRow): Promise<PersonRow[]> {
    if (c.type === 'MODULE') return c.moduleId ? moduleParticipants(this.prisma, c.moduleId) : [];
    return c.members.map((m) => m.user).filter(available);
  }

  // ---- access and queries -------------------------------------------------------------------------

  // The conversation if it is mine, with what I can do in it; otherwise it does not exist for me.
  private async access(me: Actor, id: string): Promise<Access> {
    const conversation = await this.prisma.conversation.findFirst({ where: { id, deletedAt: null }, include: CONVERSATION_INCLUDE });
    if (!conversation) throw notFound();

    if (conversation.type === 'DIRECT') {
      const partner = conversation.members.find((m) => m.userId !== me.id)?.user;
      if (!partner || !conversation.members.some((m) => m.userId === me.id)) throw notFound();
      const decision = directDecision({
        meRole: me.role,
        partnerRole: partner.role,
        partnerAvailable: available(partner),
        sharedActiveModule: await this.sharedActiveModule(me, partner),
      });
      return { conversation, canWrite: decision.canWrite, reason: decision.canWrite ? null : decision.reason, canAnnounce: false };
    }

    const module = conversation.module;
    if (!module) throw notFound();
    const enrolled =
      me.role === 'STUDENT' &&
      (await this.prisma.enrollment.count({ where: { moduleId: module.id, studentId: me.id, status: 'ACTIVE', deletedAt: null } })) > 0;
    const decision = moduleDecision({ isModuleTeacher: module.teacherId === me.id, hasActiveEnrollment: enrolled, periodClosed: module.period.status === 'CLOSED' });
    if (!decision.access) throw notFound();
    return { conversation, canWrite: decision.canWrite, reason: decision.canWrite ? null : decision.reason, canAnnounce: decision.canAnnounce };
  }

  // A student with an ACTIVE enrollment in a live module of the teacher, in a period that is not closed.
  private async sharedActiveModule(me: Actor, partner: PersonRow): Promise<boolean> {
    const [student, teacher] = me.role === 'STUDENT' ? [me.id, partner.id] : [partner.id, me.id];
    if (me.role !== 'STUDENT' && partner.role !== 'STUDENT') return false;
    const count = await this.prisma.enrollment.count({
      where: {
        studentId: student,
        status: 'ACTIVE',
        deletedAt: null,
        module: { teacherId: teacher, deletedAt: null, period: { status: { not: 'CLOSED' }, deletedAt: null } },
      },
    });
    return count > 0;
  }

  private async moduleIdsOf(me: Actor): Promise<string[]> {
    if (me.role === 'TEACHER') {
      const rows = await this.prisma.module.findMany({ where: { teacherId: me.id, deletedAt: null, period: { deletedAt: null } }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    if (me.role === 'STUDENT') {
      const rows = await this.prisma.enrollment.findMany({
        where: { studentId: me.id, status: 'ACTIVE', deletedAt: null, module: { deletedAt: null, period: { deletedAt: null } } },
        select: { moduleId: true },
      });
      return rows.map((r) => r.moduleId);
    }
    return [];
  }

  private async summarize(me: Actor, rows: ConversationRow[]) {
    const ids = rows.map((r) => r.id);
    const [unread, lastIds] = await Promise.all([this.unreadMap(me.id), this.lastMessageIds(me.id, ids)]);
    const lasts = lastIds.length > 0 ? await this.prisma.message.findMany({ where: { id: { in: lastIds } }, include: MESSAGE_INCLUDE }) : [];
    const lastBy = new Map(lasts.map((m) => [m.conversationId, m]));
    return rows.map((c) => {
      const last = lastBy.get(c.id);
      const partner = c.type === 'DIRECT' ? c.members.find((m) => m.userId !== me.id)?.user : undefined;
      return {
        id: c.id,
        type: c.type,
        partner: partner ? person(partner) : null,
        module: c.module ? { id: c.module.id, name: c.module.name } : null,
        unread: unread.get(c.id) ?? 0,
        lastMessage: last ? messageView(last) : null,
        lastMessageAt: last?.createdAt ?? null,
      };
    });
  }

  // Unread = live messages of others that this user can see, written after the last time they read.
  private async unreadMap(userId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ id: string; unread: number }[]>`
      SELECT m.conversation_id AS "id", COUNT(*)::int AS "unread"
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
      LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ${userId}::uuid
      WHERE m.deleted_at IS NULL AND m.sender_id <> ${userId}::uuid
        AND m.created_at > COALESCE(cm.last_read_at, 'epoch'::timestamptz)
        AND ${visibleTo(userId)}
      GROUP BY m.conversation_id`;
    return new Map(rows.map((r) => [r.id, r.unread]));
  }

  private async lastMessageIds(userId: string, conversationIds: string[]): Promise<string[]> {
    if (conversationIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (m.conversation_id) m.id
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = ANY(${conversationIds}::uuid[]) AND m.deleted_at IS NULL AND ${visibleTo(userId)}
      ORDER BY m.conversation_id, m.created_at DESC, m.id DESC`;
    return rows.map((r) => r.id);
  }
}
