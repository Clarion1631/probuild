// Adds ScheduleTask.clientStage — the manual override for which client-facing
// stage a task appears under on the portal tracker rail.
//
// Additive and idempotent: safe to run against prod while the old build is
// live. Run this BEFORE deploying the build that selects the column, or portal
// pages throw P2022 "column does not exist".
//
// Usage: node scripts/apply-client-stage-schema.mjs
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Same resolution the sibling apply-*.mjs scripts use: env first, then the
// checked-out .env files, since these are run by hand rather than by Next.
function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env", ".env.local"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in env or .env files");
}

let url;
let prisma;

const STATEMENTS = [
    `ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "clientStage" TEXT;`,
];

async function main() {
    url = resolveDatabaseUrl();
    prisma = new PrismaClient({ datasources: { db: { url } } });

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

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main()
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        })
        .finally(() => prisma?.$disconnect());
}
