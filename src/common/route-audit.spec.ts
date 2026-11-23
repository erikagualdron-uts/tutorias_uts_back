import { describe, expect, it } from 'vitest';
import { auditRoutes, type RouteInfo } from './route-audit.js';

const route = (
  method: string,
  path: string,
  extra: Partial<RouteInfo> = {},
): RouteInfo => ({ method, path, isPublic: false, roles: [], ...extra });

const policy = {
  publicRoutes: ['POST /api/v1/auth/login'],
  anyRoleRoutes: ['GET /api/v1/auth/me'],
};

describe('auditRoutes', () => {
  it('accepts public, any-role and role-restricted routes that are listed', () => {
    const routes = [
      route('POST', '/api/v1/auth/login', { isPublic: true }),
      route('GET', '/api/v1/auth/me'),
      route('GET', '/api/v1/modules', { roles: ['SUPERADMIN'] }),
    ];
    expect(auditRoutes(routes, policy)).toEqual([]);
  });

  it('names a route with no rule', () => {
    const routes = [
      route('POST', '/api/v1/auth/login', { isPublic: true }),
      route('GET', '/api/v1/auth/me'),
      route('DELETE', '/api/v1/rooms/:id'),
    ];
    expect(auditRoutes(routes, policy)).toEqual([
      { route: 'DELETE /api/v1/rooms/:id', problem: 'MISSING_RULE' },
    ]);
  });

  it('flags a public route that is not listed', () => {
    const routes = [
      route('POST', '/api/v1/auth/login', { isPublic: true }),
      route('GET', '/api/v1/auth/me'),
      route('GET', '/api/v1/open', { isPublic: true }),
    ];
    expect(auditRoutes(routes, policy)).toEqual([
      { route: 'GET /api/v1/open', problem: 'PUBLIC_NOT_LISTED' },
    ]);
  });

  it('flags list entries whose route no longer exists', () => {
    expect(auditRoutes([], policy)).toEqual([
      { route: 'POST /api/v1/auth/login', problem: 'STALE_PUBLIC_ENTRY' },
      { route: 'GET /api/v1/auth/me', problem: 'STALE_ANY_ROLE_ENTRY' },
    ]);
  });

  it('flags a role-restricted route that is also listed as any-role', () => {
    const routes = [
      route('POST', '/api/v1/auth/login', { isPublic: true }),
      route('GET', '/api/v1/auth/me', { roles: ['STUDENT'] }),
    ];
    expect(auditRoutes(routes, policy)).toEqual([
      { route: 'GET /api/v1/auth/me', problem: 'STALE_ANY_ROLE_ENTRY' },
    ]);
  });
});
