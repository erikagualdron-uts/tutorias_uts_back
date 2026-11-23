import os from 'node:os';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// p95 of the server answer, per main endpoint, against the data of `seed:load` (spec 023).
const MAX_MS = Number(process.env.PERF_MAX_MS ?? 300);
const WARMUP = 3;
const RUNS = 20;
const PASSWORD = 'Clave1234';
// A week inside the 12 seeded weeks of the active period (2026-10-19 to 2027-01-10).
const WEEK = '?from=2026-11-23&to=2026-11-29';

let http: ReturnType<typeof request>;
let close: () => Promise<void>;
const tokens = new Map<string, string>();

async function login(email: string) {
  const res = await http.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status, `login ${email}`).toBe(200);
  tokens.set(email, res.body.accessToken);
  return email;
}

const CAE = 'cae@correo.uts.edu.co';
const TEACHER = 'docente0@correo.uts.edu.co';
const STUDENT = 'estudiante0@uts.edu.co';

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());
  close = () => app.close();
  await Promise.all([CAE, TEACHER, STUDENT].map(login));

  // The conversation with most messages and one of its members, to read it like its users do.
  const prisma = app.get(PrismaService);
  const [{ conversationId }] = await prisma.message.groupBy({ by: ['conversationId'], _count: { _all: true }, orderBy: { _count: { conversationId: 'desc' } }, take: 1 });
  const member = await prisma.conversationMember.findFirstOrThrow({ where: { conversationId }, select: { user: { select: { email: true } } } });
  await login(member.user.email);
  BIG_CHAT = { id: conversationId, email: member.user.email };
});
afterAll(() => close?.());

let BIG_CHAT: { id: string; email: string };

const table: Record<string, string | number>[] = [];
async function measure(label: string, who: () => string, path: () => string) {
  const call = () => http.get(`/api/v1${path()}`).set('Authorization', `Bearer ${tokens.get(who())}`);
  for (let i = 0; i < WARMUP; i++) expect((await call()).status, label).toBe(200);
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    const res = await call();
    times.push(performance.now() - start);
    expect(res.status, label).toBe(200);
    bytes = res.text.length;
  }
  times.sort((a, b) => a - b);
  const row = { endpoint: label, bytes, median: Math.round(times[RUNS / 2]), p95: Math.round(times[Math.ceil(RUNS * 0.95) - 1]) };
  table.push({ ...row, goal: MAX_MS, ok: row.p95 <= MAX_MS ? 'yes' : 'NO' });
  return row;
}

const endpoints: [string, () => string, () => string][] = [
  ['CAE GET /modules', () => CAE, () => '/modules'],
  ['CAE GET /dashboard/admin/overview', () => CAE, () => '/dashboard/admin/overview'],
  ['CAE GET /dashboard/admin/changes', () => CAE, () => '/dashboard/admin/changes'],
  ['CAE GET /dashboard/admin/rooms', () => CAE, () => '/dashboard/admin/rooms'],
  ['CAE GET /pqrs (status, type)', () => CAE, () => '/pqrs?status=IN_REVIEW&typeId=a1b2c3d4-0002-4000-8000-000000000001'],
  ['CAE GET /pqrs', () => CAE, () => '/pqrs'],
  ['Teacher GET /teacher/calendar (week)', () => TEACHER, () => `/teacher/calendar${WEEK}`],
  ['Teacher GET /teacher/modules', () => TEACHER, () => '/teacher/modules'],
  ['Teacher GET /dashboard/teacher', () => TEACHER, () => '/dashboard/teacher'],
  ['Student GET /student/modules', () => STUDENT, () => '/student/modules'],
  ['Student GET /student/calendar (week)', () => STUDENT, () => `/student/calendar${WEEK}`],
  ['Student GET /student/enrollments', () => STUDENT, () => '/student/enrollments'],
  ['Student GET /dashboard/student', () => STUDENT, () => '/dashboard/student'],
  ['Student GET /chat/conversations', () => STUDENT, () => '/chat/conversations'],
  ['Member GET /chat/conversations/:id/messages (largest)', () => BIG_CHAT.email, () => `/chat/conversations/${BIG_CHAT.id}/messages`],
];

it('answers every main endpoint within the goal (p95)', async () => {
  const results = [];
  for (const [label, who, path] of endpoints) results.push(await measure(label, who, path));
  const lines = table.map((r) => `${String(r.endpoint).padEnd(54)} median ${String(r.median).padStart(4)} ms   p95 ${String(r.p95).padStart(4)} ms   ${String(r.bytes).padStart(7)} B   goal ${r.goal}   ${r.ok}`);
  const env = `${os.platform()} ${os.release()}, ${os.cpus()[0].model}, ${Math.round(os.totalmem() / 2 ** 30)} GB, node ${process.version}`;
  process.stdout.write(['', `Environment: ${env}`, ...lines, ''].join('\n'));
  expect(results.filter((r) => r.p95 > MAX_MS).map((r) => `${r.endpoint}: p95 ${r.p95} ms`)).toEqual([]);
});
