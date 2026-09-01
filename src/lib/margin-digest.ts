// The two Monday outputs of Phase 4 (docs/plans/PHASE-4-EARNED-MARGIN-SPEC.md §6):
//
//   1. the margin card, one Chat message with a line per active job
//   2. the "dragging us" email, the two worst jobs by earned margin
//
// Kept out of the route handlers so the routes stay thin auth wrappers, exactly
// like sendArDigest / api/cron/ar-digest.
//
// ── FAIL SOFT, ALWAYS ───────────────────────────────────────────────────────
// Both destinations are env vars a human has to set (MAIN_OFFICE_CHAT_WEBHOOK,
// PIPELINE_DIGEST_TO). Until they are set these must return a logged skip, not
// throw: an unconfigured digest is an ops task, not a production incident, and
// a throwing cron buries the real signal in Sentry noise.
//
// Neither of these is a money path: nothing here writes, settles, or notifies a
// client. They are internal reporting only.

import { prisma } from "@/lib/prisma";
import { postTextToWebhook } from "@/lib/chat-webhook";
import { sendNotification } from "@/lib/email";
import { computeProjectFinancials } from "@/lib/project-financials";
import { listActiveJobsWithPercentComplete } from "@/lib/percent-complete-db";
import { percentCompleteNeedsReview } from "@/lib/percent-complete";
import { formatCurrency } from "@/lib/utils";

function appBaseUrl(): string {
    return (process.env.NEXT_PUBLIC_APP_URL || "https://probuild.goldentouchremodeling.com").replace(/\/+$/, "");
}

function shortDate(date: Date | null): string | null {
    if (!date) return null;
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

export interface MarginDigestJob {
    id: string;
    name: string;
    url: string;
    percentComplete: number | null;
    source: "AUTO" | "MANUAL" | null;
    auto: number | null;
    asOf: Date | null;
    needsReview: boolean;
    earnedMargin: number | null;
}

/**
 * Every active job with its stored percent complete and its earned margin.
 * Shared by both Monday outputs so the card and the email can never disagree
 * about which job is doing worst.
 */
export async function loadMarginDigestJobs(): Promise<MarginDigestJob[]> {
    const jobs = await listActiveJobsWithPercentComplete();
    const base = appBaseUrl();

    const rows: MarginDigestJob[] = [];
    for (const job of jobs) {
        const fin = await computeProjectFinancials(job.id);
        rows.push({
            id: job.id,
            name: job.name,
            url: `${base}/projects/${job.id}/financial-overview`,
            percentComplete: job.percentComplete,
            source: job.percentCompleteSource,
            auto: job.percentCompleteAuto,
            asOf: job.percentCompleteAsOf,
            needsReview: percentCompleteNeedsReview({
                source: job.percentCompleteSource,
                auto: job.percentCompleteAuto,
                autoAtOverride: job.percentCompleteAutoAtOverride,
            }),
            earnedMargin: fin.earnedMargin,
        });
    }
    return rows;
}

/** One Chat line per job. Pure, so the wording is testable without a webhook. */
export function buildMarginCardText(jobs: MarginDigestJob[], today = new Date()): string {
    const header = `📊 *Job margin — week of ${today.toISOString().slice(0, 10)}*`;
    if (jobs.length === 0) return `${header}\n\nNo active jobs.`;

    const lines = jobs.map((job) => {
        const link = `<${job.url}|adjust>`;
        if (job.percentComplete === null) {
            return `• *${job.name}* — no % yet (estimate uncoded or no schedule) — ${link}`;
        }

        // Auto first, then the manual value when a human has overridden it, so
        // the gap between machine and judgement is visible at a glance.
        const parts: string[] = [job.auto === null ? "auto —" : `auto ${job.auto}%`];
        if (job.source === "MANUAL") {
            const when = shortDate(job.asOf);
            parts.push(`manual ${job.percentComplete}%${when ? ` (${when})` : ""}`);
        }
        const margin = job.earnedMargin === null ? "earned margin —" : `earned margin ${formatCurrency(job.earnedMargin)}`;
        const review = job.needsReview ? " ⚠️ auto moved >5 pts since the override" : "";
        return `• *${job.name}* — ${parts.join(", ")} — ${margin} — ${link}${review}`;
    });

    return [header, "", ...lines].join("\n");
}

/**
 * Post the Monday margin card to the Main Office Chat space.
 * Returns `{ sent: false, reason }` and logs when the webhook is not configured.
 */
export async function sendMondayMarginCard() {
    const jobs = await loadMarginDigestJobs();
    const text = buildMarginCardText(jobs);

    const result = await postTextToWebhook(process.env.MAIN_OFFICE_CHAT_WEBHOOK, text);
    if (!result.sent) {
        console.log("[margin-digest] margin card not sent", { reason: result.reason, jobs: jobs.length });
        return { sent: false, reason: result.reason ?? "unknown", jobCount: jobs.length };
    }
    return { sent: true, jobCount: jobs.length };
}

export interface UnattributedCost {
    vendor: string | null;
    amount: number;
    date: Date | null;
    description: string | null;
}

/**
 * The single biggest cost on a job that landed on no phase.
 *
 * Ranked by ABSOLUTE amount: a large uncoded refund is just as much of a
 * bookkeeping hole as a large uncoded charge, and picking by signed value would
 * always surface the charge and never the credit.
 */
export async function biggestUnattributedCost(projectId: string): Promise<UnattributedCost | null> {
    const rows = await prisma.expense.findMany({
        // Expense has no projectId — it reaches the job through its estimate.
        where: { estimate: { projectId }, costCodeId: null },
        select: { amount: true, vendor: true, date: true, description: true },
    });

    let worst: UnattributedCost | null = null;
    for (const row of rows) {
        const amount = Number(row.amount) || 0;
        if (worst === null || Math.abs(amount) > Math.abs(worst.amount)) {
            worst = { vendor: row.vendor, amount, date: row.date, description: row.description };
        }
    }
    return worst;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * "What's dragging us": the two active jobs with the lowest earned margin, each
 * with its biggest unattributed cost.
 *
 * Jobs with no percent complete cannot be ranked (their earned margin is null),
 * so they are excluded from the ranking and COUNTED in a footer line instead —
 * a number with no denominator is how this report would start lying.
 */
export async function sendDraggingUsLine() {
    const jobs = await loadMarginDigestJobs();
    const ranked = jobs
        .filter((job) => job.earnedMargin !== null)
        .sort((a, b) => (a.earnedMargin ?? 0) - (b.earnedMargin ?? 0));
    const unmeasured = jobs.length - ranked.length;
    const worst = ranked.slice(0, 2);

    const to = process.env.PIPELINE_DIGEST_TO?.trim();
    if (!to) {
        console.log("[margin-digest] dragging-us email not sent", {
            reason: "PIPELINE_DIGEST_TO not set",
            ranked: ranked.length,
            unmeasured,
        });
        return { sent: false, reason: "PIPELINE_DIGEST_TO not set", ranked: ranked.length, unmeasured };
    }

    if (worst.length === 0) {
        console.log("[margin-digest] dragging-us email not sent", { reason: "no job has a % complete yet", unmeasured });
        return { sent: false, reason: "no job has a % complete yet", ranked: 0, unmeasured };
    }

    const blocks: string[] = [];
    for (const job of worst) {
        const cost = await biggestUnattributedCost(job.id);
        const costLine = cost
            ? `Biggest unattributed cost: <strong>${formatCurrency(Math.abs(cost.amount))}</strong> — ${esc(cost.vendor || cost.description || "no vendor recorded")}${cost.date ? ` on ${cost.date.toISOString().slice(0, 10)}` : ""}`
            : "No unattributed costs on this job.";
        blocks.push(`
            <div style="border:1px solid #e2e8f0;border-radius:6px;padding:12px 14px;margin-bottom:12px;">
                <p style="margin:0 0 4px;font-size:15px;"><strong>${esc(job.name)}</strong> — earned margin <strong style="color:${(job.earnedMargin ?? 0) >= 0 ? "#15803d" : "#b91c1c"};">${formatCurrency(job.earnedMargin ?? 0)}</strong></p>
                <p style="margin:0 0 4px;color:#475569;font-size:13px;">${job.percentComplete ?? "—"}% complete${job.source === "MANUAL" ? " (set by hand)" : ""}</p>
                <p style="margin:0;color:#475569;font-size:13px;">${costLine}</p>
                <p style="margin:8px 0 0;font-size:13px;"><a href="${job.url}">Open the financial overview</a></p>
            </div>`);
    }

    const settings = await prisma.companySettings.findUnique({
        where: { id: "singleton" },
        select: { companyName: true },
    });

    const sendResult = await sendNotification(
        to,
        `What's dragging us — ${worst.map((j) => j.name).join(" and ")}`,
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #333;">
            <h2 style="font-size:18px;">What's dragging us this week</h2>
            <p style="color:#475569;font-size:13px;">The ${worst.length === 1 ? "job" : "two jobs"} with the lowest earned margin, each with the single biggest cost that landed on no phase. Earned margin includes labor.</p>
            ${blocks.join("")}
            ${unmeasured > 0 ? `<p style="color:#64748b;font-size:12px;">${unmeasured} active job${unmeasured === 1 ? "" : "s"} could not be ranked — no percent complete yet (the estimate needs cost codes, or the schedule needs tasks).</p>` : ""}
        </div>`,
        undefined,
        { fromName: settings?.companyName || "ProBuild" },
    );

    if (!sendResult.success) {
        console.log("[margin-digest] dragging-us email send failed");
        return { sent: false, reason: "email send failed", ranked: ranked.length, unmeasured };
    }
    return { sent: true, ranked: ranked.length, unmeasured, jobs: worst.map((j) => j.name) };
}
