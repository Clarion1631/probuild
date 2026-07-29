// Idempotently creates the nonschedulable attribution row used by Richard's
// MCP connector. This script does not create auth credentials or permissions.
//
// Run only through release orchestration:
//   node scripts/seed-richard-ai-user.mjs
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

const RICHARD_AI_EMAIL = "richard-ai@goldentouchremodeling.com";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

try {
  const user = await prisma.user.upsert({
    where: { email: RICHARD_AI_EMAIL },
    update: {
      name: "Richard's AI",
      status: "ACTIVATED",
      role: "FINANCE",
    },
    create: {
      email: RICHARD_AI_EMAIL,
      name: "Richard's AI",
      status: "ACTIVATED",
      role: "FINANCE",
    },
    select: { id: true, email: true, name: true, status: true, role: true },
  });
  console.log("Richard AI attribution user ready:", user);
} catch (error) {
  console.error("Richard AI attribution seed failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
