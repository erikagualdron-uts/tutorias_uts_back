export interface RouteInfo {
  method: string;
  path: string;
  isPublic: boolean;
  roles: readonly string[];
}

// Entries are `METHOD /full/path`.
export interface RoutePolicy {
  publicRoutes: readonly string[];
  anyRoleRoutes: readonly string[];
}

export type RouteProblem =
  | 'MISSING_RULE'
  | 'PUBLIC_NOT_LISTED'
  | 'STALE_PUBLIC_ENTRY'
  | 'STALE_ANY_ROLE_ENTRY';

export const routeKey = (r: Pick<RouteInfo, 'method' | 'path'>) =>
  `${r.method} ${r.path}`;

// A route is covered if it is public and listed, has @Roles, or is listed as any-role on purpose.
export function auditRoutes(
  routes: readonly RouteInfo[],
  policy: RoutePolicy,
): { route: string; problem: RouteProblem }[] {
  const problems: { route: string; problem: RouteProblem }[] = [];
  const publicListed = new Set(policy.publicRoutes);
  const anyRoleListed = new Set(policy.anyRoleRoutes);
  const publicSeen = new Set<string>();
  const anyRoleSeen = new Set<string>();

  for (const r of routes) {
    const route = routeKey(r);
    if (r.isPublic) {
      publicSeen.add(route);
      if (!publicListed.has(route))
        problems.push({ route, problem: 'PUBLIC_NOT_LISTED' });
    } else if (r.roles.length === 0) {
      if (anyRoleListed.has(route)) anyRoleSeen.add(route);
      else problems.push({ route, problem: 'MISSING_RULE' });
    }
  }
  for (const route of policy.publicRoutes)
    if (!publicSeen.has(route))
      problems.push({ route, problem: 'STALE_PUBLIC_ENTRY' });
  for (const route of policy.anyRoleRoutes)
    if (!anyRoleSeen.has(route))
      problems.push({ route, problem: 'STALE_ANY_ROLE_ENTRY' });
  return problems;
}
