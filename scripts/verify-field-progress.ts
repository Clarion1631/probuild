// Behavioral verification for the field-progress pipeline
// (src/lib/field-progress.ts + the provenance stamp in schedule-task-core).
//
// Exercises the guardrails with isolated fixtures and a FAKE model completion —
// no network, no Anthropic key needed. The chat ingest itself is not exercised
// here (it needs Google credentials); its dedupe rests on the DailyLog
// chatMessageName @unique constraint, which IS asserted.
//
// Usage against Supabase:
//   ALLOW_PROD_VERIFY=1 npx tsx scripts/verify-field-progress.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { prisma } from "../src/lib/prisma";
import { runFieldProgressForProject, sanitizeNextSteps } from "../src/lib/field-progress";
import { updateScheduleTaskInTransaction } from "../src/lib/schedule-task-core";

const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);

function source(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (databaseUrl.includes("supabase.c") && process.env.ALLOW_PROD_VERIFY !== "1") {
        console.error(
            "[verify-field-progress] REFUSING TO RUN: DATABASE_URL points at Supabase.\n" +
            "This script creates and deletes verification fixtures.\n" +
            "Set ALLOW_PROD_VERIFY=1 to opt in.",
        );
        process.exit(1);
    }

    // ── Static contract ────────────────────────────────────────────────────
    const schemaSource = source("../prisma/schema.prisma");
    for (const field of ["googleChatSpaceId", "clientNextSteps", "clientNextStepsAt", "progressSource", "chatMessageName"]) {
        assert.match(schemaSource, new RegExp(`\\b${field}\\b`), `schema must include ${field}`);
    }
    assert.match(schemaSource, /chatMessageName\s+String\?\s+@unique/, "chat ingest dedupe key must be unique");
    const applySource = source("./apply-chat-field-progress-schema.mjs");
    assert.match(applySource, /ADD COLUMN IF NOT EXISTS "progressSource"/);
    assert.match(applySource, /DailyLog_chatMessageName_key/);
    const cronSource = source("../src/app/api/cron/field-progress/route.ts");
    assert.match(cronSource, /CRON_SECRET/, "cron must be secret-gated");
    assert.match(cronSource, /Unauthorized/, "cron must fail closed");
    const eventsSource = source("../src/app/api/chat/events/route.ts");
    assert.match(eventsSource, /GOOGLE_CHAT_APP_AUDIENCE/, "chat events must verify audience");
    assert.match(eventsSource, /jwtVerify/, "chat events must verify Google's signature");
    const vercelSource = source("../vercel.json");
    assert.match(vercelSource, /\/api\/cron\/field-progress/, "cron must be scheduled");

    // ── sanitizeNextSteps: fail-closed customer gate ───────────────────────
    assert.equal(sanitizeNextSteps(null), null);
    assert.equal(sanitizeNextSteps("   "), null);
    assert.equal(sanitizeNextSteps("Tile work wraps up, then paint."), "Tile work wraps up, then paint.");
    assert.equal(sanitizeNextSteps("The change costs $1,200 extra."), null, "dollar amounts must drop the blurb");
    assert.equal(sanitizeNextSteps("About 1,200.00 dollars remain."), null);
    assert.equal(sanitizeNextSteps("That runs USD 1,200 all in."), null);
    assert.equal(sanitizeNextSteps("Add €500 for the upgrade."), null);
    assert.equal(sanitizeNextSteps("Roughly five hundred dollars more."), null);
    assert.equal(sanitizeNextSteps("Maybe 500 bucks."), null);
    assert.equal(sanitizeNextSteps("Your balance due is ready."), null);
    const long = "a".repeat(1000);
    assert.ok((sanitizeNextSteps(long) ?? "").length <= 600, "blurb must be capped");

    // ── DB fixtures ────────────────────────────────────────────────────────
    const client = await prisma.client.create({
        data: { name: `Field Verify Client ${RUN_ID}`, initials: "FV", email: `field-verify-${RUN_ID}@example.invalid` },
    });
    const admin = await prisma.user.create({
        data: { email: `field-verify-${RUN_ID}@example.invalid`, name: "Field Verify Admin", role: "ADMIN", status: "ACTIVATED" },
    });
    const project = await prisma.project.create({
        data: { name: `Field verify ${RUN_ID} — delete me`, clientId: client.id, status: "In Progress", startDate: new Date() },
    });
    const otherProject = await prisma.project.create({
        data: { name: `Field verify other ${RUN_ID} — delete me`, clientId: client.id, status: "In Progress", startDate: new Date() },
    });
    const day = (offset: number) => new Date(Date.UTC(2045, 2, 10) + offset * 86_400_000);
    const mkTask = (name: string, data: Record<string, unknown> = {}, projectId = project.id) =>
        prisma.scheduleTask.create({
            data: { projectId, name, startDate: day(0), endDate: day(5), type: "task", ...data },
        });

    try {
        const plain = await mkTask("Demo kitchen");
        const humanLocked = await mkTask("Set cabinets", { progress: 40, status: "In Progress", progressSource: "human" });
        const ahead = await mkTask("Hang drywall", { progress: 60, status: "In Progress" });
        const parent = await mkTask("Phase parent");
        await mkTask("Child under parent", { parentId: parent.id });
        const complete = await mkTask("Finished thing", { status: "Complete", progress: 100 });
        const foreign = await mkTask("Other project task", {}, otherProject.id);

        // Quiet project: zero logs must mean zero model calls and zero writes.
        let modelCalls = 0;
        const quiet = await runFieldProgressForProject(project.id, {
            complete: async () => { modelCalls += 1; return "{}"; },
        });
        assert.equal(quiet.skippedReason, "no new daily logs in window");
        assert.equal(modelCalls, 0, "a quiet project must cost zero model calls");

        await prisma.dailyLog.create({
            data: {
                projectId: project.id, createdById: admin.id, date: day(1),
                workPerformed: "Demoed the kitchen down to studs, drywall going up on the west wall",
                source: "chat", chatMessageName: `spaces/verify/${RUN_ID}/1`,
            },
        });
        // The unique dedupe key must reject a duplicate ingest of the same message.
        await assert.rejects(
            prisma.dailyLog.create({
                data: {
                    projectId: project.id, createdById: admin.id, date: day(1),
                    workPerformed: "dupe", source: "chat", chatMessageName: `spaces/verify/${RUN_ID}/1`,
                },
            }),
            /Unique constraint/i,
        );

        // One model pass exercising every guard at once.
        const run = await runFieldProgressForProject(project.id, {
            complete: async () => JSON.stringify({
                updates: [
                    { taskId: plain.id, progress: 150, note: "finished per log" },      // clamps to 99, never Complete
                    { taskId: humanLocked.id, progress: 90, note: "cabinets done" },     // human is durable → rejected
                    { taskId: ahead.id, progress: 30, note: "drywall" },                 // would lower → rejected
                    { taskId: parent.id, progress: 50, note: "phase" },                  // parent → rejected
                    { taskId: complete.id, progress: 50, note: "redo" },                 // Complete → rejected
                    { taskId: foreign.id, progress: 50, note: "wrong job" },             // cross-project → rejected
                    { taskId: plain.id, progress: 55, note: "again" },                   // duplicate → rejected
                    { taskId: "not-a-task", progress: 50, note: "ghost" },               // invented id → rejected
                ],
                nextSteps: "Drywall finishes on the west wall, then taping and mud. Paint comes next week.",
            }),
        });

        assert.equal(run.applied.length, 1, `exactly one update should survive, got ${JSON.stringify(run.applied)}`);
        assert.equal(run.applied[0].taskId, plain.id);
        assert.equal(run.applied[0].toProgress, 99, "progress must clamp to 99");
        assert.equal(run.applied[0].toStatus, "In Progress", "AI may only set In Progress");
        assert.equal(run.rejected.length, 7, `all other suggestions must be rejected, got ${JSON.stringify(run.rejected)}`);

        const savedPlain = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: plain.id } });
        assert.equal(savedPlain.progress, 99);
        assert.equal(savedPlain.status, "In Progress");
        assert.equal(savedPlain.progressSource, "ai", "AI writes must stamp provenance");
        const savedLocked = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: humanLocked.id } });
        assert.equal(savedLocked.progress, 40, "human-locked task must be untouched");

        const savedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
        assert.ok(savedProject.clientNextSteps?.includes("Drywall finishes"), "next steps must be written");
        assert.ok(savedProject.clientNextStepsAt, "next steps timestamp must be set");

        const audit = await prisma.activityLog.findMany({
            where: { projectId: project.id, action: "ai_field_progress" },
        });
        assert.equal(audit.length, 1, "each applied update must write exactly one audit row");

        // Money-shaped nextSteps must not reach the client, and a second run
        // with a lower progress suggestion must not regress the task.
        const run2 = await runFieldProgressForProject(project.id, {
            complete: async () => JSON.stringify({
                updates: [{ taskId: plain.id, progress: 10, note: "looks early actually" }],
                nextSteps: "Remaining balance of $5,000 due at drywall.",
            }),
        });
        assert.equal(run2.applied.length, 0, "AI must never lower progress");
        const savedProject2 = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
        assert.ok(savedProject2.clientNextSteps?.includes("Drywall finishes"), "money-shaped blurb must not replace the good one");

        // A human TEAM edit through the canonical core stamps "human" and the
        // next AI run must respect it.
        await prisma.$transaction(tx =>
            updateScheduleTaskInTransaction(tx, plain.id, { progress: 50 }, { type: "TEAM", name: "Richard" }, project.id),
        );
        const humanEdited = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: plain.id } });
        assert.equal(humanEdited.progressSource, "human", "TEAM edits must stamp human provenance");
        const run3 = await runFieldProgressForProject(project.id, {
            complete: async () => JSON.stringify({
                updates: [{ taskId: plain.id, progress: 95, note: "nearly done" }],
                nextSteps: null,
            }),
        });
        assert.equal(run3.applied.length, 0, "AI must not overwrite a human edit");
        assert.equal(run3.rejected[0]?.reason, "human-set progress is durable");

        // Legacy 100%-progress row (pre-clamp data) with null provenance: the
        // AI write must come out at ≤99, never resurrect 100.
        const legacy = await mkTask("Legacy hundred", { progress: 100, status: "Not Started" });
        const legacyRun = await runFieldProgressForProject(project.id, {
            complete: async () => JSON.stringify({
                updates: [{ taskId: legacy.id, progress: 50, note: "still moving" }],
                nextSteps: null,
            }),
        });
        const savedLegacy = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: legacy.id } });
        assert.ok(savedLegacy.progress <= 99, `legacy task must clamp to ≤99, got ${savedLegacy.progress}`);
        assert.equal(legacyRun.applied.length + legacyRun.rejected.length, 1);
        if (legacyRun.applied.length === 1) {
            assert.equal(
                legacyRun.applied[0].toProgress, savedLegacy.progress,
                "reported toProgress must equal what the database holds",
            );
        }

        // Race: a human edit landing WHILE the model is thinking must win. The
        // fake completion mutates the task mid-run; the in-transaction recheck
        // must reject the stale suggestion.
        const raced = await mkTask("Race target");
        const raceRun = await runFieldProgressForProject(project.id, {
            complete: async () => {
                await prisma.scheduleTask.update({
                    where: { id: raced.id },
                    data: { progress: 80, status: "In Progress", progressSource: "human" },
                });
                return JSON.stringify({
                    updates: [{ taskId: raced.id, progress: 30, note: "stale read" }],
                    nextSteps: null,
                });
            },
        });
        assert.equal(raceRun.applied.length, 0, "a mid-run human edit must win the race");
        const savedRaced = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: raced.id } });
        assert.equal(savedRaced.progress, 80, "the human's progress must survive");
        assert.equal(savedRaced.progressSource, "human");

        // Dry run: report but never write.
        const dryTask = await mkTask("Dry-run target");
        const dry = await runFieldProgressForProject(project.id, {
            dryRun: true,
            complete: async () => JSON.stringify({
                updates: [{ taskId: dryTask.id, progress: 42, note: "dry" }],
                nextSteps: "Dry run only.",
            }),
        });
        assert.equal(dry.applied.length, 1, "dry run still reports what it would do");
        const savedDry = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: dryTask.id } });
        assert.equal(savedDry.progress, 0, "dry run must not write task progress");
        assert.equal(dry.nextStepsWritten, false, "dry run must not claim a write");
        assert.equal(dry.nextStepsPreview, "Dry run only.", "dry run reports the blurb as a preview");
        const savedProject3 = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
        assert.ok(!savedProject3.clientNextSteps?.includes("Dry run"), "dry run must not write next steps");

        // Unparseable model output degrades to a no-write error, not a throw.
        const garbage = await runFieldProgressForProject(project.id, {
            complete: async () => "sorry, I can't do JSON today",
        });
        assert.equal(garbage.applied.length, 0);
        assert.ok(garbage.errors.some(e => e.includes("unparseable")), "bad model output must be reported");

        console.log("verify-field-progress: ALL CHECKS PASSED");
    } finally {
        await prisma.activityLog.deleteMany({ where: { projectId: { in: [project.id, otherProject.id] } } });
        await prisma.dailyLog.deleteMany({ where: { projectId: { in: [project.id, otherProject.id] } } });
        await prisma.scheduleTask.deleteMany({ where: { projectId: { in: [project.id, otherProject.id] } } });
        await prisma.project.deleteMany({ where: { id: { in: [project.id, otherProject.id] } } });
        await prisma.user.delete({ where: { id: admin.id } }).catch(() => {});
        await prisma.client.delete({ where: { id: client.id } }).catch(() => {});
        await prisma.$disconnect();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
