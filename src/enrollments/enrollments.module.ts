import { Module } from '@nestjs/common';
import { PeriodsModule } from '../periods/periods.module.js';
import { EnrollmentsController } from './enrollments.controller.js';
import { EnrollmentsService } from './enrollments.service.js';
import { OfferService } from './offer.service.js';

@Module({
  imports: [PeriodsModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService, OfferService],
})
export class EnrollmentsModule {}
