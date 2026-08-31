// One-time (and re-runnable) sync for the current rule: every user with the
// dispatch-board switch on — `User.showOnDispatch = true`, ACTIVATED, role
// != FINANCE, exactly `isDispatchable` in src/lib/dispatch-roster.ts — is on
// the crew of every "In Progress" project. Managers and admins with the
// switch on are included; there is no CJ/FIELD_CREW special-casing anymore.
//
//   node scripts/sync-crew-to-in-progress.mjs            # apply
//   node scripts/sync-crew-to-in-progress.mjs --dry-run   # report only, no writes
//
// The ONGOING enforcement is in src/lib/crew-auto-assign-sync.ts, hooked into
// the project-status write paths, the user role/status write paths, and the
// Team page's showOnDispatch toggle (src/app/api/users/[id]/route.ts PUT).
// This script exists only to catch up projects/users that predate that
// switch flipping (e.g. a user whose showOnDispatch was backfilled true by
// scripts/apply-show-on-dispatch.mjs while a project was already In Progress).
//
// SAFETY / IDEMPOTENCY:
//   - Purely ADDITIVE. It only ever `connect`s users to projects. It never
//     disconnects anybody, so a crew member added or removed by hand is never
//     touched.
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
// "@/..." alias resolution (same reason apply-show-on-dispatch.mjs and every
// other script here re-states its constants). It must stay in lockstep with
// isDispatchable in src/lib/dispatch-roster.ts and shouldAutoAssignUser in
// src/lib/crew-auto-assign.ts.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load env the same way every other script in this folder does. Without this
// the script dies with "Environment variable not found: DATABASE_URL" —
// `next dev`/`next build` inject .env.local for the app, but a bare `node
// scripts/*.mjs` gets nothing.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.production.local") });
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (.env.production.local missing? see card t_275a9e4d — restore from gtr-probuild-ledger).");
    process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

// Mirrors AUTO_ASSIGN_STATUS_VALUES in src/lib/crew-auto-assign.ts: the
// canonical "In Progress" plus every legacy Project.status value that
// canonicalProjectStatus (src/lib/project-status.ts LEGACY_PROJECT_STATUS_MAP)
// maps onto it. Keep this literal in lockstep with that list — scripts/*.mjs
// can't import TS. tests/crew-auto-assign.test.ts asserts the two agree by
// reading this file's source.
const TARGET_STATUSES = ["In Progress", "Open", "Active"];
const ELIGIBLE_USER_STATUS = "ACTIVATED"; // STATUS_LABELS, src/lib/permissions.ts
const EXCLUDED_ROLE = "FINANCE";          // never dispatchable, isDispatchable in dispatch-roster.ts

// Mirrors isDispatchable in src/lib/dispatch-roster.ts.
function isDispatchable(user) {
    return user.showOnDispatch === true
        && user.role !== EXCLUDED_ROLE
        && (user.status === undefined || user.status === ELIGIBLE_USER_STATUS);
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    console.log(`[sync-crew-to-in-progress] ${dryRun ? "DRY RUN — no writes" : "applying"}`);

    const users = await prisma.user.findMany({
        where: { showOnDispatch: true, status: ELIGIBLE_USER_STATUS, role: { not: EXCLUDED_ROLE } },
        select: { id: true, name: true, email: true, role: true, status: true, showOnDispatch: true },
    });
    const eligible = users.filter(isDispatchable);

    console.log(`  dispatchable users: ${eligible.length}`);
    for (const u of eligible) {
        console.log(`    - ${u.name || u.email || u.id} [${u.role}]`);
    }
    if (eligible.length === 0) {
        console.log("  nothing to do — no dispatchable users");
        return;
    }
    const eligibleIds = eligible.map((u) => u.id);

    const projects = await prisma.project.findMany({
        where: { status: { in: TARGET_STATUSES } },
        select: { id: true, name: true, crew: { select: { id: true } } },
        orderBy: { id: "asc" },
    });
    console.log(`  In Progress (incl. legacy ${TARGET_STATUSES.slice(1).join("/")}) projects: ${projects.length}`);

    let totalConnected = 0;
    let projectsChanged = 0;
    let totalAutoLinksWritten = 0;
    for (const project of projects) {
        const existing = new Set(project.crew.map((c) => c.id));
        const toConnect = eligibleIds.filter((id) => !existing.has(id));

        // ProjectCrewAutoLink provenance: every eligible pair on this project
        // — both the ones we're about to connect and the ones already
        // sitting on the crew that match this same shape — gets an auto-link
        // row, so src/lib/crew-auto-assign-sync.ts can later revoke it if the
        // pair goes stale. `createMany`/`skipDuplicates` makes this
        // idempotent, same as the crew `connect` below.
        const alreadyEligible = eligibleIds.filter((id) => existing.has(id));
        const autoLinkPairs = [...toConnect, ...alreadyEligible];

        if (toConnect.length > 0) {
            projectsChanged++;
            totalConnected += toConnect.length;
            const names = toConnect
                .map((id) => eligible.find((u) => u.id === id))
                .map((u) => u?.name || u?.email || u?.id);
            console.log(`    ${project.name || project.id}: +${toConnect.length} crew (${names.join(", ")})`);
        }
        if (!dryRun) {
            if (toConnect.length > 0) {
                await prisma.project.update({
                    where: { id: project.id },
                    data: { crew: { connect: toConnect.map((id) => ({ id })) } },
                });
            }
            if (autoLinkPairs.length > 0) {
                const written = await prisma.projectCrewAutoLink.createMany({
                    data: autoLinkPairs.map((userId) => ({ projectId: project.id, userId })),
                    skipDuplicates: true,
                });
                totalAutoLinksWritten += written.count;
            }
        } else {
            totalAutoLinksWritten += autoLinkPairs.length; // best-effort estimate under --dry-run
        }
    }

    console.log(
        `[sync-crew-to-in-progress] ${dryRun ? "would connect" : "connected"} ` +
        `${totalConnected} assignment(s) across ${projectsChanged} project(s). ` +
        `${dryRun ? "would write" : "wrote"} up to ${totalAutoLinksWritten} ProjectCrewAutoLink row(s) ` +
        `(new + already-eligible existing pairs; skipDuplicates makes re-runs a no-op). ` +
        `Re-running is a no-op.`
    );
}

main()
    .catch((e) => {
        console.error("[sync-crew-to-in-progress] FAILED:", e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
