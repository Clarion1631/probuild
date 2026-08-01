import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CLOSED_PROJECT_STATUSES } from "@/lib/gpt-estimate";
import { runFieldProgressForProject, isFieldProgressForcedDryRun } from "@/lib/field-progress";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Nightly field-progress pass: for every open project with a mapped Google Chat
 * space, pull the crew's recent posts into DailyLog rows, then let the AI
 * advance schedule tasks within guardrails (In Progress + 1–99 only, human
 * edits durable — see lib/field-progress.ts) and refresh the portal's
 * customer-safe "what's next".
 *
 * Runs at 10:00 UTC (2–3am Pacific): after the evening posts, before anyone
 * reviews the board in the morning, and outside dispatch hours so a progress
 * tick can't invalidate an in-flight dispatch review.
 *
 * `?dryRun=1` reports without writing; FIELD_PROGRESS_DRY_RUN=1 forces dry-run
 * regardless of the query (precedence enforced in the lib). `?projectId=` runs
 * a single project.
 */
export async function GET(request: Request) {
    // Fail CLOSED, same shape as drain-notifications: whenever CRON_SECRET is
    // configured it is always required; the only unauthenticated path is a
    // genuinely local dev run.
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");
    const authed = !!secret && authHeader === `Bearer ${secret}`;
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dryRun") === "1";
    const onlyProjectId = url.searchParams.get("projectId");

    const projects = await prisma.project.findMany({
        where: {
            googleChatSpaceId: { not: null },
            status: { notIn: [...CLOSED_PROJECT_STATUSES] },
            ...(onlyProjectId ? { id: onlyProjectId } : {}),
        },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
    });

    const runs = [];
    const failures: Array<{ projectId: string; error: string }> = [];
    const skippedForBudget: string[] = [];
    // One stalled Chat/Anthropic request must not let the 300s platform kill
    // silently swallow the remaining projects — stop starting new ones near
    // the ceiling and REPORT what was skipped.
    const startedAt = Date.now();
    const TIME_BUDGET_MS = 240_000;
    for (const project of projects) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
            skippedForBudget.push(project.id);
            continue;
        }
        try {
            runs.push(await runFieldProgressForProject(project.id, { dryRun }));
        } catch (err) {
            failures.push({ projectId: project.id, error: err instanceof Error ? err.message : String(err) });
        }
    }

    const summary = {
        dryRun: dryRun || isFieldProgressForcedDryRun(),
        projects: projects.length,
        applied: runs.reduce((sum, run) => sum + run.applied.length, 0),
        rejected: runs.reduce((sum, run) => sum + run.rejected.length, 0),
        logsIngested: runs.reduce((sum, run) => sum + (run.ingest?.created ?? 0), 0),
        nextStepsWritten: runs.filter(run => run.nextStepsWritten).length,
        skippedForBudget,
        failures,
        runs,
    };
    console.log("[cron/field-progress]", JSON.stringify({ ...summary, runs: undefined }));
    return NextResponse.json(summary);
}
