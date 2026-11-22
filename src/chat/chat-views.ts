import type { Prisma } from '@prisma/client';

// What a chat answer says about a person. The CAE has no profile, so it shows as "CAE".
export const PERSON = {
  id: true,
  role: true,
  status: true,
  deletedAt: true,
  locale: true,
  studentProfile: { select: { firstName: true, lastName: true } },
  teacherProfile: { select: { firstName: true, lastName: true } },
} satisfies Prisma.UserSelect;

export type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON }>;

export const person = (user: PersonRow) => {
  const profile = user.studentProfile ?? user.teacherProfile;
  return { id: user.id, role: user.role, firstName: profile?.firstName ?? 'CAE', lastName: profile?.lastName ?? '' };
};

// Active and not deleted: the only accounts that can send or receive.
export const available = (user: Pick<PersonRow, 'status' | 'deletedAt'>) => user.status === 'ACTIVE' && !user.deletedAt;

export const MESSAGE_INCLUDE = { sender: { select: PERSON } } satisfies Prisma.MessageInclude;
type MessageRow = Prisma.MessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;

export const messageView = (m: MessageRow) => ({
  id: m.id,
  conversationId: m.conversationId,
  sender: person(m.sender),
  kind: m.kind,
  body: m.body,
  clientMessageId: m.clientMessageId,
  createdAt: m.createdAt,
});

export type MessageView = ReturnType<typeof messageView>;

// Accent- and case-insensitive text for the contact search.
export const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
