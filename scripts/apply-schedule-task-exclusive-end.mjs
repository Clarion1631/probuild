// Backfill for the schedule end-date sweep (src/lib/schedule-dates.ts):
// ScheduleTask.endDate is now EXCLUSIVE (the day after the last day of work)
// for every non-milestone row. Rows created before that convention was
// enforced can still hold end <= start (a legacy zero/negative-length task) —
// this script finds and repairs them.
//
// Default is DRY RUN: prints the rows that would change. Pass --yes to apply
// the UPDATE for real, inside a transaction.
//
//   node scripts/apply-schedule-task-exclusive-end.mjs           (dry run)
//   node scripts/apply-schedule-task-exclusive-end.mjs --yes     (apply)
//
// Idempotent: re-running after a successful apply finds zero matching rows.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SELECT_LEGACY_ROWS = `
    SELECT "id", "name", "projectId", "startDate", "endDate"
    FROM "ScheduleTask"
    WHERE "type" <> 'milestone' AND "endDate" <= "startDate"
    ORDER BY "startDate" ASC`;

export const UPDATE_LEGACY_ROWS = `
    UPDATE "ScheduleTask"
    SET "endDate" = "startDate" + interval '1 day'
    WHERE "type" <> 'milestone' AND "endDate" <= "startDate"`;

const APPLY = process.argv.includes("--yes");

async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing?).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
        const rows = await prisma.$queryRawUnsafe(SELECT_LEGACY_ROWS);
        console.log(`found ${rows.length} row(s) with type <> 'milestone' AND "endDate" <= "startDate"`);
        for (const row of rows) {
            console.log(
                `  ${row.id}  ${row.name}  project=${row.projectId}  start=${row.startDate.toISOString().slice(0, 10)}  end=${row.endDate.toISOString().slice(0, 10)}`,
            );
        }

        if (!APPLY) {
            console.log("dry run — pass --yes to apply");
            return;
        }

        const applied = await prisma.$transaction(async (tx) => {
            return tx.$executeRawUnsafe(UPDATE_LEGACY_ROWS);
        });
        console.log(`applied: ${applied} rows`);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
