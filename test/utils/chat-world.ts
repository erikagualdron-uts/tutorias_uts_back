import { activePeriod, moduleWithSessions } from './enrollment.js';
import { createEnrollment } from './factories.js';
import { adminCaller, studentCaller, teacherCaller, type Caller } from './pqrs.js';
import type { TestContext } from './test-app.js';

// A CAE, a teacher with a module of an active period and a student enrolled in it (spec 018).
export async function chatWorld(ctx: TestContext) {
  const period = await activePeriod(ctx);
  const teacher = await teacherCaller(ctx);
  const student = await studentCaller(ctx);
  const cae = await adminCaller(ctx);
  const { module } = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, name: 'Cálculo I' });
  const enrollment = await createEnrollment(ctx.prisma, { studentId: student.user.id, moduleId: module.id });
  return { period, teacher, student, cae, module, enrollment };
}

// Another student enrolled in the same module.
export async function enrollAnother(ctx: TestContext, moduleId: string) {
  const student = await studentCaller(ctx);
  const enrollment = await createEnrollment(ctx.prisma, { studentId: student.user.id, moduleId });
  return { student, enrollment };
}

export const messageBody = (overrides: Record<string, unknown> = {}) => ({
  clientMessageId: crypto.randomUUID(),
  body: 'Hola, tengo una duda',
  ...overrides,
});

// Opens (or finds) the direct conversation of `from` with `to`.
export async function directWith(from: Caller, to: { user: { id: string } }) {
  const res = await from.post('/chat/conversations', { userId: to.user.id });
  return res.body as { id: string };
}

export const sendTo = (from: Caller, conversationId: string, overrides: Record<string, unknown> = {}) =>
  from.post(`/chat/conversations/${conversationId}/messages`, messageBody(overrides));

// The id of the module chat of the caller, created on demand by the list.
export async function moduleChatOf(who: Caller, moduleId: string) {
  const list = (await who.get('/chat/conversations')).body as { id: string; module: { id: string } | null }[];
  return list.find((c) => c.module?.id === moduleId)!.id;
}
