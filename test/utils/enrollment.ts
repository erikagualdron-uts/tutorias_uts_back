import {
  createModule,
  createPeriod,
  createRoom,
  createSession,
  createStudent,
  createTeacher,
  SlotInput,
  TEST_PASSWORD,
} from './factories.js';
import type { TestContext } from './test-app.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

// An ACTIVE period that contains today.
export const activePeriod = (ctx: TestContext) =>
  createPeriod(ctx.prisma, { startsOn: isoDay(-7), endsOn: isoDay(90), status: 'ACTIVE' });

export const TUESDAY: SlotInput = { dayOfWeek: 2, startMinute: 840, endMinute: 960 };

// A module of `periodId` with one session per entry of `hoursAhead` (hours from now). Each module
// gets its own teacher and room unless given, so the exclusion constraints never interfere.
export async function moduleWithSessions(
  ctx: TestContext,
  periodId: string,
  options: {
    capacity?: number;
    hoursAhead?: number[];
    slot?: SlotInput;
    name?: string;
    roomId?: string;
    teacherId?: string;
  } = {},
) {
  const room = options.roomId ? { id: options.roomId } : await createRoom(ctx.prisma, { capacity: options.capacity ?? 30 });
  const teacher = options.teacherId ? { id: options.teacherId } : await createTeacher(ctx.prisma);
  const module = await createModule(ctx.prisma, {
    periodId,
    roomId: room.id,
    teacherId: teacher.id,
    name: options.name,
    schedules: [options.slot ?? TUESDAY],
  });
  const sessions = [];
  for (const hours of options.hoursAhead ?? [48, 48 + 168]) {
    sessions.push(
      await createSession(ctx.prisma, {
        moduleId: module.id,
        scheduleId: module.schedules[0].id,
        teacherId: teacher.id,
        roomId: room.id,
        startsAt: new Date(Date.now() + hours * HOUR_MS),
      }),
    );
  }
  return { module, room, teacher, sessions };
}

// A student with a token, ready to call the API.
export async function loginStudent(ctx: TestContext) {
  const user = await createStudent(ctx.prisma);
  const res = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
  const token = res.body.accessToken as string;
  return { user, token, get: (url: string) => ctx.http().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`) };
}

export type Student = Awaited<ReturnType<typeof loginStudent>>;

export const api = (ctx: TestContext, student: Student) => {
  const call = (method: 'get' | 'post' | 'delete', url: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${student.token}`);
    return body ? req.send(body) : req;
  };
  return {
    offer: (query = '') => call('get', `/student/modules${query}`),
    detail: (moduleId: string) => call('get', `/student/modules/${moduleId}`),
    enroll: (moduleId: string) => call('post', '/student/enrollments', { moduleId }),
    mine: (query = '') => call('get', `/student/enrollments${query}`),
    cancelModule: (enrollmentId: string) => call('delete', `/student/enrollments/${enrollmentId}`),
    cancelSession: (enrollmentId: string, sessionId: string) =>
      call('post', `/student/enrollments/${enrollmentId}/sessions/${sessionId}/cancel`),
    restoreSession: (enrollmentId: string, sessionId: string) =>
      call('post', `/student/enrollments/${enrollmentId}/sessions/${sessionId}/restore`),
  };
};
