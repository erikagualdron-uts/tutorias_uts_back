import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { createModule, createPeriod, createRoom, createSession, createTeacher, createUser, TEST_PASSWORD } from './utils/factories.js';
import { loadContract, specPath } from './utils/contract.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('010-modules-sessions/contracts/modules-api.yaml'));

// Real answers of the modules and holidays API against specs/010-modules-sessions/contracts.
describe.skipIf(!contract.available)('responses match modules-api.yaml', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const res = await ctx.http().post('/api/v1/auth/login').send({ email: admin.email, password: TEST_PASSWORD });
    token = res.body.accessToken as string;
  });
  afterAll(() => ctx.close());

  // `path` is the contract template (/modules/{id}); `url` the real one.
  async function check(method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, url: string, schema?: string, body?: object) {
    const req = ctx.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
    const res = await (body ? req.send(body) : req);
    contract.assertDocumented(method, path, res.status);
    if (schema) contract.assertMatchesSchema(schema, res.body);
    return res;
  }

  it('modules: create, list, detail, sessions, room, teacher, schedules, edit and delete', async () => {
    const period = await createPeriod(ctx.prisma, { startsOn: '2030-01-07', endsOn: '2030-03-03' });
    const teacher = await createTeacher(ctx.prisma);
    const other = await createTeacher(ctx.prisma);
    const room = await createRoom(ctx.prisma);
    const next = await createRoom(ctx.prisma);
    const created = await check('post', '/modules', '/modules', 'ModuleDetail', {
      periodId: period.id,
      name: 'Cálculo',
      description: 'Límites',
      teacherId: teacher.id,
      roomId: room.id,
      schedules: [{ dayOfWeek: 2, startTime: '14:00', endTime: '16:00' }],
    });
    const id = created.body.id as string;
    await check('post', '/modules', '/modules', 'Error', { name: '' });
    await check('get', '/modules', '/modules', 'ModulePage');
    await check('get', '/modules/{id}', `/modules/${id}`, 'ModuleDetail');
    await check('get', '/modules/{id}/sessions', `/modules/${id}/sessions`, 'SessionPage');
    await check('patch', '/modules/{id}/room', `/modules/${id}/room`, 'ModuleDetail', { roomId: next.id });
    await check('patch', '/modules/{id}/teacher', `/modules/${id}/teacher`, 'ModuleDetail', { teacherId: other.id });
    await check('patch', '/modules/{id}', `/modules/${id}`, 'ModuleDetail', { name: 'Cálculo II' });
    await check('put', '/modules/{id}/schedules', `/modules/${id}/schedules`, 'ModuleDetail', {
      schedules: [{ dayOfWeek: 4, startTime: '10:00', endTime: '12:00' }],
    });
    await check('put', '/modules/{id}/schedules', `/modules/${id}/schedules`, 'Error', {
      schedules: [{ dayOfWeek: 4, startTime: '12:00', endTime: '10:00' }],
    });
    await check('get', '/modules/{id}', `/modules/00000000-0000-4000-8000-000000000999`, 'Error');
    await check('delete', '/modules/{id}', `/modules/${id}`);
  });

  it('modules: a cancelled session and a closed period', async () => {
    const period = await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2030-01-07', endsOn: '2030-03-03' });
    const module = await createModule(ctx.prisma, { periodId: period.id });
    await createSession(ctx.prisma, {
      moduleId: module.id,
      scheduleId: module.schedules[0]!.id,
      teacherId: module.teacherId,
      roomId: module.roomId,
      startsAt: new Date('2030-01-08T19:00:00Z'),
      status: 'CANCELLED',
    });
    await check('get', '/modules/{id}', `/modules/${module.id}`, 'ModuleDetail');
    await check('get', '/modules/{id}/sessions', `/modules/${module.id}/sessions`, 'SessionPage');
    await check('patch', '/modules/{id}', `/modules/${module.id}`, 'Error', { name: 'X' });
  });

  it('holidays: register, list, edit, preview, import and delete', async () => {
    ctx.holidays.entries = [{ date: '2030-03-25', name: 'San José' }];
    const created = await check('post', '/holidays', '/holidays', 'HolidayResult', { date: '2030-01-22', name: 'Festivo' });
    await check('post', '/holidays', '/holidays', 'Error', { date: '2020-01-01', name: 'Viejo' });
    await check('get', '/holidays', '/holidays?year=2030');
    await check('patch', '/holidays/{id}', `/holidays/${created.body.holiday.id}`, 'HolidayResult', { date: '2030-01-23', name: 'Movido' });
    await check('get', '/holidays/import-preview', '/holidays/import-preview?year=2030');
    await check('post', '/holidays/import', '/holidays/import', undefined, { year: 2030, dates: ['2030-03-25'] });
    await check('delete', '/holidays/{id}', `/holidays/${created.body.holiday.id}`, 'HolidayRemoval');
    ctx.holidays.mode = 'unavailable';
    await check('get', '/holidays/import-preview', '/holidays/import-preview?year=2030', 'Error');
  });

  it('teachers: the list', async () => {
    await createTeacher(ctx.prisma);
    await check('get', '/teachers', '/teachers');
  });
});
