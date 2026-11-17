import { Injectable } from '@nestjs/common';

export interface RoomUsage {
  modulesInActivePeriod: number;
  modulesInUpcomingPeriods: number;
  maxEnrolled: number;
}

// Answers "is this record used by something else?" for the configuration rules.
// Modules and PQRS do not exist yet, so everything is unused. The modules and PQRS features
// replace these bodies with real queries; the rules that call them are already wired and tested.
@Injectable()
export class ConfigUsageService {
  countModulesInPeriod(_periodId: string): Promise<number> {
    return Promise.resolve(0);
  }

  getRoomUsage(_roomId: string): Promise<RoomUsage> {
    return Promise.resolve({ modulesInActivePeriod: 0, modulesInUpcomingPeriods: 0, maxEnrolled: 0 });
  }

  isDropdownItemInUse(_itemId: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}
