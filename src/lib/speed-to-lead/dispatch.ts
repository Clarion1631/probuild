import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { computeApprovalHash, hashesMatch } from "./approval";
import { normalizeEndpoint, assertNoHeaderInjection, isValidSingleRecipient } from "./contact-endpoint";
import { logOutreachEvent } from "./audit";
import { anyDispatchFreshness, templateAFreshness, type PollHealth } from "./freshness";
import { templateADeadlinePassed, renderTemplateA } from "./template";
import { isLiveActivatedForCurrentFingerprint } from "./fingerprint";
import {
    speedToLeadMode,
    isProduction,
    isAllowlistedRecipient,
    dailySendCap,
    templateAEnabled,
    DISPATCH_FROM_ADDRESS,
    MESSAGE_ID_DOMAIN,
    DISPATCHING_STALE_MS,
    APPROVAL_COMMIT_WINDOW_MS,
    DRAFT_EXPIRY_MS,
    RECONCILE_CHECKPOINTS_MIN,
    GMAIL_REQUEST_TIMEOUT_MS,
} from "./constants";

type Tx = Prisma.TransactionClient;

export type DispatchOutcome =
    | { status: "SENT"; attemptId: string; providerMessageId: string; threadId: string | null }
    | { status: "FAILED"; attemptId: string; reason: string }
    | { status: "UNKNOWN_DELIVERY"; attemptId: string }
    | { status: "BLOCKED"; reason: string }
    | { status: "ALREADY_IN_FLIGHT" }
    | { status: "NOT_FOUND" };


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
    // Ensure every key this order needs has an always-present row FIRST. A
    // `SELECT ... FOR UPDATE` that matches zero rows locks nothing, so the
    // FIRST-EVER write to a key that has never been set (e.g. the first time
    // this company ever pauses Speed-to-Lead) could commit concurrently with
    // a dispatch that read "no row" as "not paused" and never serialized
    // against it at all. Same idempotent ensure-then-lock idiom
    // lockContactEndpoint already uses below.
    for (const key of [...keys].sort()) {
        await tx.$executeRaw`INSERT INTO "AutomationSetting" (key, value) VALUES (${key}, '') ON CONFLICT (key) DO NOTHING`;
    }
    const rows = await tx.$queryRaw<{ key: string; value: string }[]>`
        SELECT key, value FROM "AutomationSetting" WHERE key = ANY(${keys}) ORDER BY key FOR UPDATE`;
    return new Map(rows.map(r => [r.key, r.value]));
}

interface LockedTemplateRow {
    id: string; revokedAt: Date | null; approvedAt: Date | null; testOnly: boolean;
    subject: string; body: string; footer: string; fixedPhone: string; bookingBaseUrl: string; fromAddress: string;
}
async function lockTemplate(tx: Tx, templateId: string): Promise<LockedTemplateRow | null> {
    const rows = await tx.$queryRaw<LockedTemplateRow[]>`
        SELECT id, "revokedAt", "approvedAt", "testOnly", subject, body, footer, "fixedPhone", "bookingBaseUrl", "fromAddress"
        FROM "OutreachTemplate" WHERE id = ${templateId} FOR UPDATE`;
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

interface LockedLeadRow { id: string; stage: string; bookedAt: Date | null; calledAt: Date | null }
async function lockLead(tx: Tx, leadId: string): Promise<LockedLeadRow | null> {
    const rows = await tx.$queryRaw<LockedLeadRow[]>`
        SELECT id, stage, "bookedAt", "calledAt" FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
}

interface LockedMessageRow { id: string; status: string; kind: string; generation: number; leadId: string; approvedVersionId: string | null; approvalHash: string | null; isTest: boolean; dedupeKey: string; approvedAt: Date | null; createdAt: Date }
async function lockMessage(tx: Tx, messageId: string): Promise<LockedMessageRow | null> {
    const rows = await tx.$queryRaw<LockedMessageRow[]>`
        SELECT id, status, kind, generation, "leadId", "approvedVersionId", "approvalHash", "isTest", "dedupeKey", "approvedAt", "createdAt"
        FROM "OutreachMessage" WHERE id = ${messageId} FOR UPDATE`;
    return rows.length > 0 ? rows[0] : null;
}

interface CommitContext {
    attemptId: string;
    rfcMessageId: string;
    version: { id: string; to: string; subject: string; body: string; footer: string; threading: unknown };
    leadId: string;
    isTest: boolean;
    kind: string;
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
            if (!template || template.revokedAt || !template.approvedAt) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "template revoked, unapproved, or missing" } };
            }
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
        // Booked/Called cancel existing messages via cancelMessagesForLeadInTx
        // (followups.ts), but dispatch itself must ALSO refuse here — the
        // lead row is the SAME row that transaction locks, so this closes the
        // gap where a message created or re-approved AFTER a Booked/Called
        // mark would otherwise have nothing checking it at commit time.
        if (lead.bookedAt || lead.calledAt) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "lead booked or called" } };
        }
        // A JUNK intake verdict (markLeadIntakeJunk) — LeadIntakeEvent is not
        // part of the shared lock order, so this is a best-effort read rather
        // than a fully race-proof one, but it is real coverage where none
        // existed before: dispatch never checked the intake verdict at all.
        const junkIntake = await tx.leadIntakeEvent.findFirst({ where: { leadId: peek.leadId, verdict: "JUNK" }, select: { id: true } });
        if (junkIntake) {
            return { ok: false, outcome: { status: "BLOCKED", reason: "lead marked junk" } };
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

        // Draft/approval expiry (spec Approval: a 72-hour draft expires; a
        // personal approval must commit within 30 minutes or it expires). A
        // bare BLOCKED here would leave the row APPROVED/READY forever, so a
        // stale approval could fire later once an unrelated pause lift or
        // LIVE activation "releases" it — cron's dispatchReadyAndApproved
        // sweeps every APPROVED/READY row every minute regardless of age.
        // EXPIRED is a real terminal transition, the same one Template A's
        // own 15-minute deadline already uses below.
        if (now().getTime() - message.createdAt.getTime() > DRAFT_EXPIRY_MS) {
            await tx.outreachMessage.update({ where: { id: messageId }, data: { status: "EXPIRED" } });
            return { ok: false, outcome: { status: "BLOCKED", reason: "draft expired (72 hours)" } };
        }
        if (isPersonal && (!message.approvedAt || now().getTime() - message.approvedAt.getTime() > APPROVAL_COMMIT_WINDOW_MS)) {
            await tx.outreachMessage.update({ where: { id: messageId }, data: { status: "EXPIRED" } });
            return { ok: false, outcome: { status: "BLOCKED", reason: "approval window expired (30 minutes)" } };
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
            if (!message.approvalHash || !hashesMatch(recomputed, message.approvalHash)) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "approval hash no longer matches" } };
            }
        }

        // Template A: re-check everything the ELIGIBILITY decision at intake
        // time is not re-verified at commit time otherwise — the flag can be
        // turned off, the test/live split can drift, and the template's OWN
        // content can be edited after this message was created and rendered.
        if (message.kind === "TEMPLATE_A") {
            if (!template) return { ok: false, outcome: { status: "BLOCKED", reason: "template revoked, unapproved, or missing" } };
            // A testOnly template must never dispatch a non-test message (or
            // vice versa) — evaluateTemplateAEligibility already keeps these
            // aligned at intake, but the commit path re-derives everything
            // from locked rows rather than trusting that invariant silently.
            if (template.testOnly !== message.isTest) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "template test/live flag no longer matches this message" } };
            }
            // The isTest path is exempt from the live flag (spec Release:
            // "enabled for readiness runs regardless of SPEED_TO_LEAD_TEMPLATE_A")
            // — same exemption evaluateTemplateAEligibility applies at intake.
            if (!message.isTest && !templateAEnabled()) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "SPEED_TO_LEAD_TEMPLATE_A is off" } };
            }
            const renderInputs = version.renderInputs as unknown as { intakeReceivedAt?: string; name?: string; email?: string } | null;
            const intakeReceivedAt = renderInputs?.intakeReceivedAt ? new Date(renderInputs.intakeReceivedAt) : null;
            if (!intakeReceivedAt || templateADeadlinePassed(intakeReceivedAt, now())) {
                await tx.outreachMessage.update({ where: { id: messageId }, data: { status: "EXPIRED" } });
                return { ok: false, outcome: { status: "BLOCKED", reason: "template A deadline passed" } };
            }
            // Content/render integrity: re-render the CURRENTLY-locked template
            // with this version's own renderInputs and require an exact match.
            // Templates are edited in place (approveTemplate updates the same
            // row rather than versioning it) — without this, editing a
            // template after a message was rendered from it would silently
            // change nothing about the already-rendered version, but nothing
            // here would notice if the two had drifted apart for any other
            // reason either.
            if (!renderInputs?.name || !renderInputs?.email) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "template A message has no render inputs to verify" } };
            }
            const rendered = renderTemplateA(
                { subject: template.subject, body: template.body, footer: template.footer, fixedPhone: template.fixedPhone, bookingBaseUrl: template.bookingBaseUrl, fromAddress: template.fromAddress },
                { name: renderInputs.name, email: renderInputs.email },
            );
            if (rendered.subject !== version.subject || rendered.body !== version.body || rendered.footer !== version.footer) {
                return { ok: false, outcome: { status: "BLOCKED", reason: "template content has changed since this message was rendered" } };
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
                attemptId, rfcMessageId, leadId: message.leadId, isTest: message.isTest, kind: message.kind,
                version: { id: version.id, to: version.to, subject: version.subject, body: version.body, footer: version.footer, threading: version.threading },
            },
        };
    });
}

/**
 * Records a provider-confirmed send (called from the direct dispatch path
 * AND from reconciliation once a search finds the message in Sent) — the
 * single place threadId, the Lead timing fields, and firstLiveSendAt all get
 * set together, so reconciliation can never omit them the way a hand-rolled
 * second copy of this update did before.
 */
async function markAttemptSent(
    db: PrismaClient,
    ctx: { attemptId: string; messageId: string; leadId: string; kind: string; isTest: boolean; providerMessageId: string; threadId: string | null },
    now: Date,
): Promise<void> {
    await db.$transaction(async tx => {
        await tx.outreachAttempt.update({ where: { id: ctx.attemptId }, data: { outcome: "SENT", providerMessageId: ctx.providerMessageId, threadId: ctx.threadId } });
        await tx.outreachMessage.update({ where: { id: ctx.messageId }, data: { status: "SENT" } });
        if (ctx.kind === "TEMPLATE_A") {
            await tx.lead.updateMany({ where: { id: ctx.leadId, firstTouchAt: null }, data: { firstTouchAt: now } });
        } else {
            await tx.lead.updateMany({ where: { id: ctx.leadId, personalReplyAt: null }, data: { personalReplyAt: now } });
            if (!ctx.isTest) {
                await tx.automationSetting.upsert({
                    where: { key: "firstLiveSendAt" },
                    create: { key: "firstLiveSendAt", value: now.toISOString() },
                    update: {},
                });
            }
        }
    });
}

/** RFC822 headers + body, base64url-encoded for Gmail's `raw` send field. No CC, BCC or Reply-To (spec Dispatch step 2). */
export function buildRawMessage(input: { from: string; to: string; subject: string; body: string; footer: string; messageId: string; inReplyTo?: string | null; references?: string | null }): string {
    // Every value below becomes literal text inside an RFC822 header line —
    // a comma-separated `to` would bypass the per-endpoint suppression check
    // (which normalizes and looks up exactly one address), and a CR/LF in
    // ANY of them injects a brand new header (Bcc, an extra Subject, ...)
    // into the raw message before it is even base64-encoded.
    if (!isValidSingleRecipient(input.to)) throw new Error("invalid recipient: exactly one mailbox address is required");
    assertNoHeaderInjection(input.subject, "subject");
    assertNoHeaderInjection(input.messageId, "messageId");
    if (input.inReplyTo) assertNoHeaderInjection(input.inReplyTo, "inReplyTo");
    if (input.references) assertNoHeaderInjection(input.references, "references");
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

async function sendViaGmail(ctx: CommitContext, db: PrismaClient): Promise<{ outcome: "SENT"; providerMessageId: string; threadId: string | null } | { outcome: "FAILED"; reason: string } | { outcome: "UNKNOWN_DELIVERY" }> {
    const { ensureLeadInboxAuth, gmailClientFor } = await import("./gmail-inbox-client");
    // Explicitly threaded through — a caller running against a disposable
    // test database must never have this silently reach the REAL configured
    // mailbox credential via the global prisma singleton instead.
    const auth = await ensureLeadInboxAuth(db);
    if (!auth.ok || !auth.client) return { outcome: "UNKNOWN_DELIVERY" };
    const gmail = gmailClientFor(auth.client);
    const threading = ctx.version.threading as { inReplyTo: string | null; references: string | null; threadId: string | null };
    let raw: string;
    try {
        raw = buildRawMessage({
            from: DISPATCH_FROM_ADDRESS, to: ctx.version.to, subject: ctx.version.subject, body: ctx.version.body, footer: ctx.version.footer,
            messageId: ctx.rfcMessageId, inReplyTo: threading.inReplyTo, references: threading.references,
        });
    } catch (error) {
        // A recipient/header-injection validation failure here is permanent —
        // no retry will ever make this content valid — so it is a FAILED
        // outcome, never an uncaught throw (dispatchOutreach's own contract:
        // "Never throws for an expected refusal").
        return { outcome: "FAILED", reason: error instanceof Error ? error.message : "invalid message content" };
    }
    try {
        const res = await gmail.users.messages.send(
            { userId: "me", requestBody: { raw, threadId: threading.threadId ?? undefined } },
            { retry: false, retryConfig: { retry: 0 }, timeout: GMAIL_REQUEST_TIMEOUT_MS } as Record<string, unknown>,
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

    const sendResult = await sendViaGmail(ctx, db);
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

    await markAttemptSent(db, {
        attemptId: ctx.attemptId, messageId, leadId: ctx.leadId, kind: ctx.kind, isTest: ctx.isTest,
        providerMessageId: sendResult.providerMessageId, threadId: sendResult.threadId,
    }, now());
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
    const auth = await ensureLeadInboxAuth(db);
    const lastCheckpointMin = RECONCILE_CHECKPOINTS_MIN[RECONCILE_CHECKPOINTS_MIN.length - 1];
    for (const attempt of pending) {
        if (!auth.ok || !auth.client) continue;
        const ageMin = (now.getTime() - attempt.committedAt.getTime()) / 60_000;

        // Past the last checkpoint AND already reported: spec Dispatch step 3
        // says reconciliation checks at 1, 5 and 30 minutes and, if still not
        // found, "nothing is resent" — that is the end of the story for this
        // attempt. Without this the search (and the push below) ran every
        // single cron minute forever for an attempt that will never resolve.
        if (ageMin > lastCheckpointMin) {
            const alreadyReported = await db.outreachEvent.findFirst({
                where: { kind: "reconcile-not-found-30m", detail: { path: ["attemptId"], equals: attempt.id } },
            });
            if (alreadyReported) continue;
        }

        const gmail = gmailClientFor(auth.client);
        try {
            // Scoped to Sent (spec: "Reconciliation searches Sent for
            // rfc822msgid:") — an unscoped search could in principle match a
            // copy of the message elsewhere in a shared mailbox.
            const search = await gmail.users.messages.list({ userId: "me", q: `in:sent rfc822msgid:${attempt.rfcMessageId}`, maxResults: 1 }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            const found = search.data.messages?.[0];
            if (found?.id) {
                await markAttemptSent(db, {
                    attemptId: attempt.id, messageId: attempt.messageId, leadId: attempt.message.leadId,
                    kind: attempt.message.kind, isTest: attempt.message.isTest,
                    providerMessageId: found.id, threadId: found.threadId ?? null,
                }, now);
                await logOutreachEvent(db, { leadId: attempt.message.leadId, messageId: attempt.messageId, kind: "reconcile-found", detail: { attemptId: attempt.id } });
                continue;
            }
        } catch (error) {
            console.error("[speed-to-lead] reconciliation search failed", error instanceof Error ? error.message : "UnknownError");
            continue;
        }
        if (ageMin >= lastCheckpointMin) {
            const { pushToJustin } = await import("./push");
            await pushToJustin("Speed-to-Lead: delivery unknown", `Message ${attempt.rfcMessageId} was not found in Sent after 30 minutes. Nothing was resent.`);
            await logOutreachEvent(db, { leadId: attempt.message.leadId, messageId: attempt.messageId, kind: "reconcile-not-found-30m", detail: { attemptId: attempt.id } });
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
