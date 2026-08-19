// Seeds the company-wide "32-SAFETY" / "Safety Meeting" cost code — the phase
// the crew clocks in against for a job-site safety meeting. Safety meetings are
// never an estimate line item (they're overhead, not a bid line), so the phase
// is appended to a project's picker list rather than discovered from estimate
// items; see src/lib/project-phases.ts (SAFETY_COST_CODE).
//
// Additive + idempotent (INSERT ... ON CONFLICT DO NOTHING on the unique
// `code`) — safe to re-run, and safe while the previous build is live. No
// deletes, no drops, no destructive rewrites, and it deliberately does NOT
// touch an existing 32-SAFETY row (so a hand-edited name/description survives).
//
// 2026-08-18: the number is 32 because prod's CostCode table already runs
// 01..31 with no gaps (22-DESIGN, 23-SITEWORK, 25-FIREPLACE, 31-LOGISTICS, ...),
// so 32 is the genuine next free slot.
//
// Run BEFORE deploying the build that ships the phase-only clock-in (see the
// pre-deploy checklist in CLAUDE.md):
//   node scripts/apply-safety-cost-code.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const SAFETY_CODE = "32-SAFETY";
const SAFETY_NAME = "Safety Meeting";
const SAFETY_DESCRIPTION = "Job-site safety meeting / toolbox talk";

try {
    // Guard: if SAFETY_CODE's number is already taken by a DIFFERENT code, stop
    // rather than seeding a confusing duplicate — a human picks the next free
    // number and updates SAFETY_COST_CODE in src/lib/project-phases.ts.
    // Derived from SAFETY_CODE rather than hardcoded, so changing the constant
    // above can never leave this guard checking the wrong prefix (it did once).
    const numberPrefix = `${SAFETY_CODE.split("-")[0]}-`;
    const collision = await prisma.$queryRawUnsafe(
        `SELECT "code", "name" FROM "CostCode" WHERE "code" LIKE $1 AND "code" <> $2`,
        `${numberPrefix}%`,
        SAFETY_CODE
    );
    if (Array.isArray(collision) && collision.length > 0) {
        console.error(`ABORT: the ${numberPrefix} prefix is already used by:`, collision);
        console.error("Pick the next free number and update SAFETY_COST_CODE in src/lib/project-phases.ts.");
        process.exit(1);
    }

    const inserted = await prisma.$executeRawUnsafe(
        `INSERT INTO "CostCode" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, true, NOW(), NOW())
         ON CONFLICT ("code") DO NOTHING`,
        randomUUID(),
        SAFETY_CODE,
        SAFETY_NAME,
        SAFETY_DESCRIPTION
    );
    console.log(inserted > 0 ? `OK: created cost code ${SAFETY_CODE}` : `OK: ${SAFETY_CODE} already exists — no change`);

    // Re-activating is safe and idempotent: a deactivated safety code would
    // silently drop the phase out of every picker (getSafetyCostCode filters on
    // isActive), which is never the intent of running this script.
    await prisma.$executeRawUnsafe(`UPDATE "CostCode" SET "isActive" = true WHERE "code" = $1 AND "isActive" = false`, SAFETY_CODE);

    console.log("\nSafety Meeting cost code applied successfully.");
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
