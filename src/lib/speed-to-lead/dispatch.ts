import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { computeApprovalHash } from "./approval";
import { normalizeEndpoint } from "./contact-endpoint";
import { anyDispatchFreshness, templateAFreshness, type PollHealth } from "./freshness";
import { templateADeadlinePassed } from "./template";
import { isLiveActivatedForCurrentFingerprint } from "./fingerprint";
import {
    speedToLeadMode,
    isProduction,
    isAllowlistedRecipient,
    dailySendCap,
    DISPATCH_FROM_ADDRESS,
    MESSAGE_ID_DOMAIN,
    DISPATCHING_STALE_MS,
} from "./constants";

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export type DispatchOutcome =
    | { status: "SENT"; attemptId: string; providerMessageId: string; threadId: string | null }
    | { status: "FAILED"; attemptId: string; reason: string }
    | { status: "UNKNOWN_DELIVERY"; attemptId: string }
    | { status: "BLOCKED"; reason: string }
    | { status: "ALREADY_IN_FLIGHT" }
    | { status: "NOT_FOUND" };

async function logOutreachEvent(db: Db, params: { leadId?: string | null; messageId?: string | null; kind: string; detail?: unknown }) {
    try {
        await db.outreachEvent.create({
            data: {
                leadId: params.leadId ?? null,
                messageId: params.messageId ?? null,
                kind: params.kind,
                detail: (params.detail ?? null) as Prisma.InputJsonValue | undefined,
            },
        });
    } catch (error) {
        // Append-only audit logging must never fail the dispatch it describes.
        console.error("[speed-to-lead] failed to log OutreachEvent", error instanceof Error ? error.message : "UnknownError");
    }
}

function todayUtc(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * Daily cap, "a conditional increment" (spec Dispatch step 1). Returns true
 * only if the increment happened — i.e. the cap was not already reached.
 */
async function tryIncrementDailyCounter(tx: Tx, now: Date, cap: number): Promise<boolean> {
    if (!Number.isFinite(cap)) {
        await tx.outreachDailyCounter.upsert({
            where: { day: todayUtc(now) },
            create: { day: todayUtc(now), count: 1 },
            update: { count: { increment: 1 } },
        });
        return true;
    }
    const day = todayUtc(now);
    await tx.outreachDailyCounter.upsert({ where: { day }, create: { day, count: 0 }, update: {} });
    const { count } = await tx.outreachDailyCounter.updateMany({
        where: { day, count: { lt: cap } },
        data: { count: { increment: 1 } },
    });
    return count > 0;
}

/**
 * The fixed lock order, per spec Dispatch step 1: "pause and mode row, then
 * template row, then ContactEndpoint row, then lead row, then message row
 * (FOR UPDATE)." Every invalidating action (suppress, pause, revoke, junk,
 * Booked/Called/cancel) must take the SAME order, or this is a deadlock
 * waiting to happen rather than a guarantee.
 */
async function lockAutomationSettings(tx: Tx, keys: string[]): Promise<Map<string, string>> {
    const rows = await tx.$queryRaw<{ key: string; value: string }[]>`
        SELECT key, value FROM "AutomationSetting" WHERE key = ANY(${keys}) ORDER BY key FOR UPDATE`;
    return new Map(rows.map(r => [r.key, r.value]));
}

interface LockedTemplateRow { id: string; revokedAt: Date | null; approvedAt: Date | null; testOnly: boolean }
async function lockTemplate(tx: Tx, templateId: string): Promise<LockedTemplateRow | null> {
    const rows = await tx.$queryRaw<LockedTemplateRow[]>`
        SELECT id, "revokedAt", "approvedAt", "testOnly" FROM "OutreachTemplate" WHERE id = ${templateId} FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
}

interface LockedEndpointRow { endpoint: string; suppressedAt: Date | null; junkAt: Date | null }
async function lockContactEndpoint(tx: Tx, endpoint: string): Promise<LockedEndpointRow | null> {
    await tx.$executeRaw`
        INSERT INTO "ContactEndpoint" (id, endpoint, "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${endpoint}, now(), now())
        ON CONFLICT (endpoint) DO NOTHING`;
    const rows = await tx.$queryRaw<LockedEndpointRow[]>`
        SELECT endpoint, "suppressedAt", "junkAt" FROM "ContactEndpoint" WHERE endpoint = ${endpoint} FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
}

interface LockedLeadRow { id: string; stage: string }
async function lockLead(tx: Tx, leadId: string): Promise<LockedLeadRow | null> {
    const rows = await tx.$queryRaw<LockedLeadRow[]>`
        SELECT id, stage FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
}

interface LockedMessageRow { id: string; status: string; kind: string; generation: number; leadId: string; approvedVersionId: string | null; approvalHash: string | null; isTest: boolean; dedupeKey: string }
async function lockMessage(tx: Tx, messageId: string): Promise<LockedMessageRow | null> {
    const rows = await tx.$queryRaw<LockedMessageRow[]>`
        SELECT id, status, kind, generation, "leadId", "approvedVersionId", "approvalHash", "isTest", "dedupeKey" FROM "OutreachMessage" WHERE id = ${messageId} FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
}

interface CommitContext {
    attemptId: string;
    rfcMessageId: string;
    version: { id: string; to: string; subject: string; body: string; footer: string; threading: unknown };
    leadId: string;
    isTest: boolean;
}

async function commitDispatchTransaction(messageId: string, now: () => Date, db: PrismaClient): Promise<{ ok: true; ctx: CommitContext } | { ok: false; outcome: DispatchOutcome }> {
    return db.$transaction(async tx => {
        // Un-locked peek, only to know which template (if any) to lock next —
        // safe because a message's kind and its A version's templateVersionId
        // never change after creation.
        const peek = await tx.outreachMessage.findUnique({ where: { id: messageId } });
        if (!peek) return { ok: false, outcome: { status: "NOT_FOUND" } };
        if (["DISPATCHING", "SENT", "FAILED", "UNKNOWN_DELIVERY"].includes(peek.status)) {
            return { ok: false, outcome: { status: "ALREADY_IN_FLIGHT" } };
        }

        // Everything below this peek, up to the authoritative message lock at
        // the end, is UNLOCKED and only decides WHICH rows to lock next —
        // never trusted for a security/business decision. `leadId` never
        // changes after creation, so reading it unlocked is safe; the peeked
        // version's `to` address is used only to pick which ContactEndpoint
        // row to lock, and a generation change between this peek and the
        // authoritative re-check below is caught as "stale version".
        const peekedVersion = await tx.outreachVersion.findFirst({ where: { messageId, generation: peek.generation } });
        const peekedVersionId = peek.kind === "TEMPLATE_A" ? peekedVersion?.id : peek.approvedVersionId;
        const templateVersionId = peek.kind === "TEMPLATE_A" ? peekedVersion?.templateVersionId ?? null : null;
        const peekedTo = peekedVersion?.to ?? null;

        // 1. pause + mode-related rows.
        const settings = await lockAutomationSettings(tx, ["speedToLeadPaused", "liveActivation", "firstLiveSendAt"]);
        if (settings.get("speedToLeadPaused") === "true") {
            return { ok: false, outcome: { status: "BLOCKED", reason: "paused" } };
        }

        // 2. template row (TEMPLATE_A only).
        let template: Awaited<ReturnType<typeof lockTemplate>> = null;
        if (peek.kind === "TEMPLATE_A") {
            if (!templateVersionId) return { ok: false, outcome: { status: "BLOCKED", reason: "template A message has no template reference" } };
            template = await lockTemplate(tx, templateVersionId);
            if (!template || template.revokedAt) return { ok: false, outcome: { status: "BLOCKED", reason: "template revoked or missing" } };
        }

        // 3. ContactEndpoint row — locked for the peeked recipient; if the
        // authoritative version below turns out to have a different `to`
        // (an edit raced this peek), that mismatch is caught as a stale
        // version rather than trusted.
        const endpoint = peekedTo ? await lockContactEndpoint(tx, normalizeEndpoint(peekedTo)) : null;
        if (endpoint?.suppressedAt || endpoint?.junkAt) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "endpoint suppressed or junk" } };
        }

        // 4. lead row.
        const lead = await lockLead(tx, peek.leadId);
        if (!lead || CLOSED_LEAD_STAGES.includes(lead.stage)) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "lead closed" } };
        }

        // 5. message row — the authoritative lock. Everything above this
        // point picked which rows to lock; everything below re-derives truth
        // from what is now actually held.
        const message = await lockMessage(tx, messageId);
        if (!message) return { ok: false, outcome: { status: "NOT_FOUND" } };
        if (["DISPATCHING", "SENT", "FAILED", "UNKNOWN_DELIVERY"].includes(message.status)) {
            return { ok: false, outcome: { status: "ALREADY_IN_FLIGHT" } };
        }

        const versionId = message.kind === "TEMPLATE_A"
            ? (await tx.outreachVersion.findFirst({ where: { messageId, generation: message.generation } }))?.id
            : message.approvedVersionId;
        if (!versionId || versionId !== peekedVersionId) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "stale version" } };
        }
        const version = await tx.outreachVersion.findUnique({ where: { id: versionId } });
        if (!version || version.generation !== message.generation || normalizeEndpoint(version.to) !== normalizeEndpoint(peekedTo ?? "")) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "stale version" } };
        }

        // Status + generation preconditions (spec: "the message is APPROVED,
        // or is A in READY" / "the generation is current").
        const isPersonal = message.kind === "PERSONAL" || message.kind === "FOLLOWUP";
        if (isPersonal && message.status !== "APPROVED") {
            return { ok: false, outcome: { status: "BLOCKED", reason: `personal message is ${message.status}, not APPROVED` } };
        }
        if (message.kind === "TEMPLATE_A" && message.status !== "READY") {
            return { ok: false, outcome: { status: "BLOCKED", reason: `template A message is ${message.status}, not READY` } };
        }

        // approvalHash recheck (personal only) — recomputed from the version
        // plus LIVE server context, not trusted from the stored value alone.
        if (isPersonal) {
            const threading = version.threading as unknown as { inReplyTo: string | null; references: string | null; threadId: string | null };
            const recomputed = computeApprovalHash({
                leadId: message.leadId, messageId, generation: message.generation,
                from: DISPATCH_FROM_ADDRESS, to: version.to, subject: version.subject, body: version.body, footer: version.footer,
                inReplyTo: threading?.inReplyTo ?? null, references: threading?.references ?? null, threadId: threading?.threadId ?? null,
            });
            if (!message.approvalHash || recomputed !== message.approvalHash) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "approval hash no longer matches" } };
            }
        }

        // Template A deadline (spec Template A: 15 minutes from intake receive time).
        if (message.kind === "TEMPLATE_A") {
            const renderInputs = version.renderInputs as unknown as { intakeReceivedAt?: string } | null;
            const intakeReceivedAt = renderInputs?.intakeReceivedAt ? new Date(renderInputs.intakeReceivedAt) : null;
            if (!intakeReceivedAt || templateADeadlinePassed(intakeReceivedAt, now())) {
                await tx.outreachMessage.update({ where: { id: messageId }, data: { status: "EXPIRED" } });
                return { ok: false, outcome: { status: "BLOCKED", reason: "template A deadline passed" } };
            }
        }

        // Freshness (spec "Suppression and cancellation — Freshness").
        const settingsRow = await tx.companySettings.findUnique({ where: { id: "singleton" }, select: { leadInboxLastPollStartedAt: true, leadInboxLastPollAt: true, leadInboxLastPollOk: true } });
        const health: PollHealth = {
            lastPollStartedAt: settingsRow?.leadInboxLastPollStartedAt ?? null,
            lastPollFinishedAt: settingsRow?.leadInboxLastPollAt ?? null,
            lastPollOk: settingsRow?.leadInboxLastPollOk ?? null,
        };
        if (message.kind === "TEMPLATE_A") {
            const renderInputs = version.renderInputs as unknown as { intakeReceivedAt?: string } | null;
            const intakeReceivedAt = renderInputs?.intakeReceivedAt ? new Date(renderInputs.intakeReceivedAt) : new Date(0);
            const fresh = templateAFreshness(health, intakeReceivedAt, now());
            if (!fresh.fresh) return { ok: false, outcome: { status: "BLOCKED", reason: "inbox check stale" } };
        } else {
            const fresh = anyDispatchFreshness(health, now());
            if (!fresh.fresh) return { ok: false, outcome: { status: "BLOCKED", reason: "inbox check stale" } };
        }

        // Mode / activation / allowlist / first-live-send (spec Dispatch "Kill switch", Release "Test identity"/"First real send").
        //
        //   OFF          -> nothing commits (checked above).
        //   TEST (or an  -> only isTest leads, to allowlisted recipients, commit.
        //   unactivated/
        //   off-prod LIVE)
        //   active LIVE  -> real (non-test) leads commit to anyone; isTest leads
        //                   are STILL allowlist-only (spec Release "Test identity").
        const mode = speedToLeadMode();
        if (mode === "OFF") return { ok: false, outcome: { status: "BLOCKED", reason: "mode is OFF" } };
        const activatedLive = mode === "LIVE" && isProduction() && (await isLiveActivatedForCurrentFingerprint());
        if (!activatedLive && !message.isTest) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "mode is TEST — only isTest leads can commit" } };
        }
        if (message.isTest && !isAllowlistedRecipient(version.to)) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "recipient not on the TEST allowlist" } };
        }
        if (message.kind === "TEMPLATE_A" && !template?.testOnly && !message.isTest) {
            // First real send (spec Release "First real send"): real (non-test) A
            // is blocked until a real, Justin-approved personal reply has reached SENT.
            if (!settings.get("firstLiveSendAt")) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "no real personal reply has been sent yet" } };
            }
        }

        // Daily cap — a conditional increment; refusing here still leaves the
        // message APPROVED/READY for the next attempt.
        const capOk = await tryIncrementDailyCounter(tx, now(), dailySendCap());
        if (!capOk) return { ok: false, outcome: { status: "BLOCKED", reason: "daily send cap reached" } };

        // Commit: insert the attempt and flip to DISPATCHING.
        const attemptId = randomUUID();
        const rfcMessageId = `<pb-${attemptId}@${MESSAGE_ID_DOMAIN}>`;
        await tx.outreachAttempt.create({
            data: { id: attemptId, messageId, versionId: version.id, rfcMessageId, committedAt: now() },
        });
        await tx.outreachMessage.update({ where: { id: messageId }, data: { status: "DISPATCHING" } });
        await logOutreachEvent(tx, { leadId: message.leadId, messageId, kind: "dispatch-committed", detail: { attemptId } });

        return {
            ok: true,
            ctx: {
                attemptId, rfcMessageId, leadId: message.leadId, isTest: message.isTest,
                version: { id: version.id, to: version.to, subject: version.subject, body: version.body, footer: version.footer, threading: version.threading },
            },
        };
    });
}

/** RFC822 headers + body, base64url-encoded for Gmail's `raw` send field. No CC, BCC or Reply-To (spec Dispatch step 2). */
export function buildRawMessage(input: { from: string; to: string; subject: string; body: string; footer: string; messageId: string; inReplyTo?: string | null; references?: string | null }): string {
    const encodeSubject = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
    const headers = [
        `From: ${input.from}`,
        `To: ${input.to}`,
        `Subject: ${encodeSubject(input.subject)}`,
        `Message-ID: ${input.messageId}`,
        input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
        input.references ? `References: ${input.references}` : null,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset="UTF-8"`,
        `Content-Transfer-Encoding: base64`,
    ].filter((h): h is string => h !== null).join("\r\n");
    const bodyText = `${input.body}\n\n${input.footer}`;
    const encodedBody = Buffer.from(bodyText, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
    const raw = `${headers}\r\n\r\n${encodedBody}\r\n`;
    return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendViaGmail(ctx: CommitContext): Promise<{ outcome: "SENT"; providerMessageId: string; threadId: string | null } | { outcome: "FAILED"; reason: string } | { outcome: "UNKNOWN_DELIVERY" }> {
    const { ensureLeadInboxAuth, gmailClientFor } = await import("./gmail-inbox-client");
    const auth = await ensureLeadInboxAuth();
    if (!auth.ok || !auth.client) return { outcome: "UNKNOWN_DELIVERY" };
    const gmail = gmailClientFor(auth.client);
    const threading = ctx.version.threading as { inReplyTo: string | null; references: string | null; threadId: string | null };
    const raw = buildRawMessage({
        from: DISPATCH_FROM_ADDRESS, to: ctx.version.to, subject: ctx.version.subject, body: ctx.version.body, footer: ctx.version.footer,
        messageId: ctx.rfcMessageId, inReplyTo: threading.inReplyTo, references: threading.references,
    });
    try {
        const res = await gmail.users.messages.send(
            { userId: "me", requestBody: { raw, threadId: threading.threadId ?? undefined } },
            { retry: false, retryConfig: { retry: 0 } } as Record<string, unknown>,
        );
        const providerMessageId = res.data.id;
        if (!providerMessageId) return { outcome: "UNKNOWN_DELIVERY" };
        return { outcome: "SENT", providerMessageId, threadId: res.data.threadId ?? null };
    } catch (error: unknown) {
        const status = (error as { code?: number; response?: { status?: number } })?.code ?? (error as { response?: { status?: number } })?.response?.status;
        if (typeof status === "number" && status >= 400 && status < 500) {
            return { outcome: "FAILED", reason: `provider ${status}` };
        }
        return { outcome: "UNKNOWN_DELIVERY" };
    }
}

/**
 * The single dispatch path (spec Dispatch): commit, then send, then record
 * the outcome. Never throws for an expected refusal — every branch is a
 * typed `DispatchOutcome`.
 */
export async function dispatchOutreach(messageId: string, db: PrismaClient = prisma, now: () => Date = () => new Date()): Promise<DispatchOutcome> {
    const committed = await commitDispatchTransaction(messageId, now, db);
    if (!committed.ok) return committed.outcome;
    const { ctx } = committed;

    const sendResult = await sendViaGmail(ctx);
    if (sendResult.outcome === "UNKNOWN_DELIVERY") {
        await logOutreachEvent(db, { leadId: ctx.leadId, messageId, kind: "dispatch-unknown-delivery", detail: { attemptId: ctx.attemptId } });
        // Left in DISPATCHING; reconciliation (reconcileUnknownDeliveries) resolves it later.
        return { status: "UNKNOWN_DELIVERY", attemptId: ctx.attemptId };
    }

    if (sendResult.outcome === "FAILED") {
        await db.$transaction([
            db.outreachAttempt.update({ where: { id: ctx.attemptId }, data: { outcome: "FAILED" } }),
            db.outreachMessage.update({ where: { id: messageId }, data: { status: "FAILED" } }),
        ]);
        await logOutreachEvent(db, { leadId: ctx.leadId, messageId, kind: "dispatch-failed", detail: { attemptId: ctx.attemptId, reason: sendResult.reason } });
        return { status: "FAILED", attemptId: ctx.attemptId, reason: sendResult.reason };
    }

    await db.$transaction(async tx => {
        await tx.outreachAttempt.update({ where: { id: ctx.attemptId }, data: { outcome: "SENT", providerMessageId: sendResult.providerMessageId, threadId: sendResult.threadId } });
        await tx.outreachMessage.update({ where: { id: messageId }, data: { status: "SENT" } });
        const message = await tx.outreachMessage.findUniqueOrThrow({ where: { id: messageId } });
        if (message.kind === "TEMPLATE_A") {
            await tx.lead.updateMany({ where: { id: ctx.leadId, firstTouchAt: null }, data: { firstTouchAt: now() } });
        } else {
            await tx.lead.updateMany({ where: { id: ctx.leadId, personalReplyAt: null }, data: { personalReplyAt: now() } });
            if (!ctx.isTest) {
                await tx.automationSetting.upsert({
                    where: { key: "firstLiveSendAt" },
                    create: { key: "firstLiveSendAt", value: now().toISOString() },
                    update: {},
                });
            }
        }
    });
    await logOutreachEvent(db, { leadId: ctx.leadId, messageId, kind: "dispatch-sent", detail: { attemptId: ctx.attemptId, providerMessageId: sendResult.providerMessageId } });
    return { status: "SENT", attemptId: ctx.attemptId, providerMessageId: sendResult.providerMessageId, threadId: sendResult.threadId };
}

/**
 * Reconciliation for UNKNOWN_DELIVERY attempts (spec Dispatch step 3):
 * "Reconciliation searches Sent for `rfc822msgid:` at 1, 5 and 30 minutes. If
 * still not found, Justin gets a push and nothing is resent." Also promotes
 * any DISPATCHING row older than DISPATCHING_STALE_MS to UNKNOWN_DELIVERY,
 * per Dispatch step 3's outcome rule.
 */
export async function reconcileUnknownDeliveries(db: PrismaClient = prisma, now: Date = new Date()): Promise<void> {
    await db.outreachMessage.updateMany({
        where: { status: "DISPATCHING", updatedAt: { lt: new Date(now.getTime() - DISPATCHING_STALE_MS) } },
        data: { status: "UNKNOWN_DELIVERY" },
    });

    const pending = await db.outreachAttempt.findMany({
        where: { outcome: null },
        include: { message: true },
    });
    const { ensureLeadInboxAuth, gmailClientFor } = await import("./gmail-inbox-client");
    const auth = await ensureLeadInboxAuth();
    for (const attempt of pending) {
        if (!auth.ok || !auth.client) continue;
        const gmail = gmailClientFor(auth.client);
        try {
            const search = await gmail.users.messages.list({ userId: "me", q: `rfc822msgid:${attempt.rfcMessageId}`, maxResults: 1 });
            const found = search.data.messages?.[0];
            if (found) {
                await db.$transaction([
                    db.outreachAttempt.update({ where: { id: attempt.id }, data: { outcome: "SENT", providerMessageId: found.id ?? undefined } }),
                    db.outreachMessage.update({ where: { id: attempt.messageId }, data: { status: "SENT" } }),
                ]);
                await logOutreachEvent(db, { leadId: attempt.message.leadId, messageId: attempt.messageId, kind: "reconcile-found", detail: { attemptId: attempt.id } });
                continue;
            }
        } catch (error) {
            console.error("[speed-to-lead] reconciliation search failed", error instanceof Error ? error.message : "UnknownError");
            continue;
        }
        const ageMin = (now.getTime() - attempt.committedAt.getTime()) / 60_000;
        if (ageMin >= 30) {
            const { pushToJustin } = await import("./push");
            await pushToJustin("Speed-to-Lead: delivery unknown", `Message ${attempt.rfcMessageId} was not found in Sent after 30 minutes. Nothing was resent.`);
            await logOutreachEvent(db, { leadId: attempt.message.leadId, messageId: attempt.messageId, kind: "reconcile-not-found-30m" });
        }
    }
}

/**
 * Cron sweep: attempts dispatch for every READY Template A message and every
 * APPROVED personal/follow-up message. Idempotent and safe to call every
 * minute — `dispatchOutreach` itself is the single commitment point, so a
 * message that already moved past APPROVED/READY is simply refused
 * (ALREADY_IN_FLIGHT or a no-op) rather than double-sent. This is what makes
 * Template A's 15-minute deadline achievable without a human clicking
 * anything, and gives an approved personal reply a retry path if its first
 * dispatch attempt (right after approval) hit a transient BLOCKED reason
 * (e.g. "inbox check stale").
 */
export async function dispatchReadyAndApproved(db: PrismaClient = prisma): Promise<{ attempted: number }> {
    const messages = await db.outreachMessage.findMany({
        where: { OR: [{ status: "READY" }, { status: "APPROVED" }] },
        select: { id: true },
    });
    for (const m of messages) {
        await dispatchOutreach(m.id, db);
    }
    return { attempted: messages.length };
}

export { normalizeEndpoint };
