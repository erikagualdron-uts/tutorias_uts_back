import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { PageQuery } from '../../common/page-query.js';

export class NotificationsQueryDto extends PageQuery {}

export const DEVICE_PLATFORMS = ['ANDROID', 'IOS'] as const;

export class RegisterDeviceDto {
  // Expo token of the device: `ExponentPushToken[...]` (or the newer `ExpoPushToken[...]`).
  @IsString()
  @MaxLength(200)
  @Matches(/^Expo(nent)?PushToken\[.+\]$/)
  token!: string;

  @IsIn(DEVICE_PLATFORMS)
  platform!: (typeof DEVICE_PLATFORMS)[number];
}
