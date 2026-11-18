import { createModule, createPeriod, createRoom, createSession, createStudent, createEnrollment, type SlotInput } from './factories.js';
import { loginTeacher } from './teacher.js';
import type { TestContext } from './test-app.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

// 2030-01-08 is a Tuesday. Weekly sessions at 14:00 Bogota (19:00Z): week(0) is 2030-01-08.
export const week = (n: number, hourUtc = 19, dayOffset = 0) => new Date(Date.UTC(2030, 0, 8 + 7 * n + dayOffset, hourUtc));
export const TUE: SlotInput = { dayOfWeek: 2, startMinute: 840, endMinute: 960 };
export const THU: SlotInput = { dayOfWeek: 4, startMinute: 840, endMinute: 960 };

// An ACTIVE period of 2030 and a clock frozen on Monday 2030-01-07 07:00 Bogota.
export async function start(ctx: TestContext, period: { endsOn?: string } = {}) {
  ctx.clock.freezeAt(new Date('2030-01-07T12:00:00Z'));
  return createPeriod(ctx.prisma, { startsOn: '2030-01-07', endsOn: period.endsOn ?? '2030-03-03', status: 'ACTIVE' });
}

// A module of the teacher with the weekly `slots` and one session per week (weeks 0 to `weeks - 1`) for each.
export async function seriesModule(
  ctx: TestContext,
  periodId: string,
  options: { teacherId?: string; roomId?: string; name?: string; slots?: SlotInput[]; weeks?: number; capacity?: number } = {},
) {
  const teacher = options.teacherId ? { user: { id: options.teacherId }, token: '' } : await loginTeacher(ctx);
  const room = options.roomId ? { id: options.roomId } : await createRoom(ctx.prisma, { capacity: options.capacity ?? 30 });
  const slots = options.slots ?? [TUE];
  const module = await createModule(ctx.prisma, {
    periodId,
    teacherId: teacher.user.id,
    roomId: room.id,
    name: options.name,
    schedules: slots,
  });
  const sessions: Record<number, Awaited<ReturnType<typeof createSession>>[]> = {};
  for (const [i, slot] of slots.entries()) {
    sessions[i] = [];
    for (let n = 0; n < (options.weeks ?? 4); n++) {
      sessions[i].push(
        await createSession(ctx.prisma, {
          moduleId: module.id,
          scheduleId: module.schedules[i].id,
          teacherId: teacher.user.id,
          roomId: room.id,
          startsAt: week(n, 19, slot.dayOfWeek - 2),
        }),
      );
    }
  }
  return { teacher, room, module, sessions };
}

export async function enrollStudents(ctx: TestContext, moduleId: string, count: number) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const student = await createStudent(ctx.prisma);
    out.push({ student, enrollment: await createEnrollment(ctx.prisma, { studentId: student.id, moduleId }) });
  }
  return out;
}
