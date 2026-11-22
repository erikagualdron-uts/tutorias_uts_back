import { createAdminSession, createStudent, createTeacher, TEST_PASSWORD } from './factories.js';
import { PQRS_ITEM_IDS, type TestContext } from './test-app.js';

// A signed-in caller of the PQRS routes (spec 017).
export async function signIn(ctx: TestContext, user: { email: string }) {
  const res = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
  const token = res.body.accessToken as string;
  const call = (method: 'get' | 'post', url: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
    return method === 'post' ? req.send(body ?? {}) : req;
  };
  return { token, get: (url: string) => call('get', url), post: (url: string, body?: object) => call('post', url, body) };
}

export type Caller = Awaited<ReturnType<typeof signIn>>;

export async function studentCaller(ctx: TestContext, overrides: Parameters<typeof createStudent>[1] = {}) {
  const user = await createStudent(ctx.prisma, overrides);
  return { user, ...(await signIn(ctx, user)) };
}

export async function teacherCaller(ctx: TestContext) {
  const user = await createTeacher(ctx.prisma);
  return { user, ...(await signIn(ctx, user)) };
}

export async function adminCaller(ctx: TestContext) {
  const { admin } = await createAdminSession(ctx);
  return { user: admin, ...(await signIn(ctx, admin)) };
}

// A valid body to file a PQRS; each call has its own `clientRequestId`.
export const pqrsBody = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  typeId: PQRS_ITEM_IDS[0],
  subject: 'Horario de tutorías',
  description: 'No encuentro el horario del módulo.',
  ...overrides,
});
