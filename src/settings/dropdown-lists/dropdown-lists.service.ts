import { Injectable } from '@nestjs/common';
import type { DropdownItem, DropdownList } from '@prisma/client';
import { Clock } from '../../common/clock.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ConfigUsageService } from '../../config-usage/config-usage.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CreateDropdownItemDto,
  UpdateDropdownItemDto,
} from './dto/dropdown-item.dto.js';

const ALIVE = { deletedAt: null };
const IN_ORDER = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];

@Injectable()
export class DropdownListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly usage: ConfigUsageService,
  ) {}

  async lists() {
    const lists = await this.prisma.dropdownList.findMany({
      orderBy: { nameEs: 'asc' },
      include: { _count: { select: { items: { where: ALIVE } } } },
    });
    return lists.map((list) => ({
      key: list.key,
      nameEs: list.nameEs,
      nameEn: list.nameEn,
      itemCount: list._count.items,
    }));
  }

  // Admin view: active and inactive items, each marked when something uses it.
  async detail(key: string) {
    const list = await this.findList(key);
    const items = await this.prisma.dropdownItem.findMany({
      where: { listId: list.id, ...ALIVE },
      orderBy: IN_ORDER,
    });
    return {
      key: list.key,
      nameEs: list.nameEs,
      nameEn: list.nameEn,
      items: await Promise.all(items.map((item) => this.toView(item))),
    };
  }

  // What selectors show: only active items, in the defined order (FR-028).
  async activeItems(key: string) {
    const list = await this.findList(key);
    const items = await this.prisma.dropdownItem.findMany({
      where: { listId: list.id, status: 'ACTIVE', ...ALIVE },
      orderBy: IN_ORDER,
    });
    return items.map(toPublicView);
  }

  async createItem(key: string, dto: CreateDropdownItemDto) {
    const list = await this.findList(key);
    assertLabels(dto.labelEs, dto.labelEn);
    const last = await this.prisma.dropdownItem.aggregate({
      where: { listId: list.id, ...ALIVE },
      _max: { sortOrder: true },
    });
    const created = await this.prisma.dropdownItem.create({
      data: {
        listId: list.id,
        labelEs: dto.labelEs,
        labelEn: dto.labelEn,
        sortOrder: (last._max.sortOrder ?? 0) + 1,
      },
    });
    return this.toView(created);
  }

  async updateItem(key: string, itemId: string, dto: UpdateDropdownItemDto) {
    const item = await this.findItem(key, itemId);
    assertLabels(dto.labelEs ?? item.labelEs, dto.labelEn ?? item.labelEn);
    const updated = await this.prisma.dropdownItem.update({
      where: { id: itemId },
      data: { labelEs: dto.labelEs, labelEn: dto.labelEn, status: dto.status },
    });
    return this.toView(updated);
  }

  // The request must name every item of the list exactly once.
  async reorder(key: string, itemIds: string[]) {
    const list = await this.findList(key);
    const current = await this.prisma.dropdownItem.findMany({
      where: { listId: list.id, ...ALIVE },
      select: { id: true },
    });
    const same =
      current.length === itemIds.length &&
      current.every((item) => itemIds.includes(item.id));
    if (!same) {
      throw new AppException(422, 'DROPDOWN_ORDER_INVALID', 'The order does not match the list items');
    }
    await this.prisma.$transaction(
      itemIds.map((id, index) =>
        this.prisma.dropdownItem.update({ where: { id }, data: { sortOrder: index + 1 } }),
      ),
    );
    return this.detail(key);
  }

  // An item in use can only be deactivated (FR-027).
  async removeItem(key: string, itemId: string) {
    const item = await this.findItem(key, itemId);
    if (await this.usage.isDropdownItemInUse(item.id)) {
      throw new AppException(409, 'DROPDOWN_ITEM_IN_USE', 'The item is in use and can only be deactivated');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.dropdownItem.update({ where: { id: itemId }, data: { deletedAt: this.clock.now() } });
      // Keep the order 1..n without holes
      const rest = await tx.dropdownItem.findMany({
        where: { listId: item.listId, ...ALIVE },
        orderBy: IN_ORDER,
        select: { id: true },
      });
      for (const [index, { id }] of rest.entries()) {
        await tx.dropdownItem.update({ where: { id }, data: { sortOrder: index + 1 } });
      }
    });
  }

  private async findList(key: string): Promise<DropdownList> {
    const list = await this.prisma.dropdownList.findUnique({ where: { key } });
    if (!list) throw new AppException(404, 'NOT_FOUND', 'List not found');
    return list;
  }

  private async findItem(key: string, itemId: string) {
    const list = await this.findList(key);
    const item = await this.prisma.dropdownItem.findFirst({
      where: { id: itemId, listId: list.id, ...ALIVE },
    });
    if (!item) throw new AppException(404, 'NOT_FOUND', 'Item not found');
    return item;
  }

  private async toView(item: DropdownItem) {
    return { ...toPublicView(item), inUse: await this.usage.isDropdownItemInUse(item.id) };
  }
}

function assertLabels(labelEs: string, labelEn: string) {
  if (!labelEs.trim() || !labelEn.trim()) {
    throw new AppException(422, 'DROPDOWN_LABEL_REQUIRED', 'Both labels are required');
  }
}

function toPublicView(item: DropdownItem) {
  return {
    id: item.id,
    labelEs: item.labelEs,
    labelEn: item.labelEn,
    sortOrder: item.sortOrder,
    status: item.status,
  };
}
