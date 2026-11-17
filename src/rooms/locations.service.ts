import { Injectable } from '@nestjs/common';
import type { Location } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { violatedConstraint } from '../common/db-errors.js';
import { AppException } from '../common/errors/app.exception.js';
import type { PageQuery } from '../common/page-query.js';
import { ConfigUsageService } from '../config-usage/config-usage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LocationInputDto } from './dto/room.dto.js';

const NAME_INDEX = 'locations_name_unique_idx';

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly usage: ConfigUsageService,
  ) {}

  async list(query: PageQuery) {
    const where = { deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.location.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.location.count({ where }),
    ]);
    const data = await Promise.all(rows.map((row) => this.toView(row)));
    return { data, meta: { page: query.page, limit: query.limit, total } };
  }

  async get(id: string) {
    return this.toView(await this.findOrFail(id));
  }

  async create(dto: LocationInputDto) {
    await this.assertNameFree(dto.name);
    try {
      return this.toView(await this.prisma.location.create({ data: { name: dto.name } }));
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(id: string, dto: LocationInputDto) {
    await this.findOrFail(id);
    await this.assertNameFree(dto.name, id);
    try {
      return this.toView(await this.prisma.location.update({ where: { id }, data: { name: dto.name } }));
    } catch (error) {
      throw this.translate(error);
    }
  }

  // D-075: with no active rooms, the location and its inactive rooms are deleted together.
  async remove(id: string) {
    await this.findOrFail(id);
    await this.prisma.$transaction(async (tx) => {
      const rooms = await tx.room.findMany({ where: { locationId: id, deletedAt: null } });
      if (rooms.some((room) => room.status === 'ACTIVE')) {
        throw new AppException(409, 'LOCATION_HAS_ACTIVE_ROOMS', 'The location has active rooms');
      }
      for (const room of rooms) {
        if ((await this.usage.getRoomUsage(room.id)).modulesInActivePeriod > 0) {
          throw new AppException(409, 'ROOM_IN_ACTIVE_PERIOD', 'A room has modules in the active period');
        }
      }
      const now = this.clock.now();
      await tx.room.updateMany({ where: { locationId: id, deletedAt: null }, data: { deletedAt: now } });
      await tx.location.update({ where: { id }, data: { deletedAt: now } });
    });
  }

  private async findOrFail(id: string) {
    const location = await this.prisma.location.findFirst({ where: { id, deletedAt: null } });
    if (!location) throw new AppException(404, 'NOT_FOUND', 'Location not found');
    return location;
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const taken = await this.prisma.location.findFirst({
      where: {
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId && { id: { not: exceptId } }),
      },
    });
    if (taken) throw new AppException(409, 'LOCATION_NAME_TAKEN', 'A location with that name already exists');
  }

  private translate(error: unknown): unknown {
    return violatedConstraint(error, [NAME_INDEX])
      ? new AppException(409, 'LOCATION_NAME_TAKEN', 'A location with that name already exists')
      : error;
  }

  private async toView(location: Location) {
    const grouped = await this.prisma.room.groupBy({
      by: ['status'],
      where: { locationId: location.id, deletedAt: null },
      _count: { _all: true },
    });
    const count = (status: 'ACTIVE' | 'INACTIVE') =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;
    return {
      id: location.id,
      name: location.name,
      roomCounts: { active: count('ACTIVE'), inactive: count('INACTIVE') },
    };
  }
}
