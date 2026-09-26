import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { acquireCronLease } from "@/lib/cron-lease";
import { ensureLeadInboxAuth, gmailClientFor } from "./gmail-inbox-client";
import { authenticateMessage, type RawHeader } from "./authentication";
import { classifyInboundMessage } from "./reply-detection";
import { recordPendingFallback, intakeVoiceEvent } from "./intake";
import { suppressEndpoint, markEndpointBounced, normalizeEndpoint } from "./contact-endpoint";
import { cancelMessagesForLead } from "./cancellation";
import { DISPATCH_FROM_ADDRESS, GMAIL_REQUEST_TIMEOUT_MS } from "./constants";
import { logOutreachEvent } from "./audit";
import { pushToJustin } from "./push";

const POLL_LEASE_MS = 55_000;
const POLL_LEASE_KEY = "speedToLeadPollLease";

export interface PollResult {
    ran: boolean;
    reason?: string;
    processed?: number;
    resynced?: boolean;
}

interface ParsedMessage {
    id: string;
    /** Gmail's own thread id — correlates a reply to an OutreachAttempt even when it arrives from a different address than the one we emailed. */
    threadId: string | null;
    from: string;
    headers: RawHeader[];
    bodyText: string;
    /** The machine-readable `message/delivery-status` MIME part, if this is a `multipart/report` DSN — "" for an ordinary message. */
    deliveryStatusText: string;
    internalDateMs: number;
}

function headerList(payload: { headers?: { name?: string | null; value?: string | null }[] | null } | undefined): RawHeader[] {
    return (payload?.headers ?? []).map(h => ({ name: h.name ?? "", value: h.value ?? "" }));
}

/**
 * Converts an HTML body to plain text WITHOUT destroying the quote boundary:
 * a `<blockquote>` (how Gmail and most clients mark quoted history in HTML
 * mail) carries no leading `>` of its own the way plain-text quoting does,
 * so a bare tag-strip collapses the new reply and the quoted original —
 * including OUR OWN footer text quoted back at us — into one undifferentiated
 * blob. stripQuotedText (reply-detection.ts) only knows how to strip lines
 * that start with `>`, so blockquoted content is re-marked with that prefix
 * before tags are removed.
 */
function htmlToPlainText(html: string): string {
    let text = html
        .replace(/<(?:br)\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div)>/gi, "\n");
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) => {
        const innerPlain = inner.replace(/<[^>]+>/g, " ");
        // Leading/trailing "\n" force the quoted lines onto their OWN
        // line(s), whether or not the source HTML runs straight from
        // preceding/following text into the tag with no whitespace of its
        // own (e.g. "Thanks<blockquote>...no thanks...</blockquote>"). Without
        // it the "> " prefix lands mid-line ("Thanks> ...no thanks..."),
        // which does not start with ">" and so is never recognized as quoted
        // by stripQuotedText's line-based filter — a bounced-back copy of our
        // OWN opt-out footer, quoted in a genuine reply, then reads as the
        // REPLIER'S OWN opt-out.
        return `\n${innerPlain.split("\n").map(line => `> ${line.trim()}`).join("\n")}\n`;
    });
    return text.replace(/<[^>]+>/g, " ");
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
        return htmlToPlainText(Buffer.from(part.body.data, "base64url").toString("utf8"));
    }
    return "";
}

/**
 * RFC 3464/1894 machine-readable DSN fields live in a SIBLING
 * `message/delivery-status` MIME part of a `multipart/report`, never inside
 * the human-readable `text/plain`/`text/html` part `extractPlainText` walks —
 * a real bounce's `Final-Recipient`/`Original-Recipient` fields there were
 * never read at all before this.
 */
function extractDeliveryStatusText(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const part = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    if (part.mimeType === "message/delivery-status" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    for (const child of part.parts ?? []) {
        const found = extractDeliveryStatusText(child);
        if (found) return found;
    }
    return "";
}

async function fetchMessage(gmail: ReturnType<typeof gmailClientFor>, id: string): Promise<ParsedMessage | null> {
    let res;
    try {
        res = await gmail.users.messages.get({ userId: "me", id, format: "full" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
    } catch (error) {
        // A message the history feed listed can be deleted/expunged before we
        // fetch it — that must skip THIS message, never abort the whole poll
        // (an uncaught error here used to fail pollLeadInbox entirely, which
        // never advances the cursor, so every subsequent run re-hit the same
        // deleted message and got stuck at that point forever).
        if (isGoogleApiError(error, 404)) return null;
        throw error;
    }
    const headers = headerList(res.data.payload);
    const from = headers.find(h => h.name.toLowerCase() === "from")?.value ?? "";
    const fromEmail = /<([^>]+)>/.exec(from)?.[1] ?? from;
    return {
        id,
        threadId: res.data.threadId ?? null,
        from: fromEmail.trim().toLowerCase(),
        headers,
        bodyText: extractPlainText(res.data.payload),
        deliveryStatusText: extractDeliveryStatusText(res.data.payload),
        internalDateMs: res.data.internalDate ? Number(res.data.internalDate) : Date.now(),
    };
}

/** RFC 3464 DSN bounces name the address that actually failed in a Final-Recipient/Original-Recipient (or, for some MTAs, an X-Failed-Recipients) header — never assume it is the mailer-daemon From address itself. Checks the machine-readable `message/delivery-status` part FIRST (where a real DSN actually carries these fields), falling back to the human-readable body for MTAs that only echo them there. */
function extractFailedRecipient(msg: { headers: RawHeader[]; bodyText: string; deliveryStatusText: string }): string | null {
    const xFailed = msg.headers.find(h => h.name.toLowerCase() === "x-failed-recipients")?.value;
    if (xFailed) return xFailed.split(",")[0]?.trim().toLowerCase() || null;
    const dsnPattern = /(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i;
    const dsnMatch = dsnPattern.exec(msg.deliveryStatusText) ?? dsnPattern.exec(msg.bodyText);
    if (dsnMatch) return dsnMatch[1].trim().toLowerCase();
    return null;
}

/**
 * Leads we have actually contacted at this exact address — sourced from
 * OutreachAttempt (a durable, immutable record of every real dispatch commit)
 * joined to the SPECIFIC version it actually sent, never from the message's
 * CURRENT status or an arbitrary version under it. Two reasons this must not
 * be `OutreachMessage.status IN (...) AND versions.some(to = email)`, the
 * previous shape:
 *   1. "Send again" (actions.ts) can return a previously-SENT message to
 *      DRAFT/APPROVED for a retry — its CURRENT status would then no longer
 *      be SENT/DISPATCHING/UNKNOWN_DELIVERY, silently hiding a real past
 *      contact that undeniably happened.
 *   2. `versions.some` matches ANY version ever created under the message,
 *      including one from a different generation that was edited but NEVER
 *      actually dispatched — that generation's `to` address was never really
 *      contacted just because some OTHER generation of the same message was.
 * An attempt's own outcome (never FAILED — a definite submit-time rejection,
 * never actually delivered) is the correct predicate; NULL (still
 * DISPATCHING/UNKNOWN_DELIVERY) and SENT both count.
 */
async function findLeadIdsContactedAt(db: PrismaClient, email: string): Promise<Set<string>> {
    const rows = await db.$queryRaw<{ leadId: string }[]>`
        SELECT DISTINCT m."leadId" AS "leadId"
        FROM "OutreachAttempt" a
        JOIN "OutreachVersion" v ON v.id = a."versionId"
        JOIN "OutreachMessage" m ON m.id = a."messageId"
        WHERE (a.outcome IS NULL OR a.outcome != 'FAILED') AND LOWER(v.to) = LOWER(${email})`;
    return new Set(rows.map(r => r.leadId));
}

/** Leads correlated by Gmail THREAD to a message we sent — catches a reply that arrives from a different address than the one we emailed. Same OutreachAttempt-sourced predicate as findLeadIdsContactedAt above, for the same reasons. */
async function findLeadIdsByThread(db: PrismaClient, threadId: string): Promise<Set<string>> {
    const rows = await db.$queryRaw<{ leadId: string }[]>`
        SELECT DISTINCT m."leadId" AS "leadId"
        FROM "OutreachAttempt" a
        JOIN "OutreachMessage" m ON m.id = a."messageId"
        WHERE a."threadId" = ${threadId} AND (a.outcome IS NULL OR a.outcome != 'FAILED')`;
    return new Set(rows.map(r => r.leadId));
}

function isGoogleApiError(error: unknown, status: number): boolean {
    const code = (error as { code?: number })?.code ?? (error as { response?: { status?: number } })?.response?.status;
    return code === status;
}

/** From gtr-sales-draft's contact route (spec Intake handler order #2/#1): the header the site sets so a forwarded/fallback copy can be tied to its webhook twin. */
function submissionIdFromHeaders(headers: RawHeader[]): string | null {
    return headers.find(h => h.name.toLowerCase() === "x-gtr-submission-id")?.value?.trim() || null;
}

async function recordPollHealth(db: PrismaClient, startedAt: Date, finishedAt: Date | null, ok: boolean) {
    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok },
        update: { leadInboxLastPollStartedAt: startedAt, leadInboxLastPollAt: finishedAt, leadInboxLastPollOk: ok },
    });
}

async function processMessage(db: PrismaClient, gmail: ReturnType<typeof gmailClientFor>, id: string): Promise<void> {
    const parsed = await fetchMessage(gmail, id);
    if (!parsed) return;

    // Mailbox-wide history polling (historyTypes: ["messageAdded"]) surfaces
    // OUR OWN sent copies too, not just inbound mail — explicitly skip them
    // rather than relying on them happening not to match anything below.
    if (parsed.from === normalizeEndpoint(DISPATCH_FROM_ADDRESS)) return;

    const websiteFrom = (process.env.SPEED_TO_LEAD_WEBSITE_FROM_ADDRESS ?? "").trim().toLowerCase();
    const voiceFrom = "voice-noreply@google.com";

    const auth = authenticateMessage(parsed.headers, parsed.from);

    // Handler order (spec Intake "Order for each message"):
    //   1. authenticate (done above)
    //   2. trusted handlers first, before any drop
    //   3. replies/opt-outs/bounces next, before any exclusion
    //   4. everything else ignored
    if (auth.trusted && websiteFrom && parsed.from === websiteFrom) {
        const submissionId = submissionIdFromHeaders(parsed.headers);
        await recordPendingFallback(db, {
            submissionId,
            gmailMessageId: parsed.id,
            receivedAt: new Date(parsed.internalDateMs),
            rawPayload: { fromRaw: parsed.from, bodyText: parsed.bodyText, headers: parsed.headers },
        });
        return;
    }
    if (auth.trusted && parsed.from === voiceFrom) {
        const callerPhone = /\+?\d[\d\s().-]{6,}\d/.exec(parsed.bodyText)?.[0]?.trim() ?? null;
        // db was never passed through here — every voice intake silently used
        // the global prisma singleton regardless of what this poll run was
        // actually given (the same isolation gap fixed elsewhere for Gmail
        // credential loading).
        const outcome = await intakeVoiceEvent({ gmailMessageId: parsed.id, receivedAt: new Date(parsed.internalDateMs), callerPhone, summary: parsed.bodyText.slice(0, 2000) }, db);
        // Goal 3: push Justin within 5 minutes of a Voice voicemail/missed
        // call — this path never pushed at all before.
        if (outcome.won) {
            await pushToJustin("New voicemail/missed call", callerPhone ? `From ${callerPhone}` : "Caller number unavailable");
        }
        return;
    }

    // Bounces are handled FIRST and separately from the "contacted identity"
    // check below: a bounce's From is mailer-daemon@..., which never matches
    // a lead we contacted, so gating bounce handling behind that check (the
    // old shape) made every ordinary DSN bounce unreachable. The address that
    // actually failed lives in the DSN body/headers, never in From — using
    // From here would suppress our OWN sending mailbox instead of the
    // recipient that bounced, and skip cancelling that lead's messages.
    const classification = classifyInboundMessage({ fromAddress: parsed.from, headers: parsed.headers, bodyText: parsed.bodyText });
    if (classification === "bounce") {
        const failedRecipient = extractFailedRecipient(parsed);
        if (failedRecipient) {
            // Contact correlation FIRST, suppression only if it is non-empty.
            // classifyInboundMessage's `isBounce` is a plain From-address/
            // Content-Type pattern match — trivially forgeable by anyone
            // sending mail (no authentication is required or even possible
            // for a real bounce, since bounces are generated unsigned by
            // intermediate MTAs) — so ANYONE can shape a message that reads
            // as a bounce and name an arbitrary `X-Failed-Recipients` address.
            // Suppressing that address unconditionally (the previous shape)
            // let a forged bounce silently suppress an address Speed-to-Lead
            // never even contacted, in every mode including OFF (this poll
            // runs regardless of mode). Scoping suppression to an address we
            // can actually prove we dispatched to closes that without
            // requiring authentication real bounces could never satisfy.
            const leadIds = await findLeadIdsContactedAt(db, failedRecipient);
            if (leadIds.size > 0) {
                await markEndpointBounced(failedRecipient, db);
                for (const leadId of leadIds) await cancelMessagesForLead(leadId, "bounce", db);
            }
        }
        return;
    }

    // Replies/opt-outs: "any message from an endpoint or thread we have
    // emailed" — matched against the actual RECIPIENT address a SENT/
    // DISPATCHING/UNKNOWN_DELIVERY message went to, or by Gmail THREAD
    // correlation to an attempt we made. A Client row's current primary
    // email (the old check) misses an address that changed since, an
    // additional/duplicate client sharing the address, and any send still
    // resolving as UNKNOWN_DELIVERY — all of which could make a valid
    // opt-out simply disappear.
    const leadIds = new Set<string>([
        ...(await findLeadIdsContactedAt(db, parsed.from)),
        ...(parsed.threadId ? await findLeadIdsByThread(db, parsed.threadId) : []),
    ]);
    if (leadIds.size > 0) {
        if (classification === "auto-reply") {
            for (const leadId of leadIds) {
                await logOutreachEvent(db, { leadId, kind: "auto-reply-ignored", detail: { fromAddress: parsed.from } });
            }
            return;
        }
        for (const leadId of leadIds) {
            await cancelMessagesForLead(leadId, classification === "opt-out" ? "opt-out" : "reply", db);
        }
        if (classification === "opt-out") {
            await suppressEndpoint(parsed.from, { reason: "opt-out", source: "poll" }, db);
        }
        return;
    }

    // 4. everything else — ignored in v1.
}

/**
 * Runs every minute, in every mode including OFF (spec Intake: "It runs in
 * every mode, including OFF, because it also processes opt-outs"). Holds a
 * lease so overlapping cron invocations never process the same batch twice.
 */
export async function pollLeadInbox(db: PrismaClient = prisma, now: Date = new Date()): Promise<PollResult> {
    const lease = await acquireCronLease(POLL_LEASE_KEY, POLL_LEASE_MS);
    if (!lease) return { ran: false, reason: "lease held by another run" };
    const startedAt = now;
    try {
        const auth = await ensureLeadInboxAuth(db);
        if (!auth.ok || !auth.client) {
            await recordPollHealth(db, startedAt, null, false);
            return { ran: false, reason: "lead inbox not connected" };
        }
        const gmail = gmailClientFor(auth.client);
        const settings = await db.companySettings.findUnique({
            where: { id: "singleton" },
            select: { leadInboxHistoryId: true, leadInboxCutoffAt: true, leadInboxLastPollAt: true },
        });

        if (!settings?.leadInboxHistoryId) {
            // First run: establish a cursor without processing any backlog — the
            // "launch cutoff bounds resync, so no old mail becomes a lead" promise.
            const profile = await gmail.users.getProfile({ userId: "me" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            await db.companySettings.upsert({
                where: { id: "singleton" },
                create: { id: "singleton", leadInboxHistoryId: String(profile.data.historyId), leadInboxCutoffAt: now },
                update: { leadInboxHistoryId: String(profile.data.historyId), leadInboxCutoffAt: now },
            });
            await recordPollHealth(db, startedAt, new Date(), true);
            return { ran: true, processed: 0 };
        }

        const messageIds = new Set<string>();
        let pageToken: string | undefined;
        let newHistoryId: string | null = settings.leadInboxHistoryId;
        let resynced = false;
        do {
            let page;
            try {
                page = await gmail.users.history.list({ userId: "me", startHistoryId: settings.leadInboxHistoryId, historyTypes: ["messageAdded"], pageToken }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            } catch (error) {
                if (isGoogleApiError(error, 404)) {
                    resynced = true;
                    break;
                }
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

        if (resynced) {
            // Expired history (404): Gmail's documented recovery is a bounded
            // full sync via messages.list, not silently jumping the cursor to
            // "now" — that used to lose every missed opt-out, fallback
            // submission and voicemail between the old cursor and now without
            // even marking the poll unhealthy. Bounded below by the launch
            // cutoff (never resync earlier than the point Speed-to-Lead first
            // started polling) and by the last successful poll's finish time
            // (the safe lower bound if polling itself had been down).
            const sinceMs = Math.max(
                settings.leadInboxCutoffAt?.getTime() ?? 0,
                settings.leadInboxLastPollAt?.getTime() ?? 0,
            );
            const sinceSeconds = Math.max(0, Math.floor(sinceMs / 1000));
            let resyncPageToken: string | undefined;
            const resyncIds = new Set<string>();
            do {
                const page = await gmail.users.messages.list({ userId: "me", q: `after:${sinceSeconds}`, pageToken: resyncPageToken }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
                for (const m of page.data.messages ?? []) {
                    if (m.id) resyncIds.add(m.id);
                }
                resyncPageToken = page.data.nextPageToken ?? undefined;
            } while (resyncPageToken);

            for (const resyncId of resyncIds) {
                await processMessage(db, gmail, resyncId);
            }

            const profile = await gmail.users.getProfile({ userId: "me" }, { timeout: GMAIL_REQUEST_TIMEOUT_MS });
            await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: String(profile.data.historyId) } });
            await recordPollHealth(db, startedAt, new Date(), true);
            return { ran: true, processed: resyncIds.size, resynced: true };
        }

        let processed = 0;
        for (const id of messageIds) {
            await processMessage(db, gmail, id);
            processed++;
        }

        // Cursor advances only after every message above was durably processed.
        await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: newHistoryId } });
        await recordPollHealth(db, startedAt, new Date(), true);
        return { ran: true, processed };
    } catch (error) {
        console.error("[speed-to-lead] inbox poll failed", error instanceof Error ? error.message : "UnknownError");
        await recordPollHealth(db, startedAt, null, false);
        return { ran: false, reason: "error" };
    } finally {
        await lease.release();
    }
}
