// One-time (and re-runnable) backfill for Justin's rule: every ACTIVATED
// FIELD_CREW user, plus CJ, is on the crew of every "In Progress" project.
//
//   node scripts/backfill-crew-assignments.mjs            # apply
//   node scripts/backfill-crew-assignments.mjs --dry-run  # report only, no writes
//
// The ONGOING enforcement is in src/lib/crew-auto-assign-sync.ts, hooked into
// the project-status and user role/status write paths. This script exists only
// to catch up the projects and users that already existed before that shipped.
//
// SAFETY / IDEMPOTENCY:
//   - Purely ADDITIVE. It only ever `connect`s users to projects. It never
//     disconnects anybody, so a crew member added by hand is never removed.
//   - Diffs against each project's current crew and writes only the missing
//     links, so a second run reports 0 changes and issues 0 writes.
//   - No DDL. Project.crew is the existing many-to-many join table
//     (Prisma relation "CrewAssignments") — no schema change is involved.
//   - Never touches ProjectAccess. That is the narrower, admin-curated
//     per-user page-access ACL maintained by the Team Access screen; widening
//     crew is enough (accessibleProjectIds in src/lib/access-rules.ts unions
//     crew assignments with ProjectAccess).
//
// The eligibility rule is intentionally duplicated in plain JS below rather
// than imported: scripts/*.mjs run under bare node with no TS transform or
// "@/..." alias resolution (same reason every other script here re-states its
// constants). tests/crew-auto-assign.test.ts pins the TS implementation, and
// this file is checked against it by tests/backfill-crew-assignments.test.ts.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env.local the same way every other script in this folder does. Without
// this the script dies with "Environment variable not found: DATABASE_URL" —
// `next dev`/`next build` inject .env.local for the app, but a bare `node
// scripts/*.mjs` gets nothing, so a script that skips this only ever works when
// the operator happens to have DATABASE_URL exported.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const TARGET_STATUS = "In Progress";     // src/lib/project-status.ts
const ELIGIBLE_ROLE = "FIELD_CREW";      // ROLE_LABELS, src/lib/permissions.ts
const ELIGIBLE_USER_STATUS = "ACTIVATED"; // STATUS_LABELS, src/lib/permissions.ts

// Mirrors DEFAULT_ALWAYS_ASSIGN_KEYS in src/lib/crew-auto-assign.ts. CJ is a
// MANAGER/ADMIN, so the role rule alone would never reach him; there is no
// CJ-specific column in the schema, so we match on name (case- and
// punctuation-insensitively). Override with CREW_AUTO_ASSIGN_ALWAYS as a
// comma-separated list of emails and/or names.
const ALWAYS_ASSIGN_KEYS = process.env.CREW_AUTO_ASSIGN_ALWAYS != null
    ? process.env.CREW_AUTO_ASSIGN_ALWAYS.split(",").map((k) => k.trim()).filter(Boolean)
    : ["CJ"];

const normalize = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const compact = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function nameMatchesAlwaysKey(name, key) {
    const n = normalize(name);
    if (!n) return false;
    const k = normalize(key);
    const kc = compact(key);
    if (!k && !kc) return false;
    if (n === k) return true;
    if (kc && compact(name) === kc) return true;
    const tokens = n.split(" ");
    if (k && tokens.includes(k)) return true;
    if (kc && tokens.some((t) => compact(t) === kc)) return true;
    return false;
}

function isAlwaysAssignUser(user) {
    const email = normalize(user.email);
    return ALWAYS_ASSIGN_KEYS.some((key) => {
        const k = normalize(key);
        if (!k) return false;
        if (k.includes("@")) return !!email && email === k;
        return nameMatchesAlwaysKey(user.name, key);
    });
}

function shouldAutoAssignUser(user) {
    // Hard gate for everyone, including the always-assign names.
    if (String(user.status ?? "") !== ELIGIBLE_USER_STATUS) return false;
    if (String(user.role ?? "") === ELIGIBLE_ROLE) return true;
    return isAlwaysAssignUser(user);
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    console.log(`[backfill-crew-assignments] ${dryRun ? "DRY RUN — no writes" : "applying"}`);

    // Not filtered to FIELD_CREW in SQL — the always-assign names are
    // MANAGER/ADMIN and must still be considered.
    const users = await prisma.user.findMany({
        where: { status: ELIGIBLE_USER_STATUS },
        select: { id: true, name: true, email: true, role: true, status: true },
    });
    const eligible = users.filter(shouldAutoAssignUser);

    console.log(`  eligible users: ${eligible.length} of ${users.length} ACTIVATED`);
    for (const u of eligible) {
        const why = u.role === ELIGIBLE_ROLE ? u.role : `${u.role} (always-assign name)`;
        console.log(`    - ${u.name || u.email || u.id} [${why}]`);
    }
    if (eligible.length === 0) {
        console.log("  nothing to do — no eligible users");
        return;
    }
    const eligibleIds = eligible.map((u) => u.id);

    const projects = await prisma.project.findMany({
        where: { status: TARGET_STATUS },
        select: { id: true, name: true, crew: { select: { id: true } } },
        orderBy: { id: "asc" },
    });
    console.log(`  "${TARGET_STATUS}" projects: ${projects.length}`);

    let totalConnected = 0;
    let projectsChanged = 0;
    for (const project of projects) {
        const existing = new Set(project.crew.map((c) => c.id));
        const toConnect = eligibleIds.filter((id) => !existing.has(id));
        if (toConnect.length === 0) continue;

        projectsChanged++;
        totalConnected += toConnect.length;
        console.log(`    ${project.name || project.id}: +${toConnect.length} crew`);
        if (!dryRun) {
            await prisma.project.update({
                where: { id: project.id },
                data: { crew: { connect: toConnect.map((id) => ({ id })) } },
            });
        }
    }

    console.log(
        `[backfill-crew-assignments] ${dryRun ? "would connect" : "connected"} ` +
        `${totalConnected} assignment(s) across ${projectsChanged} project(s). ` +
        `Re-running is a no-op.`
    );
}

main()
    .catch((e) => {
        console.error("[backfill-crew-assignments] FAILED:", e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
