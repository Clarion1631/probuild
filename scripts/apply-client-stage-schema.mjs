// Adds ScheduleTask.clientStage — the manual override for which client-facing
// stage a task appears under on the portal tracker rail.
//
// Additive and idempotent: safe to run against prod while the old build is
// live. Run this BEFORE deploying the build that selects the column, or portal
// pages throw P2022 "column does not exist".
//
// Usage: node scripts/apply-client-stage-schema.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const STATEMENTS = [
    `ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "clientStage" TEXT;`,
];

async function main() {
    const url = process.env.DATABASE_URL ?? "";
    if (!url) throw new Error("DATABASE_URL is not set");
    console.log(`Applying to ${url.replace(/:[^:@]*@/, ":****@")}`);

    for (const sql of STATEMENTS) {
        console.log(`  ${sql}`);
        await prisma.$executeRawUnsafe(sql);
    }

    const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM information_schema.columns
          WHERE table_name = 'ScheduleTask' AND column_name = 'clientStage';`,
    );
    if (count !== 1) throw new Error(`Verification failed: clientStage column count = ${count}`);
    console.log("clientStage column verified.");
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
