// Routes without @Roles are open to any role with a session. Each one is listed here with its reason;
// a new route must declare @Roles or be added here on purpose (spec 023).
const P = '/api/v1';

// No session needed. Each takes personal data, so PublicThrottlerGuard rate-limits it.
export const PUBLIC_ROUTES: Record<string, string> = {
  [`POST ${P}/auth/register`]: 'student sign-up',
  [`POST ${P}/auth/verify-email`]: 'confirms the emailed code',
  [`POST ${P}/auth/resend-verification`]: 'resends the code before the first login',
  [`POST ${P}/auth/login`]: 'starts a session',
  [`POST ${P}/auth/forgot-password`]: 'emails a reset code',
  [`POST ${P}/auth/reset-password`]: 'sets a new password from the code',
  [`POST ${P}/auth/refresh`]: 'swaps a refresh token for a new pair',
};

// Session required, any role.
export const ANY_ROLE_ROUTES: Record<string, string> = {
  [`POST ${P}/auth/logout`]: 'every role signs out',
  [`GET ${P}/auth/me`]: 'every role reads its own profile',
  [`POST ${P}/auth/change-password`]: 'every role changes its own password',
  [`GET ${P}/notifications`]: 'own inbox, scoped to the caller',
  [`GET ${P}/notifications/unread-count`]: 'own inbox, scoped to the caller',
  [`POST ${P}/notifications/read-all`]: 'own inbox, scoped to the caller',
  [`POST ${P}/notifications/:id/read`]: 'own inbox, scoped to the caller',
  [`PUT ${P}/notifications/devices`]: 'registers the caller\'s own push token',
  [`DELETE ${P}/notifications/devices/:token`]: 'removes the caller\'s own push token',
  [`GET ${P}/dropdown-lists/:key/items`]: 'app selectors read the active items',
  [`GET ${P}/academic-periods/active`]: 'students and teachers see the active period',
  [`GET ${P}/pqrs/limits`]: 'the CAE and the authors need the reply limit',
  [`GET ${P}/chat/contacts`]: 'chat is open to the three roles, scoped to the caller',
  [`GET ${P}/chat/conversations`]: 'chat is open to the three roles, scoped to the caller',
  [`POST ${P}/chat/conversations`]: 'chat is open to the three roles, scoped to the caller',
  [`GET ${P}/chat/conversations/:id`]: 'chat is open to the three roles, scoped to the caller',
  [`GET ${P}/chat/conversations/:id/messages`]: 'chat is open to the three roles, scoped to the caller',
  [`POST ${P}/chat/conversations/:id/messages`]: 'chat is open to the three roles, scoped to the caller',
  [`POST ${P}/chat/conversations/:id/read`]: 'chat is open to the three roles, scoped to the caller',
  [`GET ${P}/chat/unread-count`]: 'chat is open to the three roles, scoped to the caller',
};
