import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { IS_PUBLIC, ROLES } from '../../src/common/guards/decorators.js';
import type { RouteInfo } from '../../src/common/route-audit.js';

const PREFIX = '/api/v1';
// Test-only controller, not part of the API.
const EXCLUDED = new Set(['RoleProbeController']);

const join = (...parts: string[]) =>
  '/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

// Every HTTP route of the running app, with what the guards read (@Public, @Roles) on method or class.
export function listRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype || EXCLUDED.has(metatype.name)) continue;
    const base = reflector.get<string | undefined>(PATH_METADATA, metatype) ?? '';
    const proto = Object.getPrototypeOf(instance) as object;

    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = (proto as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const verb = reflector.get<number | undefined>(METHOD_METADATA, handler);
      if (verb === undefined) continue;
      const sub = reflector.get<string | undefined>(PATH_METADATA, handler) ?? '';
      const targets = [handler, metatype];
      routes.push({
        method: RequestMethod[verb],
        path: join(PREFIX, base, sub),
        isPublic: !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets),
        roles: reflector.getAllAndOverride<string[] | undefined>(ROLES, targets) ?? [],
      });
    }
  }
  return routes;
}
