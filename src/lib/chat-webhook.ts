import { prisma } from "@/lib/prisma";

// Daily-log post-back to the project's Google Chat team space, via a per-space
// incoming webhook (Project.chatWebhookUrl — a credential, manager-configured).
//
// One-way in v1: the crew sees the structured log + tomorrow's suggested task
// the evening before, which is what makes the clock-in "are you sure?" nudge
// trusted instead of noise. There is deliberately no "reply to correct"
// invitation — a reply-driven correction loop needs thread correlation and an
// update tool that don't exist yet.
//
// Callers AWAIT this (or run it inside next/server `after()`); it must never
// throw into a daily-log write, so all failures resolve false and log.

const WEBHOOK_HOST = "chat.googleapis.com";
const POST_TIMEOUT_MS = 10_000;

/**
 * The server POSTs to this URL, so restrict it to Google Chat's webhook
 * surface — anything else is an SSRF vector, not a configuration choice.
 */
export function isValidChatWebhookUrl(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:"
            && url.hostname === WEBHOOK_HOST
            && url.pathname.startsWith("/v1/spaces/");
    } catch {
        return false;
    }
}

export interface DailyLogPostBackInput {
    projectId: string;
    dateLabel: string; // "2026-08-06"
    workPerformed: string;
    nextSteps?: string | null;
    issues?: string | null;
    photoCount: number;
    /** Stage A's pick, when it produced one — shown as tomorrow's task. */
    suggestedTask?: { costCodeLabel: string; taskName: string } | null;
}

/**
 * Post the structured daily-log summary to the project's Chat space.
 * Resolves true when a post was delivered, false otherwise (no webhook
 * configured, invalid URL, network failure). Never throws.
 */
export async function postDailyLogToChat(input: DailyLogPostBackInput): Promise<boolean> {
    try {
        const project = await prisma.project.findUnique({
            where: { id: input.projectId },
            select: { name: true, chatWebhookUrl: true },
        });
        const webhookUrl = project?.chatWebhookUrl;
        if (!webhookUrl || !isValidChatWebhookUrl(webhookUrl)) return false;

        const lines = [
            `📋 *Daily log — ${input.dateLabel}*`,
            ``,
            `*What we did:* ${truncate(input.workPerformed)}`,
        ];
        if (input.nextSteps?.trim()) lines.push(`*Next steps:* ${truncate(input.nextSteps)}`);
        if (input.issues?.trim()) lines.push(`*Issues:* ${truncate(input.issues)}`);
        if (input.photoCount > 0) lines.push(`📷 ${input.photoCount} photo${input.photoCount === 1 ? "" : "s"}`);
        if (input.suggestedTask) {
            const label = input.suggestedTask.costCodeLabel
                ? `${input.suggestedTask.costCodeLabel} — ${input.suggestedTask.taskName}`
                : input.suggestedTask.taskName;
            lines.push(``, `👉 *Tomorrow's task: ${label}*`);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify({ text: lines.join("\n") }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            console.error("[chat-webhook] post failed", { projectId: input.projectId, status: res.status });
            return false;
        }
        return true;
    } catch (error) {
        console.error("[chat-webhook] post failed", { projectId: input.projectId, error });
        return false;
    }
}

function truncate(text: string, max = 600): string {
    const trimmed = text.trim();
    return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Load a daily log (incl. the Stage A task pick, so call this AFTER
 * runDailyLogTaskMatch) and post its summary to the project's Chat space.
 * Never throws.
 */
export async function postDailyLogSummary(dailyLogId: string): Promise<boolean> {
    try {
        const log = await prisma.dailyLog.findUnique({
            where: { id: dailyLogId },
            select: {
                projectId: true,
                date: true,
                workPerformed: true,
                nextSteps: true,
                issues: true,
                aiSuggestedTaskId: true,
                photos: { select: { id: true } },
            },
        });
        if (!log) return false;

        let suggestedTask: { costCodeLabel: string; taskName: string } | null = null;
        if (log.aiSuggestedTaskId) {
            const task = await prisma.scheduleTask.findUnique({
                where: { id: log.aiSuggestedTaskId },
                select: { name: true, estimateItemId: true },
            });
            if (task) {
                // The charge lands on the TOP-LEVEL bucket, so the label must be
                // that bucket's cost code — not the nearest coded ancestor.
                // Same walk the suggestion mapper does (bounded hop count).
                let costCode: { code: string; name: string } | null = null;
                let itemId: string | null = task.estimateItemId;
                for (let hops = 0; itemId && hops < 10; hops += 1) {
                    const item: { parentId: string | null; costCode: { code: string; name: string } | null } | null =
                        await prisma.estimateItem.findUnique({
                            where: { id: itemId },
                            select: { parentId: true, costCode: { select: { code: true, name: true } } },
                        });
                    if (!item) break;
                    if (!item.parentId) {
                        costCode = item.costCode;
                        break;
                    }
                    itemId = item.parentId;
                }
                suggestedTask = {
                    taskName: task.name,
                    costCodeLabel: costCode ? `${costCode.code} — ${costCode.name}` : "",
                };
            }
        }

        return await postDailyLogToChat({
            projectId: log.projectId,
            dateLabel: log.date.toISOString().slice(0, 10),
            workPerformed: log.workPerformed,
            nextSteps: log.nextSteps,
            issues: log.issues,
            photoCount: log.photos.length,
            suggestedTask,
        });
    } catch (error) {
        console.error("[chat-webhook] summary post failed", { dailyLogId, error });
        return false;
    }
}
