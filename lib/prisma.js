// lib/prisma.js
// Shared PrismaClient instance for Exerbud backend

const { PrismaClient } = require("@prisma/client");

let prisma;

// Avoid creating too many clients in dev (Next/Vercel hot reload)
if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  if (!global.__exerbudPrisma) {
    global.__exerbudPrisma = new PrismaClient();
  }
  prisma = global.__exerbudPrisma;
}

module.exports = prisma;
