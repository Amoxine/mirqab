import { PrismaClient } from '@prisma/client';

// Singleton pattern — single PrismaClient instance across the app
// Prevents connection pool exhaustion in development (hot reload)

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma's own stdout logging. It used to request `emit: 'event'` for query/error/warn in
// development and then register a listener for `query` only, so every Prisma error and warning was
// emitted into the void while each successful query printed its full SQL (including the analytics
// DDL block) to the API log. Add 'query' here when you actually want to read the SQL.
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Graceful shutdown
async function gracefulShutdown() {
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('beforeExit', gracefulShutdown);

export default prisma;
