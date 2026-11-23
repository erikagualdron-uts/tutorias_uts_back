import type { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRoutes } from '../src/common/route-audit.js';
import { ANY_ROLE_ROUTES, PUBLIC_ROUTES } from './utils/route-policy.js';
import { listRoutes } from './utils/routes.js';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('route access', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  it('lists the routes (sanity)', () => {
    expect(listRoutes(ctx.app).length).toBeGreaterThan(50);
  });

  it('gives every route a rule: public and listed, @Roles, or any-role and listed', () => {
    const problems = auditRoutes(listRoutes(ctx.app), {
      publicRoutes: Object.keys(PUBLIC_ROUTES),
      anyRoleRoutes: Object.keys(ANY_ROLE_ROUTES),
    });
    expect(problems.map((p) => `${p.route}: ${p.problem}`)).toEqual([]);
  });

  // One route of each other role per caller role; the rule lives in RolesGuard, so one is enough.
  const OTHER_ROLE_ROUTE: Record<Role, string[]> = {
    SUPERADMIN: ['GET /api/v1/teacher/sessions', 'GET /api/v1/student/modules'],
    TEACHER: ['GET /api/v1/teachers', 'GET /api/v1/student/modules'],
    STUDENT: ['GET /api/v1/teachers', 'GET /api/v1/teacher/sessions'],
  };

  it.each(Object.entries(OTHER_ROLE_ROUTE) as [Role, string[]][])(
    'a %s gets 403 FORBIDDEN_ROLE on the routes of other roles',
    async (role, routes) => {
      const user = await createUser(ctx.prisma, { role });
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD });
      for (const route of routes) {
        const [method, path] = route.split(' ');
        const res = await ctx
          .http()
          [method.toLowerCase() as 'get'](path)
          .set('Authorization', `Bearer ${login.body.accessToken}`);
        expect(res.status, route).toBe(403);
        expect(res.body.code, route).toBe('FORBIDDEN_ROLE');
      }
    },
  );
});
