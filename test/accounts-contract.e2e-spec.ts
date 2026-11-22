import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { activePeriod, moduleWithSessions } from './utils/enrollment.js';
import { loadContract, specPath } from './utils/contract.js';
import { createAdminSession, createEnrollment, createStudent, createTeacher } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('016-account-management/contracts/accounts-api.yaml'));
const NOBODY = '00000000-0000-4000-8000-000000000999';

// Real answers of the 12 endpoints against specs/016-account-management/contracts.
describe.skipIf(!contract.available)('responses match accounts-api.yaml', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    token = (await createAdminSession(ctx)).token;
  });
  afterAll(() => ctx.close());

  const call = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const check = (res: { status: number; body: unknown }, method: string, path: string, schema: string) => {
    contract.assertDocumented(method, path, res.status);
    contract.assertMatchesSchema(schema, res.body);
    return res;
  };

  it('teachers: list, detail, edit, password, deactivate, reactivate, delete', async () => {
    const period = await activePeriod(ctx);
    const teacher = await createTeacher(ctx.prisma);
    await moduleWithSessions(ctx, period.id, { teacherId: teacher.id });
    const id = teacher.id;

    check(await call('get', '/teachers'), 'get', '/teachers', 'TeacherPage');
    check(await call('get', `/teachers/${id}`), 'get', '/teachers/{id}', 'TeacherDetail');
    check(await call('get', `/teachers/${NOBODY}`), 'get', '/teachers/{id}', 'Error');
    const patch = '/teachers/{id}';
    check(await call('patch', `/teachers/${id}`, { firstName: 'Ana', lastName: 'Ruiz', phone: null }), 'patch', patch, 'TeacherDetail');
    check(await call('patch', `/teachers/${id}`, { firstName: '', lastName: 'Ruiz' }), 'patch', patch, 'Error');
    check(await call('patch', `/teachers/${NOBODY}`, { firstName: 'Ana', lastName: 'Ruiz' }), 'patch', patch, 'Error');
    const password = '/teachers/{id}/temporary-password';
    check(await call('post', `/teachers/${id}/temporary-password`), 'post', password, 'TemporaryPassword');
    check(await call('post', `/teachers/${NOBODY}/temporary-password`), 'post', password, 'Error');
    check(await call('post', `/teachers/${id}/deactivate`), 'post', '/teachers/{id}/deactivate', 'TeacherBajaResult');
    check(await call('post', `/teachers/${id}/temporary-password`), 'post', password, 'Error');
    check(await call('post', `/teachers/${NOBODY}/deactivate`), 'post', '/teachers/{id}/deactivate', 'Error');
    check(await call('post', `/teachers/${id}/reactivate`), 'post', '/teachers/{id}/reactivate', 'AccountState');
    check(await call('post', `/teachers/${NOBODY}/reactivate`), 'post', '/teachers/{id}/reactivate', 'Error');
    check(await call('delete', `/teachers/${id}`), 'delete', '/teachers/{id}', 'TeacherBajaResult');
    check(await call('delete', `/teachers/${id}`), 'delete', '/teachers/{id}', 'Error');
  });

  it('students: list, detail, deactivate, reactivate, delete', async () => {
    const period = await activePeriod(ctx);
    const { module } = await moduleWithSessions(ctx, period.id);
    const student = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: module.id });
    const other = await createStudent(ctx.prisma);
    const id = student.id;

    check(await call('get', '/students'), 'get', '/students', 'StudentPage');
    check(await call('get', `/students/${id}`), 'get', '/students/{id}', 'StudentListItem');
    check(await call('get', `/students/${NOBODY}`), 'get', '/students/{id}', 'Error');
    check(await call('post', `/students/${id}/deactivate`), 'post', '/students/{id}/deactivate', 'StudentBajaResult');
    check(await call('post', `/students/${NOBODY}/deactivate`), 'post', '/students/{id}/deactivate', 'Error');
    check(await call('post', `/students/${id}/reactivate`), 'post', '/students/{id}/reactivate', 'AccountState');
    check(await call('post', `/students/${NOBODY}/reactivate`), 'post', '/students/{id}/reactivate', 'Error');
    check(await call('delete', `/students/${other.id}`), 'delete', '/students/{id}', 'StudentBajaResult');
    check(await call('delete', `/students/${other.id}`), 'delete', '/students/{id}', 'Error');
  });
});
