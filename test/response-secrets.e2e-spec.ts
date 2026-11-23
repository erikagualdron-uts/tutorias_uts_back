import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPqrs } from './utils/factories.js';
import { chatWorld, directWith, sendTo } from './utils/chat-world.js';
import type { Caller } from './utils/pqrs.js';
import { createTestApp, PQRS_ITEM_IDS, type TestContext } from './utils/test-app.js';

// Keys no response may carry (compared lowercase, exact). `temporaryPassword` is not here: it only
// appears once, in the answers of create and regenerate, which this suite never calls.
const SECRET_KEYS = new Set(['passwordhash', 'password', 'refreshtoken', 'accesstoken', 'secret', 'smtppassword', 'pass', 'verificationcode', 'resetcode', 'codehash', 'tokenhash']);
// Contact data a teacher or a student must not see about anyone; their own profile is the exception.
const CONTACT_KEYS = new Set(['email', 'phone']);
const OWN_PROFILE = '/auth/me';

function keysOf(value: unknown, path = '$'): { key: string; path: string }[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysOf(v, `${path}[${i}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, v]) => [{ key, path: `${path}.${key}` }, ...keysOf(v, `${path}.${key}`)]);
  return [];
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const RANGE = `?from=${day(-1)}&to=${day(5)}`;

describe('responses carry no secrets or foreign contact data', () => {
  let ctx: TestContext;
  let world: Awaited<ReturnType<typeof chatWorld>>;
  let ids: { module: string; conversation: string; pqrs: string; student: string; teacher: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
    world = await chatWorld(ctx);
    const conversation = await directWith(world.student, world.teacher);
    await sendTo(world.student, conversation.id);
    const pqrs = await createPqrs(ctx.prisma, { authorId: world.student.user.id, typeId: PQRS_ITEM_IDS[0] });
    ids = {
      module: world.module.id,
      conversation: conversation.id,
      pqrs: pqrs.id,
      student: world.student.user.id,
      teacher: world.teacher.user.id,
    };
  });
  afterAll(() => ctx.close());

  const common = ['/auth/me', '/notifications', '/notifications/unread-count', '/chat/contacts', '/chat/conversations', '/chat/unread-count', '/pqrs/limits', '/academic-periods/active'];
  const reads = () => ({
    SUPERADMIN: [...common, '/modules', `/modules/${ids.module}`, `/modules/${ids.module}/sessions`, '/teachers', `/teachers/${ids.teacher}`, '/students', `/students/${ids.student}`, '/rooms', '/locations', '/academic-periods', `/holidays?year=${new Date().getFullYear()}`, '/settings/smtp', '/dropdown-lists', '/pqrs', `/pqrs/${ids.pqrs}`, '/dashboard/admin/overview', '/dashboard/admin/changes', '/dashboard/admin/rooms'],
    TEACHER: [...common, '/teacher/modules', '/teacher/sessions', `/teacher/calendar${RANGE}`, '/dashboard/teacher', '/pqrs/mine', `/chat/conversations/${ids.conversation}`, `/chat/conversations/${ids.conversation}/messages`],
    STUDENT: [...common, '/student/modules', `/student/modules/${ids.module}`, '/student/enrollments', `/student/calendar${RANGE}`, '/dashboard/student', '/pqrs/mine', `/pqrs/mine/${ids.pqrs}`, `/chat/conversations/${ids.conversation}`, `/chat/conversations/${ids.conversation}/messages`],
  });
  const caller = (role: string): Caller => ({ SUPERADMIN: world.cae, TEACHER: world.teacher, STUDENT: world.student })[role as 'STUDENT'];

  for (const role of ['SUPERADMIN', 'TEACHER', 'STUDENT'] as const) {
    it(`${role}: no credential keys, and no foreign contact data for teacher and student`, async () => {
      const leaks: string[] = [];
      for (const path of reads()[role]) {
        const res = await caller(role).get(path);
        expect(res.status, `${path} -> ${JSON.stringify(res.body)}`).toBe(200);
        for (const { key, path: at } of keysOf(res.body)) {
          const k = key.toLowerCase();
          if (SECRET_KEYS.has(k)) leaks.push(`${path} ${at}`);
          if (role !== 'SUPERADMIN' && CONTACT_KEYS.has(k) && path !== OWN_PROFILE) leaks.push(`${path} ${at}`);
        }
      }
      expect(leaks).toEqual([]);
    });
  }
});
