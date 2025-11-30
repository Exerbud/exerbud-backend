// prisma/prisma.config.ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  // In Prisma 7 the datasource URL lives here (not in schema.prisma)
  datasource: {
    url: env("DATABASE_URL"),
  },
});
