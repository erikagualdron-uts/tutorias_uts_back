import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { SessionService } from '../auth/session.service.js';
import type { Clock } from '../common/clock.js';
import { AccountStatusService } from './account-status.js';

const now = new Date('2026-11-21T15:00:00Z');

function setup(found: boolean) {
  const update = vi.fn().mockResolvedValue({});
  const findFirst = vi.fn().mockResolvedValue(found ? { id: 'u1' } : null);
  const revokeAllForUser = vi.fn().mockResolvedValue({});
  const tx = { user: { findFirst, update } } as unknown as Prisma.TransactionClient;
  const service = new AccountStatusService(
    { now: () => now } as Clock,
    { revokeAllForUser } as unknown as SessionService,
  );
  return { service, tx, update, findFirst, revokeAllForUser };
}

describe('AccountStatusService.apply', () => {
  it.each([
    ['deactivate', { status: 'INACTIVE' }],
    ['reactivate', { status: 'ACTIVE' }],
    ['delete', { deletedAt: now }],
  ] as const)('%s writes %j', async (action, data) => {
    const { service, tx, update } = setup(true);
    await service.apply(tx, 'u1', 'TEACHER', action);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data });
  });

  it('only looks at live accounts of the expected role, verified for students', async () => {
    const { service, tx, findFirst } = setup(true);
    await service.apply(tx, 'u1', 'STUDENT', 'deactivate');
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'u1',
      role: 'STUDENT',
      deletedAt: null,
      emailVerifiedAt: { not: null },
    });
    await service.apply(tx, 'u1', 'TEACHER', 'deactivate');
    expect(findFirst.mock.calls[1][0].where).not.toHaveProperty('emailVerifiedAt');
  });

  it.each(['deactivate', 'reactivate', 'delete'] as const)(
    '%s on an unknown, deleted or administrative id is ACCOUNT_NOT_FOUND',
    async (action) => {
      const { service, tx, update } = setup(false);
      await expect(service.apply(tx, 'u1', 'TEACHER', action)).rejects.toMatchObject({
        status: 404,
        code: 'ACCOUNT_NOT_FOUND',
      });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('repeating an action rewrites the same value without failing', async () => {
    const { service, tx, update } = setup(true);
    await service.apply(tx, 'u1', 'TEACHER', 'deactivate');
    await service.apply(tx, 'u1', 'TEACHER', 'deactivate');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]).toEqual(update.mock.calls[0]);
  });
});

describe('AccountStatusService.closeSessions', () => {
  it('revokes every session of the user', async () => {
    const { service, revokeAllForUser } = setup(true);
    await service.closeSessions('u1');
    expect(revokeAllForUser).toHaveBeenCalledWith('u1');
  });
});
