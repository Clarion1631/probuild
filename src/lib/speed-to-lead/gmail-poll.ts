import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { acquireCronLease } from "@/lib/cron-lease";
import { ensureLeadInboxAuth, gmailClientFor } from "./gmail-inbox-client";
import { authenticateMessage, type RawHeader } from "./authentication";
import { parseFallbackEmail } from "./fallback-email";
import { recordPendingFallback, intakeVoiceEvent } from "./intake";
import { sendPlainNtfy } from "./alerts";
import { GMAIL_REQUEST_TIMEOUT_MS } from "./constants";
import { safeErrorCategory } from "./error-category";

/**
 * Read-only inbox poll (v1a: gmail.readonly only, no send scope). Runs every
 * minute, in every mode including OFF (there is no customer-facing safety
 * processing left to gate — v1a has no opt-out/reply/bounce handling at
 * all — but the poll still needs to run in OFF for the lead-inbox health
 * page to show a live status, and running it costs nothing customers can
 * see). Bounded per run (finding 6): at most 10 history pages, 50 message
 * `get` calls, and 40s of wall time.
 */

const POLL_LEASE_MS = 55_000;
const POLL_LEASE_KEY = "speedToLeadPollLease";
const MAX_HISTORY_PAGES = 10;
const MAX_MESSAGE_GETS = 50;
const WALL_TIME_BUDGET_MS = 40_000;
const RESYNC_WINDOW_MS = 72 * 60 * 60 * 1000;
const RESYNC_LOOKBACK_MS = 10 * 60 * 1000;
const BACKOFF_MINUTES = [1, 2, 4, 8, 15] as const;
const POLL_ALERT_SENT_KEY = "speedToLeadPollAlertSentAt";
const POLL_DISCONNECTED_ALERT_KEY = "speedToLeadInboxDisconnectedAlertSent";

export interface PollResult {
    ran: boolean;
    reason?: string;
    processed?: number;
    resynced?: boolean;
}

interface ResyncState {
    /** The historyId captured via getProfile BEFORE the resync scan started — becomes the new cursor once the scan finishes, so anything newer is read from here next run (finding 4d). */
    h0: string;
    sinceSeconds: number;
    pageToken: string | null;
}

function headerList(payload: { headers?: { name?: string | null; value?: string | null }[] | null } | undefined): RawHeader[] {
    return (payload?.headers ?? []).map(h => ({ name: h.name ?? "", value: h.value ?? "" }));
}

function extractPlainText(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const part = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    for (const child of part.parts ?? []) {
        const found = extractPlainText(child);
        if (found) return found;
    }
    if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ");
    }
    return "";
}

function isGoogleApiError(error: unknown, status: number): boolean {
    const code = (error as { code?: number })?.code ?? (error as { response?: { status?: number } })?.response?.status;
    return code === status;
}

function isInvalidGrant(error: unknown): boolean {
    const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
    return data?.error === "invalid_grant" || (error instanceof Error && error.message.includes("invalid_grant"));
}

function submissionIdFromHeaders(headers: RawHeader[]): string | null {
    return headers.find(h => h.name.toLowerCase() === "x-gtr-submission-id")?.value?.trim() || null;
}

/** A budget shared across one poll run's message-get calls, history pages and wall clock. */
class RunBudget {
    private gets = 0;
    private pages = 0;
    private readonly deadline: number;
    constructor(nowMs: number) {
        this.deadline = nowMs + WALL_TIME_BUDGET_MS;
    }
    get exhausted(): boolean {
        return this.gets >= MAX_MESSAGE_GETS || Date.now() > this.deadline;
    }
    get pagesExhausted(): boolean {
        return this.pages >= MAX_HISTORY_PAGES || Date.now() > this.deadline;
    }
    spendGet(): void { this.gets += 1; }
    spendPage(): void { this.pages += 1; }
}

/**
 * Metadata-first: the ~200 other connect@ Group messages the Group also
 * relays cost exactly one `get` each. `full` (body) is fetched ONLY once
 * `authenticateMessage` has already trusted the sender from metadata alone.
 */
/**
 * Returns false only when the budget ran out mid-message, AFTER the metadata
 * fetch already found a TRUSTED sender but BEFORE the full fetch/record could
 * run — i.e. this specific message was never actually recorded and must not
 * be treated as handled (finding: "silent, permanent lead loss"). Every other
 * outcome (untrusted, deleted/404, or fully recorded) returns true.
 */
async function processMessage(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, id: string, budget: RunBudget, now: Date): Promise<boolean> {
    if (budget.exhausted) return false;
    budget.spendGet();
    let metaRes;
    try {
        metaRes = await gmail.users.messages.get(
            { userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Authentication-Results", "ARC-Seal", "ARC-Authentication-Results", "X-Google-Group-Id", "List-ID", "X-GTR-Submission-Id"] },
            { timeout: GMAIL_REQUEST_TIMEOUT_MS },
        );
    } catch (error) {
        // A message the history feed listed can be deleted/expunged before we
        // fetch it — skip THIS message only; never abort the whole poll.
        if (isGoogleApiError(error, 404)) return true;
        throw error;
    }
    const headers = headerList(metaRes.data.payload);
    const from = /<([^>]+)>/.exec(headers.find(h => h.name.toLowerCase() === "from")?.value ?? "")?.[1]
        ?? headers.find(h => h.name.toLowerCase() === "from")?.value ?? "";
    const fromEmail = from.trim().toLowerCase();

    const auth = authenticateMessage(headers, fromEmail);
    if (!auth.trusted) return true;

    if (budget.exhausted) return false;
    budget.spendGet();
    let fullRes;
    try {
        fullRes = await gmail.users.messages.get({ userId: "me", id, format: "full" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
    } catch (error) {
        if (isGoogleApiError(error, 404)) return true;
        throw error;
    }
    const bodyText = extractPlainText(fullRes.data.payload);
    const internalDateMs = fullRes.data.internalDate ? Number(fullRes.data.internalDate) : now.getTime();

    if (auth.rule === "website-group-relay") {
        const submissionId = submissionIdFromHeaders(headers);
        const payload = parseFallbackEmail({ headers, bodyText, submissionId });
        await db.$transaction(tx => recordPendingFallback(tx, { gmailMessageId: id, receivedAt: new Date(internalDateMs), payload }));
        return true;
    }
    if (auth.rule === "voice-direct") {
        await intakeVoiceEvent({ gmailMessageId: id, receivedAt: new Date(internalDateMs), callerPhoneRaw: bodyText, summary: bodyText.slice(0, 2000) }, db);
        return true;
    }
    return true;
}

async function recordPollHealth(db: PrismaClient, startedAt: Date, finishedAt: Date | null, ok: boolean, extra: Record<string, unknown> = {}) {
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok, ...extra },
        update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok, ...extra },
    });
}

async function recordFailureAndBackoff(db: PrismaClient, startedAt: Date, now: Date, error: unknown): Promise<void> {
    if (isInvalidGrant(error)) {
        await db.companySettings.upsert({
            where: { id: "singleton" },
            create: { id: "singleton", leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxRefreshTokenEnc: null },
            update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxRefreshTokenEnc: null },
        });
        const already = await db.automationSetting.findUnique({ where: { key: POLL_DISCONNECTED_ALERT_KEY } });
        if (!already) {
            await sendPlainNtfy("Speed-to-Lead: lead inbox disconnected", "gtrsupport@ revoked or expired its Gmail connection. Reconnect it in Settings > Speed-to-Lead.");
            await db.automationSetting.create({ data: { key: POLL_DISCONNECTED_ALERT_KEY, value: now.toISOString() } }).catch(() => undefined);
        }
        return;
    }

    const current = await db.companySettings.findUnique({ where: { id: "singleton" }, select: { leadInboxFailureCount: true } });
    const failureCount = (current?.leadInboxFailureCount ?? 0) + 1;
    const minutes = BACKOFF_MINUTES[Math.min(failureCount - 1, BACKOFF_MINUTES.length - 1)];
    const nextPollAt = new Date(now.getTime() + minutes * 60 * 1000);
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxFailureCount: failureCount, leadInboxNextPollAt: nextPollAt },
        update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: null, leadInboxLastPollOk: false, leadInboxFailureCount: failureCount, leadInboxNextPollAt: nextPollAt },
    });

    if (failureCount >= BACKOFF_MINUTES.length) {
        const already = await db.automationSetting.findUnique({ where: { key: POLL_ALERT_SENT_KEY } });
        if (!already) {
            await sendPlainNtfy("Speed-to-Lead: inbox poll failing", `The lead-inbox poll has failed ${failureCount} times in a row.`);
            await db.automationSetting.create({ data: { key: POLL_ALERT_SENT_KEY, value: now.toISOString() } }).catch(() => undefined);
        }
    }
}

async function recordSuccessAndClearBackoff(db: PrismaClient): Promise<void> {
    await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxFailureCount: 0, leadInboxNextPollAt: null } }).catch(() => undefined);
    await db.automationSetting.delete({ where: { key: POLL_ALERT_SENT_KEY } }).catch(() => undefined);
    await db.automationSetting.delete({ where: { key: POLL_DISCONNECTED_ALERT_KEY } }).catch(() => undefined);
}

/**
 * Runs a bounded slice of the paginated `messages.list` resync (finding 4:
 * Gmail's documented recovery from an expired `history.list` cursor).
 * Persists progress in `CompanySettings.leadInboxResyncState` and resumes
 * across runs rather than restarting — a resync that needs more than one
 * run's budget must not reprocess mail it already handled, and must not
 * silently drop mail it has not reached yet.
 */
async function runResyncSlice(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, state: ResyncState, budget: RunBudget, now: Date): Promise<{ done: boolean; processed: number; nextState: ResyncState }> {
    let processed = 0;
    let pageToken = state.pageToken ?? undefined;
    do {
        if (budget.pagesExhausted) {
            return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null } };
        }
        budget.spendPage();
        const page = await gmail.users.messages.list({ userId: "me", q: `after:${state.sinceSeconds}`, pageToken }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
        for (const m of page.data.messages ?? []) {
            if (!m.id) continue;
            if (budget.exhausted) return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null } };
            // A false return means THIS message's budget cutoff landed after
            // it was found trusted but before it could be recorded — must be
            // reported as incomplete immediately, not just relying on the
            // budget.exhausted check above catching it on the NEXT message
            // (there may be no next message in this page/batch).
            const completed = await processMessage(db, gmail, m.id, budget, now);
            if (!completed) return { done: false, processed, nextState: { ...state, pageToken: pageToken ?? null } };
            processed++;
        }
        pageToken = page.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { done: true, processed, nextState: state };
}

/**
 * Runs every minute, in every mode including OFF. Holds a lease so
 * overlapping cron invocations never process the same batch twice.
 */
export async function pollLeadInbox(db: PrismaClient = prisma, now: Date = new Date()): Promise<PollResult> {
    const lease = await acquireCronLease(POLL_LEASE_KEY, POLL_LEASE_MS);
    if (!lease) return { ran: false, reason: "lease held by another run" };
    const startedAt = now;
    try {
        const settingsRow = await db.companySettings.findUnique({
            where: { id: "singleton" },
            select: {
                leadInboxHistoryId: true, leadInboxCutoffAt: true, leadInboxLastPollAt: true, leadInboxLastPollStartedAt: true,
                leadInboxNextPollAt: true, leadInboxResyncState: true,
            },
        });

        if (settingsRow?.leadInboxNextPollAt && now.getTime() < settingsRow.leadInboxNextPollAt.getTime()) {
            return { ran: false, reason: "backing off after repeated failures" };
        }

        const auth = await ensureLeadInboxAuth(db);
        if (!auth.ok || !auth.client) {
            await recordPollHealth(db, startedAt, null, false);
            return { ran: false, reason: "lead inbox not connected" };
        }
        const gmail = gmailClientFor(auth.client);
        const budget = new RunBudget(now.getTime());

        // A resync from a PRIOR run is still in progress — finish it (or make
        // another bounded pass) before considering anything else.
        const savedResync = settingsRow?.leadInboxResyncState as unknown as ResyncState | null;
        if (savedResync?.h0) {
            const result = await runResyncSlice(db, gmail, savedResync, budget, now);
            if (result.done) {
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: result.nextState.h0, leadInboxResyncState: Prisma.JsonNull } });
                await recordPollHealth(db, startedAt, new Date(), true);
                await recordSuccessAndClearBackoff(db);
                return { ran: true, processed: result.processed, resynced: true };
            }
            await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxResyncState: result.nextState as unknown as object } });
            await recordPollHealth(db, startedAt, new Date(), true);
            return { ran: true, processed: result.processed, resynced: true };
        }

        if (!settingsRow?.leadInboxHistoryId) {
            // First run: establish a cursor without processing any backlog.
            const profile = await gmail.users.getProfile({ userId: "me" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            await db.companySettings.upsert({
                where: { id: "singleton" },
                create: { id: "singleton", leadInboxHistoryId: String(profile.data.historyId), leadInboxCutoffAt: now },
                update: { leadInboxHistoryId: String(profile.data.historyId), leadInboxCutoffAt: now },
            });
            await recordPollHealth(db, startedAt, new Date(), true);
            await recordSuccessAndClearBackoff(db);
            return { ran: true, processed: 0 };
        }

        const messageIds = new Set<string>();
        let pageToken: string | undefined;
        let newHistoryId: string | null = settingsRow.leadInboxHistoryId;
        let historyExpired = false;
        // Set when the page cap cuts pagination short. `page.data.historyId`
        // is the MAILBOX'S CURRENT historyId (the same value on every page of
        // one history.list series), not "historyId as of the pages fetched so
        // far" — committing it as the new cursor after only a partial scan
        // would permanently skip every history record on the pages never
        // reached (finding: "permanently skipping unread history").
        let pagesCappedOut = false;
        do {
            if (budget.pagesExhausted) { pagesCappedOut = true; break; }
            budget.spendPage();
            let page;
            try {
                page = await gmail.users.history.list({ userId: "me", startHistoryId: settingsRow.leadInboxHistoryId, historyTypes: ["messageAdded"], pageToken }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            } catch (error) {
                if (isGoogleApiError(error, 404)) { historyExpired = true; break; }
                throw error;
            }
            for (const h of page.data.history ?? []) {
                for (const added of h.messagesAdded ?? []) {
                    if (added.message?.id) messageIds.add(added.message.id);
                }
            }
            if (page.data.historyId) newHistoryId = String(page.data.historyId);
            pageToken = page.data.nextPageToken ?? undefined;
        } while (pageToken);

        if (historyExpired) {
            // finding 4a: capture H0 via getProfile BEFORE scanning old mail,
            // so anything that arrives DURING the resync is still covered
            // next run (the cursor becomes H0, not "now").
            const profile = await gmail.users.getProfile({ userId: "me" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            const h0 = String(profile.data.historyId);

            const rawSinceMs = Math.max(
                settingsRow.leadInboxCutoffAt?.getTime() ?? 0,
                (settingsRow.leadInboxLastPollStartedAt?.getTime() ?? 0) - RESYNC_LOOKBACK_MS,
            );
            const floorMs = now.getTime() - RESYNC_WINDOW_MS;
            if (rawSinceMs > 0 && rawSinceMs < floorMs) {
                // finding 4f: the real gap exceeds 72h — that window is
                // unrecoverable. Reset the cutoff to now and notify ONCE,
                // naming the window, rather than silently truncating it.
                await sendPlainNtfy(
                    "Speed-to-Lead: inbox poll gap",
                    `The lead inbox could not be resynced past a 72-hour gap. Unscanned window: ${new Date(rawSinceMs).toISOString()} to ${new Date(floorMs).toISOString()}.`,
                );
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: h0, leadInboxCutoffAt: now, leadInboxResyncState: Prisma.JsonNull } });
                await recordPollHealth(db, startedAt, new Date(), true);
                await recordSuccessAndClearBackoff(db);
                return { ran: true, processed: 0, resynced: true };
            }

            const sinceSeconds = Math.max(0, Math.floor(Math.max(rawSinceMs, floorMs) / 1000));
            const result = await runResyncSlice(db, gmail, { h0, sinceSeconds, pageToken: null }, budget, now);
            if (result.done) {
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: h0, leadInboxResyncState: Prisma.JsonNull } });
            } else {
                await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxResyncState: result.nextState as unknown as object } });
            }
            await recordPollHealth(db, startedAt, new Date(), true);
            await recordSuccessAndClearBackoff(db);
            return { ran: true, processed: result.processed, resynced: true };
        }

        let processed = 0;
        let allComplete = true;
        for (const id of messageIds) {
            if (budget.exhausted) { allComplete = false; break; }
            // A false return means budget ran out mid-message, after this one
            // was already found trusted but before it could be recorded — it
            // must count as NOT durably processed, or the cursor gate below
            // would advance past it (see processMessage's own doc comment).
            const completed = await processMessage(db, gmail, id, budget, now);
            if (!completed) { allComplete = false; break; }
            processed++;
        }

        // Cursor advances only after every listed message was durably
        // processed AND every history page that exists was actually fetched
        // (or the budget stopped us — in which case the NEXT run's
        // history.list, starting from the SAME cursor, simply re-lists the
        // same page; a message already processed is a no-op via its
        // externalId's ON CONFLICT DO NOTHING).
        if (!pagesCappedOut && allComplete && processed === messageIds.size) {
            await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: newHistoryId } });
        }
        await recordPollHealth(db, startedAt, new Date(), true);
        await recordSuccessAndClearBackoff(db);
        return { ran: true, processed };
    } catch (error) {
        console.error("[speed-to-lead] inbox poll failed", safeErrorCategory(error));
        await recordFailureAndBackoff(db, startedAt, now, error);
        return { ran: false, reason: "error" };
    } finally {
        await lease.release();
    }
}
