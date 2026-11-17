import { Global, Module } from '@nestjs/common';
import { ConfigUsageService } from './config-usage.service.js';

@Global()
@Module({ providers: [ConfigUsageService], exports: [ConfigUsageService] })
export class ConfigUsageModule {}
