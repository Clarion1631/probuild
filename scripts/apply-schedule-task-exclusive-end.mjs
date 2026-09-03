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
//   node scripts/apply-schedule-task-exclusive-end.mjs --yes     (apply the legacy repair)
//   node scripts/apply-schedule-task-exclusive-end.mjs --yes --extend <id>:<shownEnd>,<id>:<shownEnd>
//                                                              (also extend reviewed rows; tokens come from the dry-run review list)
//
// Idempotent: re-running after a successful apply finds zero matching rows.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lead schedule tasks live in the same table with projectId = NULL and keep
// INCLUSIVE dates (createLeadScheduleTask / updateLeadScheduleTask). Every
// statement here is scoped to project tasks only.
export const SELECT_LEGACY_ROWS = `
    SELECT "id", "name", "projectId", "startDate", "endDate"
    FROM "ScheduleTask"
    WHERE "projectId" IS NOT NULL AND "type" <> 'milestone' AND "endDate" <= "startDate"
    ORDER BY "startDate" ASC`;

export const UPDATE_LEGACY_ROWS = `
    UPDATE "ScheduleTask"
    SET "endDate" = "startDate" + interval '1 day', "updatedAt" = NOW()
    WHERE "projectId" IS NOT NULL AND "type" <> 'milestone' AND "endDate" <= "startDate"`;

// Milestones store end == start (schedule-task-core forces it on every update;
// the estimate/change-order generators used to write start + 1 day).
export const SELECT_MILESTONE_ROWS = `
    SELECT "id", "name", "projectId", "startDate", "endDate"
    FROM "ScheduleTask"
    WHERE "projectId" IS NOT NULL AND "type" = 'milestone' AND "endDate" <> "startDate"
    ORDER BY "startDate" ASC`;

export const UPDATE_MILESTONE_ROWS = `
    UPDATE "ScheduleTask"
    SET "endDate" = "startDate", "updatedAt" = NOW()
    WHERE "projectId" IS NOT NULL AND "type" = 'milestone' AND "endDate" <> "startDate"`;

// Human-curated correction for multi-day tasks whose End was typed into the
// old inclusive Calendar view: `--extend <id>:<shownEnd>,...` adds one day to
// exactly those rows, and only while the row still shows that End
// (compare-and-set on the stored end = shownEnd + 1 day). Re-running is a
// no-op because the predicate no longer matches; a row edited since the
// review fails the whole transaction. Milestones and lead tasks are never
// touched.
export const EXTEND_ROW = `
    UPDATE "ScheduleTask"
    SET "endDate" = "endDate" + interval '1 day', "updatedAt" = NOW()
    WHERE "id" = $1
      AND "projectId" IS NOT NULL
      AND "type" <> 'milestone'
      AND "endDate" = ($2::date + interval '1 day')`;

// Review list, printed in dry run: every current or upcoming task with a real
// span (a two-day inclusive entry has a one-day stored difference, so the
// predicate is end > start, not end > start + 1). A task whose dates were
// last typed into the old Calendar view (inclusive) now displays one day
// shorter; nothing in the row says which surface wrote it, so these are
// listed per project for a human to eyeball rather than guessed at.
export const SELECT_REVIEW_ROWS = `
    SELECT t."id", t."name", p."name" AS "projectName", t."startDate", t."endDate"
    FROM "ScheduleTask" t
    JOIN "Project" p ON p."id" = t."projectId"
    WHERE t."projectId" IS NOT NULL
      AND t."type" <> 'milestone'
      AND t."endDate" > t."startDate"
      AND t."endDate" >= now() - interval '7 days'
    ORDER BY p."name" ASC, t."startDate" ASC`;

export const SELECT_TASK_END = `SELECT "endDate" FROM "ScheduleTask" WHERE "id" = $1`;

function addDaysKey(key, days) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

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

        const milestones = await prisma.$queryRawUnsafe(SELECT_MILESTONE_ROWS);
        console.log(`found ${milestones.length} milestone(s) with "endDate" <> "startDate" (will be set to start)`);

        const review = await prisma.$queryRawUnsafe(SELECT_REVIEW_ROWS);
        console.log(`\nreview: ${review.length} current/upcoming multi-day task(s). If a task's End was last set in the Calendar view before 2026-09-03, its shown End is now one day earlier than intended. Re-run with --extend <token,token,...> using the tokens below for the ones a human confirms:`);
        for (const row of review) {
            const shownEnd = new Date(row.endDate.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            console.log(`  ${row.id}:${shownEnd}  ${row.projectName}  |  ${row.name}  |  ${row.startDate.toISOString().slice(0, 10)} to ${shownEnd} (shown)`);
        }

        const extendIdx = process.argv.indexOf("--extend");
        const extendTokens = extendIdx >= 0 && process.argv[extendIdx + 1]
            ? process.argv[extendIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
            : [];
        const extendPairs = extendTokens.map((token) => {
            const [id, shownEnd] = token.split(":");
            if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(shownEnd ?? "")) {
                throw new Error(`--extend token "${token}" must look like <taskId>:<YYYY-MM-DD shown end> (copy it from the review list)`);
            }
            return { id, shownEnd };
        });

        if (!APPLY) {
            if (extendPairs.length) console.log(`would extend ${extendPairs.length} task(s) by one day: ${extendPairs.map((p) => p.id).join(", ")}`);
            console.log("dry run — pass --yes to apply");
            return;
        }

        const { applied, milestonesFixed, extended } = await prisma.$transaction(async (tx) => {
            const applied = await tx.$executeRawUnsafe(UPDATE_LEGACY_ROWS);
            const milestonesFixed = await tx.$executeRawUnsafe(UPDATE_MILESTONE_ROWS);
            let extended = 0;
            for (const { id, shownEnd } of extendPairs) {
                const n = await tx.$executeRawUnsafe(EXTEND_ROW, id, shownEnd);
                if (n === 1) { extended += 1; continue; }
                // Zero rows: either this token was already applied (a rerun, fine)
                // or the row was edited since the review (refuse the whole batch).
                const current = await tx.$queryRawUnsafe(SELECT_TASK_END, id);
                const storedEnd = current[0]?.endDate?.toISOString().slice(0, 10);
                const alreadyExtended = storedEnd === addDaysKey(shownEnd, 2);
                if (!alreadyExtended) {
                    throw new Error(`Refusing: task ${id} no longer shows End ${shownEnd} (edited since review; stored end ${storedEnd ?? "missing"}). Nothing was applied.`);
                }
                console.log(`  ${id} already extended past ${shownEnd}; skipping`);
            }
            return { applied, milestonesFixed, extended };
        });
        console.log(`applied: ${applied} rows`);
        console.log(`applied: ${milestonesFixed} milestone(s) normalized to end == start`);
        if (extendPairs.length) console.log(`extended: ${extended} task(s) by one day`);
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
