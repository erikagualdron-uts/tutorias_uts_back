import { Injectable } from '@nestjs/common';
import { Prisma, type PqrsStatus } from '@prisma/client';
import { AppException } from '../common/errors/app.exception.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { CreatePqrsDto } from './dto/create-pqrs.dto.js';
import type { ListMinePqrsQuery, ListPqrsQuery } from './dto/list-pqrs.query.js';
import { canRespond, canResolve, canTransition } from './pqrs-transitions.js';

const WITH_TYPE = { type: { select: { id: true, labelEs: true, labelEn: true } } } satisfies Prisma.PqrsInclude;
const WITH_MESSAGES = {
  messages: { where: { deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.PqrsInclude;
const WITH_AUTHOR = {
  author: {
    select: {
      id: true,
      role: true,
      email: true,
      studentProfile: { select: { firstName: true, lastName: true } },
      teacherProfile: { select: { firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.PqrsInclude;

type Row = Prisma.PqrsGetPayload<{ include: typeof WITH_TYPE }>;
type DetailRow = Prisma.PqrsGetPayload<{ include: typeof WITH_TYPE & typeof WITH_MESSAGES }>;
type AdminRow = Prisma.PqrsGetPayload<{ include: typeof WITH_TYPE & typeof WITH_AUTHOR }>;
type AdminDetailRow = Prisma.PqrsGetPayload<{ include: typeof WITH_TYPE & typeof WITH_AUTHOR & typeof WITH_MESSAGES }>;

const summary = (p: Row) => ({
  id: p.id,
  type: p.type,
  subject: p.subject,
  status: p.status,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});
const messageView = (m: { id: string; body: string; createdAt: Date }) => ({ id: m.id, body: m.body, createdAt: m.createdAt });
const detail = (p: DetailRow) => ({ ...summary(p), description: p.description, messages: p.messages.map(messageView) });
const authorView = ({ author }: AdminRow) => {
  const profile = author.studentProfile ?? author.teacherProfile;
  return { id: author.id, role: author.role, firstName: profile?.firstName ?? '', lastName: profile?.lastName ?? '', email: author.email };
};
const adminSummary = (p: AdminRow) => ({ ...summary(p), author: authorView(p) });
const adminDetail = (p: AdminDetailRow) => ({
  ...adminSummary(p),
  description: p.description,
  reviewedAt: p.reviewedAt,
  resolvedAt: p.resolvedAt,
  messages: p.messages.map(messageView),
});

const notFound = () => new AppException(404, 'PQRS_NOT_FOUND', 'The PQRS does not exist');
const invalidTransition = () => new AppException(409, 'PQRS_INVALID_TRANSITION', 'The PQRS cannot move to that state');
const tooLong = (field: string) => new AppException(400, 'VALIDATION_FAILED', 'Validation failed', { fields: { [field]: 'maxLength' } });

@Injectable()
export class PqrsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly outbox: OutboxService,
  ) {}

  async limits() {
    const [subjectMaxLength, descriptionMaxLength, responseMaxLength] = await Promise.all([
      this.settings.get('pqrs.subjectMaxLength'),
      this.settings.get('pqrs.descriptionMaxLength'),
      this.settings.get('pqrs.responseMaxLength'),
    ]);
    return { subjectMaxLength, descriptionMaxLength, responseMaxLength };
  }

  // A retry with the same `clientRequestId` returns the PQRS already filed (`created: false`).
  async create(authorId: string, dto: CreatePqrsDto) {
    const key = { authorId_clientRequestId: { authorId, clientRequestId: dto.clientRequestId } };
    const existing = await this.prisma.pqrs.findUnique({ where: key, include: WITH_TYPE });
    if (existing) return { created: false, pqrs: summary(existing) };

    const limits = await this.limits();
    if (dto.subject.length > limits.subjectMaxLength) throw tooLong('subject');
    if (dto.description.length > limits.descriptionMaxLength) throw tooLong('description');

    const type = await this.prisma.dropdownItem.findFirst({
      where: { id: dto.typeId, status: 'ACTIVE', deletedAt: null, list: { key: 'PQRS_TYPE' } },
      select: { id: true },
    });
    if (!type) throw new AppException(422, 'PQRS_TYPE_UNAVAILABLE', 'The PQRS type is not available');

    try {
      const created = await this.prisma.pqrs.create({
        data: { authorId, typeId: type.id, subject: dto.subject, description: dto.description, clientRequestId: dto.clientRequestId },
        include: WITH_TYPE,
      });
      return { created: true, pqrs: summary(created) };
    } catch (error) {
      // Two identical requests at once: the unique index let one through; answer with that one.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      return { created: false, pqrs: summary(await this.prisma.pqrs.findUniqueOrThrow({ where: key, include: WITH_TYPE })) };
    }
  }

  async listMine(authorId: string, { page, limit, status }: ListMinePqrsQuery) {
    const where: Prisma.PqrsWhereInput = { authorId, deletedAt: null, ...(status && { status }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.pqrs.findMany({
        where,
        include: WITH_TYPE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.pqrs.count({ where }),
    ]);
    return { data: rows.map(summary), meta: { page, limit, total } };
  }

  // A PQRS of another user is simply not found: the answer never reveals that it exists.
  async getMine(authorId: string, id: string) {
    const row = await this.prisma.pqrs.findFirst({ where: { id, authorId, deletedAt: null }, include: { ...WITH_TYPE, ...WITH_MESSAGES } });
    if (!row) throw notFound();
    return detail(row);
  }

  async listAll({ page, limit, status, typeId, authorRole }: ListPqrsQuery) {
    const where: Prisma.PqrsWhereInput = {
      deletedAt: null,
      ...(status && { status }),
      ...(typeId && { typeId }),
      ...(authorRole && { author: { role: authorRole } }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.pqrs.findMany({
        where,
        include: { ...WITH_TYPE, ...WITH_AUTHOR },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.pqrs.count({ where }),
    ]);
    return { data: rows.map(adminSummary), meta: { page, limit, total } };
  }

  async getOne(id: string) {
    const row = await this.prisma.pqrs.findFirst({
      where: { id, deletedAt: null },
      include: { ...WITH_TYPE, ...WITH_AUTHOR, ...WITH_MESSAGES },
    });
    if (!row) throw notFound();
    return adminDetail(row);
  }

  async review(id: string) {
    await this.prisma.$transaction(async (tx) => {
      if (!canTransition(await this.lock(tx, id), 'IN_REVIEW')) throw invalidTransition();
      await tx.pqrs.update({ where: { id }, data: { status: 'IN_REVIEW', reviewedAt: new Date() } });
      await this.outbox.record(tx, { type: 'PQRS_IN_REVIEW', pqrsId: id, payload: { pqrsId: id } });
    });
    return this.getOne(id);
  }

  async respond(id: string, authorId: string, body: string) {
    if (body.length > (await this.settings.get('pqrs.responseMaxLength'))) throw tooLong('body');
    return this.prisma.$transaction(async (tx) => {
      if (!canRespond(await this.lock(tx, id))) {
        throw new AppException(409, 'PQRS_NOT_IN_REVIEW', 'Only a PQRS in review can be answered');
      }
      const message = await tx.pqrsMessage.create({ data: { pqrsId: id, authorId, body } });
      await this.outbox.record(tx, { type: 'PQRS_RESPONDED', pqrsId: id, payload: { pqrsId: id } });
      return messageView(message);
    });
  }

  async resolve(id: string) {
    await this.prisma.$transaction(async (tx) => {
      const status = await this.lock(tx, id);
      if (!canTransition(status, 'RESOLVED')) throw invalidTransition();
      const replies = await tx.pqrsMessage.count({ where: { pqrsId: id, deletedAt: null } });
      if (!canResolve(status, replies)) {
        throw new AppException(409, 'PQRS_RESPONSE_REQUIRED', 'A PQRS needs at least one reply to be resolved');
      }
      await tx.pqrs.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
      await this.outbox.record(tx, { type: 'PQRS_RESOLVED', pqrsId: id, payload: { pqrsId: id } });
    });
    return this.getOne(id);
  }

  // The row stays locked until the transaction ends, so two CAE actions on one PQRS run one after the other.
  private async lock(tx: Prisma.TransactionClient, id: string): Promise<PqrsStatus> {
    const rows = await tx.$queryRaw<{ status: PqrsStatus }[]>`
      SELECT status FROM pqrs WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!rows[0]) throw notFound();
    return rows[0].status;
  }
}
