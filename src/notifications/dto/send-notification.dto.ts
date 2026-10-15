import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SendNotificationDto {
  @IsIn(['email', 'websocket'])
  channel!: 'email' | 'websocket';

  @IsString()
  @IsNotEmpty()
  recipient!: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsString()
  @IsNotEmpty()
  body!: string;
}
