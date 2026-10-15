import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { NOTIFICATIONS_QUEUE } from './queue.constants.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
        },
      }),
    }),
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
