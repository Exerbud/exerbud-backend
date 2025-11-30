// lib/prisma.js
import { PrismaClient } from '@prisma/client';

let globalForPrisma = globalThis;
const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export { prisma };
