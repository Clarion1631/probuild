import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidChatWebhookUrl } from "@/lib/chat-webhook";
import { isSpeedToLeadPaused } from "./settings";
import { alertAudience, type TriageReason } from "./triage";
import { logLeadEvent } from "./audit";
import {
    ALERT_BACKOFF_MINUTES, ALERT_MAX_ATTEMPTS, ALERT_MAX_LEAD_AGE_MS, ALERT_SENDING_STALE_MS,
    ALERT_POST_TIMEOUT_MS, NTFY_PRIORITY_DEFAULT, NTFY_PRIORITY_SPAM_SIGNAL, chatCardsEnabled,
} from "./constants";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Two independent alert channels (docs/plans/SPEED-TO-LEAD-V1A.md "(2)
 * Alert design") — replaces v1's `push.ts` ("Chat as ntfy fallback"). ntfy
 * goes to Justin's phone; a Chat card goes to the team (LIVE, production
 * only). Neither is a fallback for the other: both, either, or neither can
 * fire for a given lead, per `alertAudience`.
 *
 * Dedupe is transactional, not delivery-side: the Lead's own creating
 * transaction inserts these rows with
 * `INSERT ... ON CONFLICT ("leadId","channel") DO NOTHING`
 * (`@@unique([leadId, channel])`), so a lost race, a webhook retry, or a
 * cross-channel link to an already-alerted lead creates no second row.
 */

/**
 * Row creation — called from the SAME transaction that creates or resolves
 * the Lead (intake.ts). Content is intentionally NOT stored here: the
 * sender re-reads the Lead/LeadIntakeEvent fresh at delivery time (the same
 * "re-verify before it goes out" pattern `receipt-request-cards.ts` uses),
 * so a later Junk/Promote is reflected even in a retried send.
 */
export async function createLeadAlertsInTx(
    tx: Db,
    params: { leadId: string; verdict: "REAL" | "REVIEW" | "JUNK"; reasons: readonly TriageReason[]; isTest: boolean },
): Promise<void> {
    const audience = alertAudience(params.verdict, params.reasons, params.isTest);
    if (audience.ntfy) {
        await tx.$executeRaw`
            INSERT INTO "LeadAlert" (id, "leadId", channel, status, "isTest", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${params.leadId}, 'NTFY'::"LeadAlertChannel", 'PENDING'::"LeadAlertStatus", ${params.isTest}, now(), now())
            ON CONFLICT ("leadId", channel) DO NOTHING`;
    }
    if (audience.chat && chatCardsEnabled()) {
        await tx.$executeRaw`
            INSERT INTO "LeadAlert" (id, "leadId", channel, status, "isTest", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${params.leadId}, 'CHAT'::"LeadAlertChannel", 'PENDING'::"LeadAlertStatus", ${params.isTest}, now(), now())
            ON CONFLICT ("leadId", channel) DO NOTHING`;
    }
}

// ── Content (privacy rules — V1A "(2) Alert design — Content and privacy") ─

interface AlertLeadContext {
    leadId: string;
    createdAt: Date;
    firstName: string;
    city: string | null;
    projectScope: string | null;
    lastFourPhone: string | null;
    email: string | null;
    fullPhone: string | null;
    messageExcerpt: string;
    verdict: "REAL" | "REVIEW" | "JUNK" | null;
    reasons: TriageReason[];
}

async function loadAlertLeadContext(db: Db, leadId: string): Promise<AlertLeadContext | null> {
    const lead = await db.lead.findUnique({
        where: { id: leadId },
        select: {
            id: true, createdAt: true, location: true, projectType: true, message: true,
            client: { select: { name: true, email: true, primaryPhone: true } },
            // Most RECENT intake row, not oldest: a cross-channel-linked lead
            // can carry more than one intake row (e.g. the fallback's
            // forced-REVIEW row plus the webhook's own real triage row), and
            // a Justin promote/junk action updates every row for the lead
            // uniformly — the latest one is the current truth either way.
            leadIntakeEvents: { select: { verdict: true, reasons: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
    });
    if (!lead) return null;
    const firstName = (lead.client?.name ?? "there").trim().split(/\s+/)[0] || "there";
    const phone = lead.client?.primaryPhone ?? null;
    const digits = phone?.replace(/\D/g, "") ?? "";
    return {
        leadId: lead.id,
        createdAt: lead.createdAt,
        firstName,
        city: lead.location ?? null,
        projectScope: lead.projectType ?? null,
        lastFourPhone: digits.length >= 4 ? digits.slice(-4) : null,
        email: lead.client?.email ?? null,
        fullPhone: phone,
        messageExcerpt: (lead.message ?? "").slice(0, 200),
        verdict: (lead.leadIntakeEvents[0]?.verdict as AlertLeadContext["verdict"]) ?? null,
        reasons: (lead.leadIntakeEvents[0]?.reasons as TriageReason[] | null) ?? [],
    };
}

function leadUrl(leadId: string): string {
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://probuild.goldentouchremodeling.com").replace(/\/+$/, "");
    return `${base}/leads/${leadId}`;
}

function ntfyContent(ctx: AlertLeadContext, isTest: boolean): { title: string; body: string; priority: string } {
    const audience = alertAudience(ctx.verdict ?? "REVIEW", ctx.reasons, isTest);
    const parts = [
        `${ctx.firstName}`,
        ctx.city ? `${ctx.city}` : null,
        ctx.projectScope ? `${ctx.projectScope}` : null,
        ctx.verdict ? `verdict: ${ctx.verdict}` : null,
        ctx.lastFourPhone ? `phone ending ${ctx.lastFourPhone}` : null,
    ].filter(Boolean);
    // ASCII only — this becomes the `Title` HTTP header value, and fetch()
    // throws synchronously on a non-Latin1 header (an em dash is outside
    // Latin-1's range). That threw exception was previously caught by the
    // generic network try/catch below and silently misreported as
    // "network-or-timeout", so this is a real fix, not just cosmetic —
    // every REVIEW-verdict ntfy push would otherwise fail every attempt,
    // forever, until it went DEAD.
    const title = isTest ? "[TEST] New lead" : ctx.verdict === "REAL" ? "New web lead" : "New lead - needs review";
    return { title, body: parts.join(" · "), priority: audience.ntfyPriority === "2" ? NTFY_PRIORITY_SPAM_SIGNAL : NTFY_PRIORITY_DEFAULT };
}

function chatCardText(ctx: AlertLeadContext, isTest: boolean): string {
    const label = isTest
        ? "[TEST] not a customer"
        : ctx.verdict === "REVIEW" && ctx.reasons.length > 0
            ? `Needs review: ${ctx.reasons.join(", ")}`
            : null;
    const lines = [
        `📞 *New lead${label ? ` — ${label}` : ""}*`,
        "",
        `Name: ${ctx.firstName}`,
        ctx.fullPhone ? `Phone: ${ctx.fullPhone}` : null,
        ctx.email ? `Email: ${ctx.email}` : null,
        ctx.city ? `City: ${ctx.city}` : null,
        ctx.projectScope ? `Scope: ${ctx.projectScope}` : null,
        ctx.verdict ? `Verdict: ${ctx.verdict}` : null,
        ctx.messageExcerpt ? `Message: ${ctx.messageExcerpt}` : null,
        "",
        leadUrl(ctx.leadId),
    ].filter((l): l is string => l !== null);
    return lines.join("\n");
}

// ── Senders — never throw; every failure resolves to a typed outcome ───────

type SendOutcome =
    | { kind: "delivered"; providerRef: string }
    | { kind: "rejected"; reason: string }
    | { kind: "unknown"; reason: string; retryAfterMs?: number };

/**
 * HTTP header VALUES must be Latin-1/ASCII — fetch() throws synchronously
 * (not a network error) on anything outside that range, e.g. an em dash or
 * an emoji. That thrown exception looks identical, from the outside, to a
 * genuine network failure (both land in the same try/catch below), so a
 * header carrying an unsanitized character would silently retry forever and
 * eventually go DEAD with no real network problem at all. Defensive on
 * every header value built from anything other than a literal ASCII string
 * — never trusted just because today's callers happen to pass plain text.
 */
export function asciiSafeHeaderValue(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[^\x20-\x7e]/g, "?");
}

async function sendNtfyAlert(alertId: string, ctx: AlertLeadContext, isTest: boolean): Promise<SendOutcome> {
    const topic = process.env.SPEED_TO_LEAD_NTFY_TOPIC?.trim();
    if (!topic) return { kind: "rejected", reason: "no ntfy topic configured" };
    const base = (process.env.SPEED_TO_LEAD_NTFY_BASE_URL || "https://ntfy.sh").trim().replace(/\/+$/, "");
    const { title, body, priority } = ntfyContent(ctx, isTest);
    const headers: Record<string, string> = {
        Title: asciiSafeHeaderValue(title),
        Priority: priority,
        Tags: `stl-${alertId}`,
        Click: leadUrl(ctx.leadId),
    };
    const token = process.env.SPEED_TO_LEAD_NTFY_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
        res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(ALERT_POST_TIMEOUT_MS),
        });
    } catch {
        return { kind: "unknown", reason: "network-or-timeout" };
    }
    if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        return { kind: "unknown", reason: "http-429", retryAfterMs: Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined };
    }
    if (res.status >= 400 && res.status < 500) return { kind: "rejected", reason: `http-${res.status}` };
    if (!res.ok) return { kind: "unknown", reason: `http-${res.status}` };
    const parsed = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof parsed?.id === "string" && parsed.id) return { kind: "delivered", providerRef: parsed.id };
    return { kind: "unknown", reason: "2xx-no-identity" };
}

async function sendChatAlert(alertId: string, leadId: string, ctx: AlertLeadContext, isTest: boolean): Promise<SendOutcome> {
    const webhookUrl = process.env.SPEED_TO_LEAD_CHAT_WEBHOOK_URL?.trim();
    if (!webhookUrl || !isValidChatWebhookUrl(webhookUrl)) return { kind: "rejected", reason: "no valid chat webhook configured" };

    let res: Response;
    try {
        const url = new URL(webhookUrl);
        url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=UTF-8" },
            // One thread per lead, forever — a retry after an `unknown`
            // outcome replies in the SAME thread rather than opening a
            // second top-level card.
            body: JSON.stringify({ text: chatCardText(ctx, isTest), thread: { threadKey: `stl-lead-${leadId}` } }),
            signal: AbortSignal.timeout(ALERT_POST_TIMEOUT_MS),
        });
    } catch {
        return { kind: "unknown", reason: "network-or-timeout" };
    }
    if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        return { kind: "unknown", reason: "http-429", retryAfterMs: Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined };
    }
    if (res.status >= 400 && res.status < 500) return { kind: "rejected", reason: `http-${res.status}` };
    if (!res.ok) return { kind: "unknown", reason: `http-${res.status}` };
    const body = (await res.json().catch(() => null)) as { name?: unknown; thread?: { name?: unknown } } | null;
    const messageName = typeof body?.name === "string" && body.name ? body.name : null;
    const threadName = typeof body?.thread?.name === "string" && body.thread.name ? body.thread.name : null;
    if (messageName && threadName) return { kind: "delivered", providerRef: messageName };
    return { kind: "unknown", reason: "2xx-no-identity" };
}

// ── Claim, deliver, retry (durable — V1A "(2) Alert design — Durable retry") ─

function backoffMs(attempts: number): number {
    const minutes = ALERT_BACKOFF_MINUTES[Math.min(attempts - 1, ALERT_BACKOFF_MINUTES.length - 1)];
    return minutes * 60 * 1000;
}

const ALLOWED_ERROR_CATEGORIES = new Set([
    "network-or-timeout", "http-429", "http-400", "http-401", "http-403", "http-404",
    "http-500", "http-502", "http-503", "2xx-no-identity",
    "no ntfy topic configured", "no valid chat webhook configured", "lead-missing",
]);
function safeErrorCategory(reason: string): string {
    return ALLOWED_ERROR_CATEGORIES.has(reason) ? reason : "unknown-error";
}

async function applyOutcome(db: PrismaClient, alert: { id: string; attempts: number; leadId: string }, outcome: SendOutcome, now: Date): Promise<void> {
    if (outcome.kind === "delivered") {
        await db.leadAlert.update({ where: { id: alert.id }, data: { status: "DELIVERED", deliveredAt: now, providerRef: outcome.providerRef, lastErrorCategory: null } });
        await logLeadEvent(db, { leadId: alert.leadId, kind: "alert-delivered", detail: { alertId: alert.id } });
        return;
    }
    if (outcome.kind === "rejected") {
        await db.leadAlert.update({ where: { id: alert.id }, data: { status: "DEAD", lastErrorCategory: safeErrorCategory(outcome.reason) } });
        await logLeadEvent(db, { leadId: alert.leadId, kind: "alert-dead", detail: { alertId: alert.id, reason: safeErrorCategory(outcome.reason) } });
        return;
    }
    // "unknown" — the terminal (attempts-cap / lead-age) check runs BEFORE
    // a row is ever claimed (see deliverDueAlerts), so every row reaching
    // here still has budget left: always a bounded retry, never a decision
    // point for DEAD/SKIPPED.
    const delayMs = outcome.retryAfterMs ?? backoffMs(alert.attempts);
    await db.leadAlert.update({
        where: { id: alert.id },
        data: { status: "PENDING", nextAttemptAt: new Date(now.getTime() + delayMs), lastErrorCategory: safeErrorCategory(outcome.reason) },
    });
}

/**
 * A standalone ntfy push not tied to any one LeadAlert row — used by the
 * 09:00 digest (tracking.ts) and by the poll's own health pushes
 * (gmail-poll.ts's "poll failing after 15 min" / resync-gap notice). Never
 * throws; resolves false on any failure.
 */
export async function sendPlainNtfy(title: string, body: string): Promise<boolean> {
    const topic = process.env.SPEED_TO_LEAD_NTFY_TOPIC?.trim();
    if (!topic) return false;
    const base = (process.env.SPEED_TO_LEAD_NTFY_BASE_URL || "https://ntfy.sh").trim().replace(/\/+$/, "");
    const headers: Record<string, string> = { Title: asciiSafeHeaderValue(title), Priority: NTFY_PRIORITY_DEFAULT };
    const token = process.env.SPEED_TO_LEAD_NTFY_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await fetch(`${base}/${encodeURIComponent(topic)}`, { method: "POST", headers, body, signal: AbortSignal.timeout(ALERT_POST_TIMEOUT_MS) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Claims and sends every due alert (webhook `after()` and every cron
 * invocation both call this). Bounded to `limit` rows and `budgetMs` wall
 * time. While paused, due rows become SKIPPED (reason paused) and are never
 * sent — pause is a permanent decision for that alert, not a delay:
 * unpausing releases no backlog (V1A "Modes").
 */
export async function deliverDueAlerts(db: PrismaClient = prisma, now: Date = new Date(), opts: { limit?: number; budgetMs?: number } = {}): Promise<{ attempted: number }> {
    const limit = opts.limit ?? 20;
    const budgetMs = opts.budgetMs ?? 20_000;
    const deadline = Date.now() + budgetMs;

    // Reclaim stale SENDING rows (a worker died mid-send) before claiming.
    await db.leadAlert.updateMany({
        where: { status: "SENDING", claimedAt: { lt: new Date(now.getTime() - ALERT_SENDING_STALE_MS) } },
        data: { status: "PENDING" },
    });

    const paused = await isSpeedToLeadPaused(db);
    const due = await db.leadAlert.findMany({
        where: { status: "PENDING", nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: "asc" },
        take: limit,
    });

    let attempted = 0;
    for (const row of due) {
        if (Date.now() > deadline) break;
        if (paused) {
            const { count } = await db.leadAlert.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "SKIPPED", lastErrorCategory: "paused" } });
            if (count > 0) await logLeadEvent(db, { leadId: row.leadId, kind: "alert-skipped", detail: { alertId: row.id, reason: "paused" } });
            continue;
        }

        const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { createdAt: true } });
        if (!lead) {
            await db.leadAlert.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "DEAD", lastErrorCategory: "lead-missing" } });
            continue;
        }

        // Terminal check BEFORE claiming — never attempted (attempts===0)
        // and already stale reads as SKIPPED ("no stale alerts" without ever
        // costing a real send attempt); anything with prior attempts that
        // has now exhausted its cap/age reads as DEAD. Checking here, not
        // only inside applyOutcome after a send, is what makes SKIPPED
        // actually reachable — attempts is incremented as PART of the claim
        // below, so by the time a send outcome comes back attempts is never
        // 0 again.
        const leadAgeMs = now.getTime() - lead.createdAt.getTime();
        if (row.attempts >= ALERT_MAX_ATTEMPTS || leadAgeMs > ALERT_MAX_LEAD_AGE_MS) {
            const terminal = row.attempts === 0 ? "SKIPPED" : "DEAD";
            const claimed = await db.leadAlert.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: terminal, lastErrorCategory: "stale" } });
            if (claimed.count > 0) await logLeadEvent(db, { leadId: row.leadId, kind: `alert-${terminal.toLowerCase()}`, detail: { alertId: row.id, reason: "stale" } });
            continue;
        }

        // nextAttemptAt is re-checked here, not just in the `due` SELECT above:
        // a concurrent invocation's `due` list is a snapshot — if THIS row's
        // backoff got reset to PENDING (by another invocation's failed send,
        // between that snapshot and this claim) with nextAttemptAt pushed into
        // the future, matching on {id, status} alone would let a stale
        // in-memory "due" reference re-claim and resend it immediately,
        // ignoring the backoff it was just given.
        const claim = await db.leadAlert.updateMany({
            where: { id: row.id, status: "PENDING", nextAttemptAt: { lte: now } },
            data: { status: "SENDING", claimedAt: now, attempts: { increment: 1 } },
        });
        if (claim.count === 0) continue; // lost the claim race to another invocation
        attempted++;

        const ctx = await loadAlertLeadContext(db, row.leadId);
        if (!ctx) {
            await db.leadAlert.update({ where: { id: row.id }, data: { status: "DEAD", lastErrorCategory: "lead-missing" } });
            continue;
        }
        const outcome = row.channel === "NTFY"
            ? await sendNtfyAlert(row.id, ctx, row.isTest)
            : await sendChatAlert(row.id, row.leadId, ctx, row.isTest);
        await applyOutcome(db, { id: row.id, attempts: row.attempts + 1, leadId: row.leadId }, outcome, now);
    }
    return { attempted };
}
