// prisma.config.ts  (at project root)
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  // Prisma 7: datasource URL lives here
  datasource: {
    url: env("DATABASE_URL"),
  },
});
