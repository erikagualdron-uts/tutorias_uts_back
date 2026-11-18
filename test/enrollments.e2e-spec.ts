import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnrollment, createPeriod, createRoom, createSession, createTeacher } from './utils/factories.js';
import { activePeriod, api, loginStudent, moduleWithSessions, TUESDAY } from './utils/enrollment.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('student enrollment: offer, detail, enroll and my enrollments', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  describe('offer and detail', () => {
    it('lists the modules of the active period only, searchable and paginated', async () => {
      const period = await activePeriod(ctx);
      const upcoming = await createPeriod(ctx.prisma, { startsOn: '2031-01-01', endsOn: '2031-06-30', status: 'UPCOMING' });
      const closed = await createPeriod(ctx.prisma, { startsOn: '2020-01-01', endsOn: '2020-06-30', status: 'CLOSED' });
      await moduleWithSessions(ctx, period.id, { name: 'Cálculo I' });
      await moduleWithSessions(ctx, period.id, { name: 'Física', slot: { dayOfWeek: 3, startMinute: 600, endMinute: 720 } });
      await moduleWithSessions(ctx, upcoming.id, { name: 'Próximo' });
      await moduleWithSessions(ctx, closed.id, { name: 'Cerrado' });
      const student = api(ctx, await loginStudent(ctx));

      const all = await student.offer();
      expect(all.status).toBe(200);
      expect(all.body.data.map((m: { name: string }) => m.name)).toEqual(['Cálculo I', 'Física']);
      expect(all.body.meta).toMatchObject({ periodId: period.id, total: 2, page: 1 });

      expect((await student.offer('?search=LCULO')).body.data).toHaveLength(1);
      const page = await student.offer('?limit=1&page=2');
      expect(page.body.data.map((m: { name: string }) => m.name)).toEqual(['Física']);
    });

    it('answers an empty page with a null period when none is active', async () => {
      const student = api(ctx, await loginStudent(ctx));
      const res = await student.offer();
      expect(res.body).toMatchObject({ data: [], meta: { periodId: null, total: 0 } });
    });

    it('shows capacity, free seats and the state of each card', async () => {
      const period = await activePeriod(ctx);
      const open = await moduleWithSessions(ctx, period.id, { name: 'A', capacity: 10 });
      const last = await moduleWithSessions(ctx, period.id, { name: 'B', capacity: 5, slot: { dayOfWeek: 3, startMinute: 600, endMinute: 720 } });
      const full = await moduleWithSessions(ctx, period.id, { name: 'C', capacity: 1, slot: { dayOfWeek: 4, startMinute: 600, endMinute: 720 } });
      for (let i = 0; i < 4; i++) await createEnrollment(ctx.prisma, { studentId: (await loginStudent(ctx)).user.id, moduleId: last.module.id });
      await createEnrollment(ctx.prisma, { studentId: (await loginStudent(ctx)).user.id, moduleId: full.module.id });
      const student = api(ctx, await loginStudent(ctx));
      const mine = await student.enroll(open.module.id);
      expect(mine.status).toBe(201);

      const byName = Object.fromEntries((await student.offer()).body.data.map((m: { name: string }) => [m.name, m]));
      expect(byName.A).toMatchObject({ capacity: 10, availableSeats: 9, state: 'ENROLLED', enrollment: { id: mine.body.id } });
      expect(byName.B).toMatchObject({ capacity: 5, availableSeats: 1, state: 'LAST_SPOTS' });
      expect(byName.C).toMatchObject({ capacity: 1, availableSeats: 0, state: 'FULL' });
    });

    it('blocks a module that overlaps one of the student and says which one', async () => {
      const period = await activePeriod(ctx);
      const own = await moduleWithSessions(ctx, period.id, { name: 'Propio', slot: { dayOfWeek: 2, startMinute: 840, endMinute: 960 } });
      const clash = await moduleWithSessions(ctx, period.id, { name: 'Cruza', slot: { dayOfWeek: 2, startMinute: 900, endMinute: 1020 } });
      const touching = await moduleWithSessions(ctx, period.id, { name: 'Contiguo', slot: { dayOfWeek: 2, startMinute: 960, endMinute: 1080 } });
      const student = api(ctx, await loginStudent(ctx));
      await student.enroll(own.module.id);
      const byName = Object.fromEntries((await student.offer()).body.data.map((m: { name: string }) => [m.name, m]));
      expect(byName.Cruza).toMatchObject({
        state: 'BLOCKED',
        blockReason: 'SCHEDULE_CONFLICT',
        conflict: { moduleName: 'Propio', dayOfWeek: 2, startTime: '14:00', endTime: '16:00' },
      });
      expect(byName.Contiguo.state).toBe('AVAILABLE');
      expect(clash.module.id).toBeDefined();
      expect(touching.module.id).toBeDefined();
    });

    it('blocks a module whose teacher or room is unavailable, or that has no future sessions', async () => {
      const period = await activePeriod(ctx);
      const teacherOff = await moduleWithSessions(ctx, period.id, { name: 'SinDocente' });
      await ctx.prisma.user.update({ where: { id: teacherOff.teacher.id }, data: { status: 'INACTIVE' } });
      const roomOff = await moduleWithSessions(ctx, period.id, { name: 'SinSalón', slot: { dayOfWeek: 3, startMinute: 600, endMinute: 720 } });
      await ctx.prisma.room.update({ where: { id: roomOff.room.id }, data: { status: 'INACTIVE' } });
      await moduleWithSessions(ctx, period.id, { name: 'SinSesiones', hoursAhead: [], slot: { dayOfWeek: 4, startMinute: 600, endMinute: 720 } });
      const student = api(ctx, await loginStudent(ctx));
      for (const m of (await student.offer()).body.data) {
        expect(m, m.name).toMatchObject({ state: 'BLOCKED', blockReason: 'UNAVAILABLE' });
      }
    });

    it('never exposes other students, only counts', async () => {
      const period = await activePeriod(ctx);
      const { module } = await moduleWithSessions(ctx, period.id);
      const other = await loginStudent(ctx);
      await createEnrollment(ctx.prisma, { studentId: other.user.id, moduleId: module.id });
      const student = api(ctx, await loginStudent(ctx));
      const text = JSON.stringify([(await student.offer()).body, (await student.detail(module.id)).body]);
      expect(text).not.toContain(other.user.id);
      expect(text).not.toContain(other.user.email);
    });

    it('answers 404 for a deleted module or one that is not offered and not the student\'s', async () => {
      const period = await activePeriod(ctx);
      const closed = await createPeriod(ctx.prisma, { startsOn: '2020-01-01', endsOn: '2020-06-30', status: 'CLOSED' });
      const deleted = await moduleWithSessions(ctx, period.id, { name: 'Borrado' });
      await ctx.prisma.module.update({ where: { id: deleted.module.id }, data: { deletedAt: new Date() } });
      const old = await moduleWithSessions(ctx, closed.id, { name: 'Antiguo' });
      const student = api(ctx, await loginStudent(ctx));
      expect((await student.detail(deleted.module.id)).status).toBe(404);
      expect((await student.detail(old.module.id)).status).toBe(404);
      expect((await student.detail('00000000-0000-4000-8000-000000000999')).status).toBe(404);
    });

    it('opens the detail of a closed-period or cancelled enrollment as read-only history', async () => {
      const period = await activePeriod(ctx);
      const closed = await createPeriod(ctx.prisma, { startsOn: '2020-01-01', endsOn: '2020-06-30', status: 'CLOSED' });
      const old = await moduleWithSessions(ctx, closed.id, { name: 'Antiguo' });
      const gone = await moduleWithSessions(ctx, period.id, { name: 'Cancelado' });
      const s = await loginStudent(ctx);
      const student = api(ctx, s);
      await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: old.module.id });
      await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: gone.module.id, status: 'CANCELLED' });

      const closedDetail = await student.detail(old.module.id);
      expect(closedDetail.status).toBe(200);
      expect(closedDetail.body).toMatchObject({ readOnly: true, sessions: [] });
      const cancelledDetail = await student.detail(gone.module.id);
      expect(cancelledDetail.status).toBe(200);
      expect(cancelledDetail.body.enrollment).toBeNull();
    });
  });

  describe('POST /student/enrollments', () => {
    it('enrolls, answers 201 and takes one seat', async () => {
      const period = await activePeriod(ctx);
      const { module } = await moduleWithSessions(ctx, period.id, { capacity: 3 });
      const student = api(ctx, await loginStudent(ctx));
      const res = await student.enroll(module.id);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ moduleId: module.id, status: 'ACTIVE', cancelledAt: null });
      expect(res.body.enrolledAt).toBeDefined();
      expect((await student.detail(module.id)).body.availableSeats).toBe(2);
    });

    it('counts only future sessions when the period has already started', async () => {
      const period = await activePeriod(ctx);
      const { module, room, teacher } = await moduleWithSessions(ctx, period.id, { capacity: 1, hoursAhead: [48] });
      await createSession(ctx.prisma, {
        moduleId: module.id,
        scheduleId: module.schedules[0].id,
        teacherId: teacher.id,
        roomId: room.id,
        startsAt: new Date(Date.now() - 48 * 3_600_000),
      });
      expect((await api(ctx, await loginStudent(ctx)).enroll(module.id)).status).toBe(201);
    });

    it('refuses a full module with the seats and capacity', async () => {
      const period = await activePeriod(ctx);
      const { module } = await moduleWithSessions(ctx, period.id, { capacity: 1 });
      expect((await api(ctx, await loginStudent(ctx)).enroll(module.id)).status).toBe(201);
      const res = await api(ctx, await loginStudent(ctx)).enroll(module.id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'ENROLLMENT_MODULE_FULL', details: { availableSeats: 0, capacity: 1 } });
    });

    it('measures the cupo per session: one full session makes the module full', async () => {
      const period = await activePeriod(ctx);
      const { module, sessions } = await moduleWithSessions(ctx, period.id, { capacity: 1 });
      const first = await loginStudent(ctx);
      const enrolled = await api(ctx, first).enroll(module.id);
      // the first student skips session 1, so session 1 has a seat but session 2 does not
      await api(ctx, first).cancelSession(enrolled.body.id, sessions[0].id);
      const second = api(ctx, await loginStudent(ctx));
      expect((await second.detail(module.id)).body.state).toBe('FULL');
      expect((await second.enroll(module.id)).body.code).toBe('ENROLLMENT_MODULE_FULL');
    });

    it('refuses a schedule overlap with the conflicting module, but allows touching hours', async () => {
      const period = await activePeriod(ctx);
      const own = await moduleWithSessions(ctx, period.id, { name: 'Propio', slot: { dayOfWeek: 2, startMinute: 840, endMinute: 960 } });
      const clash = await moduleWithSessions(ctx, period.id, { name: 'Cruza', slot: { dayOfWeek: 2, startMinute: 900, endMinute: 1020 } });
      const touching = await moduleWithSessions(ctx, period.id, { name: 'Contiguo', slot: { dayOfWeek: 2, startMinute: 960, endMinute: 1080 } });
      const student = api(ctx, await loginStudent(ctx));
      await student.enroll(own.module.id);
      const res = await student.enroll(clash.module.id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'ENROLLMENT_SCHEDULE_CONFLICT',
        details: { conflict: { moduleName: 'Propio', dayOfWeek: 2, startTime: '14:00', endTime: '16:00' } },
      });
      expect((await student.enroll(touching.module.id)).status).toBe(201);
    });

    it('refuses to enroll twice', async () => {
      const period = await activePeriod(ctx);
      const { module } = await moduleWithSessions(ctx, period.id);
      const student = api(ctx, await loginStudent(ctx));
      await student.enroll(module.id);
      const res = await student.enroll(module.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ENROLLMENT_ALREADY_ACTIVE');
    });

    it('refuses an unavailable module', async () => {
      const period = await activePeriod(ctx);
      const teacherOff = await moduleWithSessions(ctx, period.id);
      await ctx.prisma.user.update({ where: { id: teacherOff.teacher.id }, data: { status: 'INACTIVE' } });
      const roomOff = await moduleWithSessions(ctx, period.id, { slot: { dayOfWeek: 3, startMinute: 600, endMinute: 720 } });
      await ctx.prisma.room.update({ where: { id: roomOff.room.id }, data: { status: 'INACTIVE' } });
      const none = await moduleWithSessions(ctx, period.id, { hoursAhead: [], slot: { dayOfWeek: 4, startMinute: 600, endMinute: 720 } });
      const student = api(ctx, await loginStudent(ctx));
      for (const m of [teacherOff, roomOff, none]) {
        const res = await student.enroll(m.module.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ENROLLMENT_MODULE_UNAVAILABLE');
      }
    });

    it('refuses modules of an upcoming or closed period', async () => {
      const upcoming = await createPeriod(ctx.prisma, { startsOn: '2031-01-01', endsOn: '2031-06-30', status: 'UPCOMING' });
      const closed = await createPeriod(ctx.prisma, { startsOn: '2020-01-01', endsOn: '2020-06-30', status: 'CLOSED' });
      const a = await moduleWithSessions(ctx, upcoming.id);
      const b = await moduleWithSessions(ctx, closed.id);
      const student = api(ctx, await loginStudent(ctx));
      expect((await student.enroll(a.module.id)).body.code).toBe('ENROLLMENT_PERIOD_NOT_OPEN');
      const res = await student.enroll(b.module.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
    });

    it('answers 404 and 400 for a missing module and malformed bodies', async () => {
      const student = await loginStudent(ctx);
      const call = (body: object) => ctx.http().post('/api/v1/student/enrollments').set('Authorization', `Bearer ${student.token}`).send(body);
      expect((await call({ moduleId: '00000000-0000-4000-8000-000000000999' })).status).toBe(404);
      const bad = await call({ moduleId: 'nope' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
      expect((await call({ moduleId: '00000000-0000-4000-8000-000000000999', studentId: 'x' })).status).toBe(400);
    });

    it('counts rows in the database and the student of the token, never a body field', async () => {
      const period = await activePeriod(ctx);
      const { module } = await moduleWithSessions(ctx, period.id);
      const s = await loginStudent(ctx);
      await api(ctx, s).enroll(module.id);
      const rows = await ctx.prisma.enrollment.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].studentId).toBe(s.user.id);
    });
  });

  describe('GET /student/enrollments', () => {
    it('lists active enrollments by default with module, next session and upcoming count', async () => {
      const period = await activePeriod(ctx);
      const later = await moduleWithSessions(ctx, period.id, { name: 'Tarde', hoursAhead: [100, 300], slot: { dayOfWeek: 3, startMinute: 600, endMinute: 720 } });
      const soon = await moduleWithSessions(ctx, period.id, { name: 'Pronto', hoursAhead: [30, 200] });
      const gone = await moduleWithSessions(ctx, period.id, { name: 'Cancelado', slot: { dayOfWeek: 4, startMinute: 600, endMinute: 720 } });
      const s = await loginStudent(ctx);
      const student = api(ctx, s);
      await student.enroll(later.module.id);
      await student.enroll(soon.module.id);
      const cancelled = await student.enroll(gone.module.id);
      await student.cancelModule(cancelled.body.id);

      const res = await student.mine();
      expect(res.status).toBe(200);
      expect(res.body.data.map((i: { module: { name: string } }) => i.module.name)).toEqual(['Pronto', 'Tarde']);
      expect(res.body.data[0]).toMatchObject({ status: 'ACTIVE', readOnly: false, upcomingSessions: 2 });
      expect(res.body.data[0].nextSession.id).toBe(soon.sessions[0].id);

      const onlyCancelled = await student.mine('?status=CANCELLED');
      expect(onlyCancelled.body.data.map((i: { module: { name: string } }) => i.module.name)).toEqual(['Cancelado']);
      expect(onlyCancelled.body.data[0].nextSession).toBeNull();
      expect((await student.mine('?status=ALL')).body.meta.total).toBe(3);
      expect((await student.mine('?status=ALL&limit=2&page=2')).body.data).toHaveLength(1);
      expect((await student.mine('?status=NOPE')).status).toBe(400);
    });

    it('distinguishes sessions cancelled by holiday and by the student, and marks closed periods read-only', async () => {
      const period = await activePeriod(ctx);
      const closed = await createPeriod(ctx.prisma, { startsOn: '2020-01-01', endsOn: '2020-06-30', status: 'CLOSED' });
      const { module, room, teacher } = await moduleWithSessions(ctx, period.id, { hoursAhead: [48, 216] });
      await createSession(ctx.prisma, {
        moduleId: module.id,
        scheduleId: module.schedules[0].id,
        teacherId: teacher.id,
        roomId: room.id,
        startsAt: new Date(Date.now() + 24 * 3_600_000),
        status: 'CANCELLED',
      });
      const old = await moduleWithSessions(ctx, closed.id, { name: 'Antiguo' });
      const s = await loginStudent(ctx);
      const student = api(ctx, s);
      const enrolled = await student.enroll(module.id);
      await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: old.module.id });
      const sessions = (await student.detail(module.id)).body.sessions as { id: string; status: string; cancelReason: string | null; cancelledByStudent: boolean }[];
      await student.cancelSession(enrolled.body.id, sessions.find((x) => x.status === 'SCHEDULED')!.id);

      const detail = (await student.detail(module.id)).body.sessions as typeof sessions;
      expect(detail.find((x) => x.status === 'CANCELLED')).toMatchObject({ cancelReason: 'HOLIDAY', cancelledByStudent: false });
      expect(detail.filter((x) => x.cancelledByStudent)).toHaveLength(1);

      const list = (await student.mine()).body.data as { module: { name: string }; readOnly: boolean; nextSession: unknown }[];
      expect(list.find((i) => i.module.name === 'Antiguo')).toMatchObject({ readOnly: true, nextSession: null });
    });

    it('returns only the enrollments of the token\'s student', async () => {
      const period = await activePeriod(ctx);
      const { module } = await moduleWithSessions(ctx, period.id);
      const other = await loginStudent(ctx);
      await createEnrollment(ctx.prisma, { studentId: other.user.id, moduleId: module.id });
      const student = api(ctx, await loginStudent(ctx));
      expect((await student.mine('?status=ALL')).body.data).toEqual([]);
    });
  });

  it('keeps the helpers honest: a room and a teacher can be created standalone', async () => {
    expect((await createRoom(ctx.prisma)).id).toBeDefined();
    expect((await createTeacher(ctx.prisma)).id).toBeDefined();
    expect(TUESDAY.dayOfWeek).toBe(2);
  });
});
