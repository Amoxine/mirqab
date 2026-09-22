import { Global, Module } from '@nestjs/common';
import { prisma } from '@open-gateway/database';

/**
 * Global module providing a singleton PrismaClient instance.
 * All services should inject PrismaClient from this module
 * instead of creating their own instances.
 *
 * @see https://www.prisma.io/docs/guides/performance-and-optimization/connection-management
 */
@Global()
@Module({
  providers: [
    {
      provide: 'PRISMA_CLIENT',
      useValue: prisma,
    },
  ],
  exports: ['PRISMA_CLIENT'],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DatabaseModule {}
