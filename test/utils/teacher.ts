import { createTeacher, TEST_PASSWORD } from './factories.js';
import type { TestContext } from './test-app.js';

// A teacher with a token, ready to call the API.
export async function loginTeacher(ctx: TestContext) {
  const user = await createTeacher(ctx.prisma);
  const res = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
  return { user, token: res.body.accessToken as string };
}

export type Teacher = Awaited<ReturnType<typeof loginTeacher>>;

export const teacherApi = (ctx: TestContext, teacher: { token: string }) => {
  const call = (method: 'get' | 'post', url: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${teacher.token}`);
    return body ? req.send(body) : req;
  };
  return {
    modules: (query = '') => call('get', `/teacher/modules${query}`),
    sessions: (query = '') => call('get', `/teacher/sessions${query}`),
    reschedule: (id: string, body: object) => call('post', `/teacher/sessions/${id}/reschedule`, body),
    cancel: (id: string, body: object) => call('post', `/teacher/sessions/${id}/cancel`, body),
    restore: (id: string, body: object) => call('post', `/teacher/sessions/${id}/restore`, body),
  };
};
