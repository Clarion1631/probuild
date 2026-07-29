// Report-only audit of existing TimeEntry rows that have no scheduleTaskId.
//
// ============================================================================
// READ-ONLY REPORT — this script NEVER writes to the database.
//
// It calls only findMany()/groupBy() queries below. No Prisma mutation method
// (create/update/updateMany/upsert/delete/deleteMany/$executeRaw*) is imported
// or invoked anywhere in this file. Do not add one.
// ============================================================================
//
// Context: src/lib/punch-task-binding.ts is the canonical resolver every new
// TimeEntry write path now calls. This script looks backward at rows that
// predate that resolver (or that it left unresolved) and classifies them:
//
//   write-eligible   — the punch's estimateItemId matches exactly one
//                       ScheduleTask.estimateItemId in the same project.
//                       This is the ONLY class that would ever be safe to
//                       write, because estimateItemId is a stable 1:1
//                       mapping (ScheduleTask.estimateItemId is @unique) that
//                       doesn't change when crew or dates move.
//
//   unsafe/report-only — resolvable only via CURRENT crew assignments
//                       (TaskAssignment) on the punch's local calendar day.
//                       TaskAssignment has no validity interval and task
//                       dates are mutable, so replaying today's assignments
//                       over historical punches fabricates attribution — the
//                       crew member assigned to a task today may not be who
//                       was assigned when the punch was made, and the task's
//                       dates may since have moved off the punch's day
//                       entirely. Writing this backfill would also
//                       immediately change the task-hours roll-up shown in
//                       the task drawer, silently rewriting history. This
//                       script only counts and reports these; it never binds
//                       them.
//
//   unresolvable      — no candidate at all (no estimateItemId match, and
//                       either zero or more than one crew-assignment
//                       candidate on the punch's day).
//
// Usage:
//   node scripts/backfill-punch-task-binding.mjs
//   node scripts/backfill-punch-task-binding.mjs --limit 500
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

function parseLimit(argv) {
  const flagIndex = argv.indexOf("--limit");
  if (flagIndex === -1) return undefined;
  const raw = argv[flagIndex + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--limit requires a positive integer, got: ${raw ?? "(none)"}`);
  }
  return value;
}

const DATABASE_URL = resolveDatabaseUrl();
const LIMIT = parseLimit(process.argv.slice(2));

const prisma = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
});

// Mirrors src/lib/punch-task-binding.ts's toLocalDayKey. Kept as a local copy
// (rather than importing the TS module) because this script runs under plain
// `node`, matching the other standalone scripts/*.mjs in this repo. Keep this
// in sync with punch-task-binding.ts if that logic ever changes.
const LA_DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function toLocalDayKey(instant) {
  return LA_DAY_KEY.format(instant);
}

// Mirrors isTaskActiveOnDay in
// src/app/company-dashboard/schedule-board/dispatch-exceptions.ts.
function isTaskActiveOnDay(task, dayKey) {
  const startKey = task.startDate.toISOString().slice(0, 10);
  if (task.type === "milestone" || task.type === "appointment") return startKey === dayKey;
  const endKey = task.endDate.toISOString().slice(0, 10);
  return startKey <= dayKey && dayKey < endKey;
}

// Same conservative rule as resolveScheduleTaskForPunch's step 2: exactly one
// active, assigned, non-complete leaf task on the punch's local day.
function findSoleAssignedCandidate(scheduleTasks, parentIds, userId, dayKey) {
  const candidates = scheduleTasks.filter(task =>
    task.type === "task"
    && task.status !== "Complete"
    && !parentIds.has(task.id)
    && task.assignments.some(a => a.userId === userId)
    && isTaskActiveOnDay(task, dayKey));
  return candidates.length === 1 ? candidates[0] : null;
}

function emptyCounts() {
  return { writeEligible: 0, unsafeReportOnly: 0, unresolvable: 0 };
}

async function main() {
  console.log("================================================================");
  console.log(" READ-ONLY REPORT — this script NEVER writes to the database.");
  console.log(" It only reads TimeEntry / ScheduleTask / TaskAssignment rows and");
  console.log(" prints a classification report. No mutation is performed.");
  console.log("================================================================\n");

  if (DATABASE_URL.includes("supabase.c")) {
    console.log("[backfill-punch-task-binding] DATABASE_URL points at Supabase. Proceeding — this script is read-only, so it is safe against production.\n");
  }

  if (LIMIT !== undefined) {
    console.log(`Row scan capped at --limit ${LIMIT}.\n`);
  }

  const unbound = await prisma.timeEntry.findMany({
    where: { scheduleTaskId: null },
    select: { id: true, userId: true, projectId: true, startTime: true, estimateItemId: true },
    orderBy: { startTime: "asc" },
    ...(LIMIT !== undefined ? { take: LIMIT } : {}),
  });

  console.log(`Scanned ${unbound.length} TimeEntry row(s) with scheduleTaskId IS NULL.\n`);

  if (unbound.length === 0) {
    console.log("Nothing to report.");
    return;
  }

  const byProject = new Map();
  for (const entry of unbound) {
    if (!byProject.has(entry.projectId)) byProject.set(entry.projectId, []);
    byProject.get(entry.projectId).push(entry);
  }

  const projectIds = [...byProject.keys()];
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, name: true },
  });
  const projectNameById = new Map(projects.map(p => [p.id, p.name]));

  const overall = emptyCounts();
  const rows = [];

  for (const projectId of projectIds) {
    const entries = byProject.get(projectId);
    const scheduleTasks = await prisma.scheduleTask.findMany({
      where: { projectId },
      select: {
        id: true,
        parentId: true,
        startDate: true,
        endDate: true,
        status: true,
        type: true,
        estimateItemId: true,
        assignments: { select: { userId: true } },
      },
    });
    const parentIds = new Set(scheduleTasks.map(t => t.parentId).filter(Boolean));
    const taskByEstimateItemId = new Map(
      scheduleTasks.filter(t => t.estimateItemId).map(t => [t.estimateItemId, t]),
    );

    const projectCounts = emptyCounts();

    for (const entry of entries) {
      if (entry.estimateItemId && taskByEstimateItemId.has(entry.estimateItemId)) {
        projectCounts.writeEligible++;
        continue;
      }

      const dayKey = toLocalDayKey(entry.startTime);
      const candidate = findSoleAssignedCandidate(scheduleTasks, parentIds, entry.userId, dayKey);
      if (candidate) {
        projectCounts.unsafeReportOnly++;
        continue;
      }

      projectCounts.unresolvable++;
    }

    overall.writeEligible += projectCounts.writeEligible;
    overall.unsafeReportOnly += projectCounts.unsafeReportOnly;
    overall.unresolvable += projectCounts.unresolvable;

    rows.push({
      projectId,
      projectName: projectNameById.get(projectId) ?? "(unknown project)",
      total: entries.length,
      ...projectCounts,
    });
  }

  console.log("Per project:");
  console.log("-".repeat(96));
  console.log(
    [
      "Project".padEnd(40),
      "Total".padStart(7),
      "WriteElig".padStart(11),
      "UnsafeOnly".padStart(11),
      "Unresolv".padStart(10),
    ].join(" "),
  );
  console.log("-".repeat(96));
  for (const row of rows) {
    console.log(
      [
        `${row.projectName} (${row.projectId})`.slice(0, 40).padEnd(40),
        String(row.total).padStart(7),
        String(row.writeEligible).padStart(11),
        String(row.unsafeReportOnly).padStart(11),
        String(row.unresolvable).padStart(10),
      ].join(" "),
    );
  }
  console.log("-".repeat(96));
  console.log(
    [
      "TOTAL".padEnd(40),
      String(unbound.length).padStart(7),
      String(overall.writeEligible).padStart(11),
      String(overall.unsafeReportOnly).padStart(11),
      String(overall.unresolvable).padStart(10),
    ].join(" "),
  );
  console.log();
  console.log(`write-eligible:    ${overall.writeEligible} (safe to backfill via estimateItemId — a future script could write these)`);
  console.log(`unsafe/report-only: ${overall.unsafeReportOnly} (resolvable only via today's crew assignments — never write these)`);
  console.log(`unresolvable:      ${overall.unresolvable} (no candidate at all)`);
}

main()
  .catch(error => {
    console.error("Report failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
