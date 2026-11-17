import { Injectable } from '@nestjs/common';
import type { Prisma, Room } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { violatedConstraint } from '../common/db-errors.js';
import { AppException } from '../common/errors/app.exception.js';
import { ConfigUsageService } from '../config-usage/config-usage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateRoomDto, ListRoomsQuery, UpdateRoomDto } from './dto/room.dto.js';

const NAME_INDEX = 'rooms_name_per_location_unique_idx';

type RoomWithLocation = Room & { location: { name: string } };

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly usage: ConfigUsageService,
  ) {}

  async list(query: ListRoomsQuery) {
    const where: Prisma.RoomWhereInput = {
      deletedAt: null,
      ...(query.search && { name: { contains: query.search, mode: 'insensitive' } }),
      ...(query.locationId && { locationId: query.locationId }),
      ...(query.status && { status: query.status }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.room.findMany({
        where,
        include: { location: { select: { name: true } } },
        orderBy: [{ location: { name: 'asc' } }, { name: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.room.count({ where }),
    ]);
    return { data: rows.map(toView), meta: { page: query.page, limit: query.limit, total } };
  }

  async get(id: string) {
    return toView(await this.findOrFail(id));
  }

  async create(dto: CreateRoomDto) {
    assertCapacity(dto.capacity);
    await this.assertLocation(dto.locationId);
    await this.assertNameFree(dto.locationId, dto.name);
    try {
      const created = await this.prisma.room.create({
        data: { locationId: dto.locationId, name: dto.name, capacity: dto.capacity },
        include: { location: { select: { name: true } } },
      });
      return toView(created);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(id: string, dto: UpdateRoomDto) {
    const current = await this.findOrFail(id);
    if (dto.capacity !== undefined) {
      assertCapacity(dto.capacity);
      // FR-021: never below the students already enrolled in a module that uses the room
      const { maxEnrolled } = await this.usage.getRoomUsage(id);
      if (dto.capacity < maxEnrolled) {
        throw new AppException(409, 'ROOM_CAPACITY_BELOW_ENROLLED', 'Capacity is below the enrolled students', {
          maxEnrolled,
        });
      }
    }
    const locationId = dto.locationId ?? current.locationId;
    if (dto.locationId && dto.locationId !== current.locationId) await this.assertLocation(locationId);
    const name = dto.name ?? current.name;
    if (locationId !== current.locationId || name.toLowerCase() !== current.name.toLowerCase()) {
      await this.assertNameFree(locationId, name, id);
    }
    try {
      const updated = await this.prisma.room.update({
        where: { id },
        data: { locationId, name, capacity: dto.capacity },
        include: { location: { select: { name: true } } },
      });
      return toView(updated);
    } catch (error) {
      throw this.translate(error);
    }
  }

  impact(id: string) {
    return this.findOrFail(id).then(() => this.usage.getRoomUsage(id));
  }

  // D-074: only modules in the ACTIVE period block it; upcoming ones are reported by `impact`.
  async deactivate(id: string) {
    await this.assertNotInActivePeriod(id);
    return this.setStatus(id, 'INACTIVE');
  }

  async reactivate(id: string) {
    return this.setStatus(id, 'ACTIVE');
  }

  async remove(id: string) {
    await this.assertNotInActivePeriod(id);
    await this.prisma.room.update({ where: { id }, data: { deletedAt: this.clock.now() } });
  }

  private async setStatus(id: string, status: 'ACTIVE' | 'INACTIVE') {
    await this.findOrFail(id);
    const updated = await this.prisma.room.update({
      where: { id },
      data: { status },
      include: { location: { select: { name: true } } },
    });
    return toView(updated);
  }

  private async assertNotInActivePeriod(id: string) {
    await this.findOrFail(id);
    if ((await this.usage.getRoomUsage(id)).modulesInActivePeriod > 0) {
      throw new AppException(409, 'ROOM_IN_ACTIVE_PERIOD', 'The room has modules in the active period');
    }
  }

  private async findOrFail(id: string): Promise<RoomWithLocation> {
    const room = await this.prisma.room.findFirst({
      where: { id, deletedAt: null },
      include: { location: { select: { name: true } } },
    });
    if (!room) throw new AppException(404, 'NOT_FOUND', 'Room not found');
    return room;
  }

  private async assertLocation(locationId: string) {
    const location = await this.prisma.location.findFirst({ where: { id: locationId, deletedAt: null } });
    if (!location) throw new AppException(404, 'NOT_FOUND', 'Location not found');
  }

  private async assertNameFree(locationId: string, name: string, exceptId?: string) {
    const taken = await this.prisma.room.findFirst({
      where: {
        locationId,
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId && { id: { not: exceptId } }),
      },
    });
    if (taken) throw new AppException(409, 'ROOM_NAME_TAKEN', 'A room with that name already exists here');
  }

  private translate(error: unknown): unknown {
    return violatedConstraint(error, [NAME_INDEX])
      ? new AppException(409, 'ROOM_NAME_TAKEN', 'A room with that name already exists here')
      : error;
  }
}

function assertCapacity(capacity: number) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new AppException(422, 'ROOM_CAPACITY_INVALID', 'Capacity must be a positive whole number');
  }
}

function toView(room: RoomWithLocation) {
  return {
    id: room.id,
    locationId: room.locationId,
    locationName: room.location.name,
    name: room.name,
    capacity: room.capacity,
    status: room.status,
  };
}
