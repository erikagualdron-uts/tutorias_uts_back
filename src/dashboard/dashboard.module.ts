import { Module } from '@nestjs/common';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { DashboardController } from './dashboard.controller.js';
import { PersonDashboardService } from './person-dashboard.service.js';

@Module({ controllers: [DashboardController], providers: [AdminDashboardService, PersonDashboardService] })
export class DashboardModule {}
