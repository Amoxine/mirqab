import { Module } from '@nestjs/common';
import { SettingsController } from './controllers/settings.controller';
import { SettingsService } from './services/settings.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class SettingsModule {}
