// Additive, idempotent schema application for project inspection records.
//
// Run before a production build that reads prisma.inspection:
//   node scripts/apply-inspections-schema.mjs --yes --expect-db <database> --expect-host <host>
//
// This deliberately does NOT use prisma migrate/db push. See CLAUDE.md.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function readFlag(flag) {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function databaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

function masked(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

function expectedTarget(url) {
    const parsed = new URL(url);
    return { db: decodeURIComponent(parsed.pathname.replace(/^\//, "")), host: parsed.hostname };
}

const statements = [
    `CREATE TABLE IF NOT EXISTS "Inspection" (
        "id" TEXT NOT NULL,
        "projectId" TEXT NOT NULL,
        "permitId" TEXT,
        "type" TEXT NOT NULL,
        "scheduledDate" TIMESTAMPTZ(6),
        "performedDate" TIMESTAMPTZ(6),
        "result" TEXT NOT NULL DEFAULT 'SCHEDULED',
        "inspector" TEXT,
        "notes" TEXT,
        "customerNote" TEXT,
        "sharedToPortal" BOOLEAN NOT NULL DEFAULT false,
        "scheduleTaskId" TEXT,
        "createdById" TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ(6) NOT NULL,
        CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "Inspection_projectId_result_idx" ON "Inspection" ("projectId", "result")`,
    `CREATE INDEX IF NOT EXISTS "Inspection_projectId_sharedToPortal_result_idx" ON "Inspection" ("projectId", "sharedToPortal", "result")`,
    `CREATE INDEX IF NOT EXISTS "Inspection_permitId_idx" ON "Inspection" ("permitId")`,
    `CREATE INDEX IF NOT EXISTS "Inspection_scheduleTaskId_idx" ON "Inspection" ("scheduleTaskId")`,
    `CREATE INDEX IF NOT EXISTS "Inspection_createdById_idx" ON "Inspection" ("createdById")`,
    // Prisma's @updatedAt is application-managed, so a database default would
    // diverge from a database created by the committed migration history.
    `ALTER TABLE "Inspection" ALTER COLUMN "updatedAt" DROP DEFAULT`,
    // Server-only table: no policies means Supabase's exposed Data API denies
    // anon/authenticated reads even though Prisma can use the owner pool.
    `ALTER TABLE "Inspection" ENABLE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Inspection_result_check' AND conrelid = to_regclass('public."Inspection"')) THEN
            ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_result_check"
                CHECK ("result" IN ('SCHEDULED', 'PASSED', 'FAILED', 'PARTIAL'));
        END IF;
    END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Inspection_required_date_check' AND conrelid = to_regclass('public."Inspection"')) THEN
            ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_required_date_check" CHECK (
                ("result" = 'SCHEDULED' AND "scheduledDate" IS NOT NULL)
                OR ("result" IN ('PASSED', 'FAILED', 'PARTIAL') AND "performedDate" IS NOT NULL)
            );
        END IF;
    END $$`,
    `DO $$ BEGIN
        IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public."Inspection"')
              AND conname IN (
                  'Inspection_projectId_fkey', 'Inspection_permitId_fkey',
                  'Inspection_scheduleTaskId_fkey', 'Inspection_createdById_fkey'
              )
              AND confupdtype <> 'c'
        ) THEN
            ALTER TABLE "Inspection"
                DROP CONSTRAINT IF EXISTS "Inspection_projectId_fkey",
                DROP CONSTRAINT IF EXISTS "Inspection_permitId_fkey",
                DROP CONSTRAINT IF EXISTS "Inspection_scheduleTaskId_fkey",
                DROP CONSTRAINT IF EXISTS "Inspection_createdById_fkey";
        END IF;
    END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Inspection_projectId_fkey' AND conrelid = to_regclass('public."Inspection"')) THEN
            ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_fkey"
                FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
    END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Inspection_permitId_fkey' AND conrelid = to_regclass('public."Inspection"')) THEN
            ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_permitId_fkey"
                FOREIGN KEY ("permitId") REFERENCES "Permit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
    END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Inspection_scheduleTaskId_fkey' AND conrelid = to_regclass('public."Inspection"')) THEN
            ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_scheduleTaskId_fkey"
                FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
    END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Inspection_createdById_fkey' AND conrelid = to_regclass('public."Inspection"')) THEN
            ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_createdById_fkey"
                FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
    END $$`,
];

async function main() {
    if (process.argv.includes("--help")) {
        console.log("Usage: node scripts/apply-inspections-schema.mjs --yes --expect-db <database> --expect-host <host>");
        return;
    }
    if (!process.argv.includes("--yes")) throw new Error("Refusing schema change without --yes");
    const expectDb = readFlag("--expect-db");
    const expectHost = readFlag("--expect-host");
    if (!expectDb || !expectHost) throw new Error("--expect-db and --expect-host are both required");

    const url = databaseUrl();
    const actual = expectedTarget(url);
    if (actual.db !== expectDb || actual.host !== expectHost) {
        throw new Error(`Refusing target db=${actual.db} host=${actual.host}; expected db=${expectDb} host=${expectHost}`);
    }

    console.log(`Applying inspections schema to ${masked(url)}`);
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
        for (const statement of statements) await prisma.$executeRawUnsafe(statement);
        const expectedConstraints = [
            "Inspection_result_check",
            "Inspection_required_date_check",
            "Inspection_projectId_fkey",
            "Inspection_permitId_fkey",
            "Inspection_scheduleTaskId_fkey",
            "Inspection_createdById_fkey",
        ];
        const verification = await prisma.$queryRawUnsafe(`
            SELECT
                (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public."Inspection"')) AS "rlsEnabled",
                ARRAY(SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('public."Inspection"') ORDER BY conname) AS "constraints"
        `);
        const row = Array.isArray(verification) ? verification[0] : null;
        const constraints = Array.isArray(row?.constraints) ? row.constraints : [];
        if (row?.rlsEnabled !== true || expectedConstraints.some(name => !constraints.includes(name))) {
            throw new Error("Inspection schema postflight verification failed");
        }
        console.log("Inspection schema applied successfully.");
    } finally {
        await prisma.$disconnect();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
