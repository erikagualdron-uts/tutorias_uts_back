import { Injectable } from '@nestjs/common';

// Teacher and student summaries; filled in by user stories 2 and 3 of spec 019.
@Injectable()
export class PersonDashboardService {
  teacher(_userId: string) {
    return { nextSession: null, weekSessions: 0, modules: [] };
  }

  student(_userId: string) {
    return { nextSession: null, weekSessions: 0, changes: [] };
  }
}
