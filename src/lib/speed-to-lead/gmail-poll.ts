import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { acquireCronLease } from "@/lib/cron-lease";
import { ensureLeadInboxAuth, gmailClientFor } from "./gmail-inbox-client";
import { authenticateMessage, type RawHeader } from "./authentication";
import { classifyInboundMessage } from "./reply-detection";
import { recordPendingFallback, intakeVoiceEvent } from "./intake";
import { suppressEndpoint, markEndpointBounced } from "./contact-endpoint";
import { cancelMessagesForLead } from "./cancellation";

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
    from: string;
    headers: RawHeader[];
    bodyText: string;
    internalDateMs: number;
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

async function fetchMessage(gmail: ReturnType<typeof gmailClientFor>, id: string): Promise<ParsedMessage | null> {
    const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = headerList(res.data.payload);
    const from = headers.find(h => h.name.toLowerCase() === "from")?.value ?? "";
    const fromEmail = /<([^>]+)>/.exec(from)?.[1] ?? from;
    return {
        id,
        from: fromEmail.trim().toLowerCase(),
        headers,
        bodyText: extractPlainText(res.data.payload),
        internalDateMs: res.data.internalDate ? Number(res.data.internalDate) : Date.now(),
    };
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

    const websiteFrom = (process.env.SPEED_TO_LEAD_WEBSITE_FROM_ADDRESS ?? "").trim().toLowerCase();
    const voiceFrom = "voice-noreply@google.com";

    const auth = authenticateMessage(parsed.headers, parsed.from);

    // Handler order (spec Intake "Order for each message"):
    //   1. authenticate (done above)
    //   2. trusted handlers first, before any drop
    //   3. replies/opt-outs next, before any exclusion
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
        await intakeVoiceEvent({ gmailMessageId: parsed.id, receivedAt: new Date(parsed.internalDateMs), callerPhone, summary: parsed.bodyText.slice(0, 2000) });
        return;
    }

    // Replies/opt-outs: "any message from an endpoint or thread we have
    // emailed" — matched by From address against a lead's client email that
    // we have an OutreachAttempt for. Our own sent copies never appear here
    // (Gmail's INBOX history does not include SENT-labeled messages we sent).
    const client = await db.client.findFirst({ where: { email: { equals: parsed.from, mode: "insensitive" } }, select: { id: true, leads: { select: { id: true }, orderBy: { createdAt: "desc" } } } });
    const everContacted = client
        ? await db.outreachMessage.findFirst({ where: { lead: { clientId: client.id }, status: { in: ["SENT", "DISPATCHING"] } } })
        : null;
    if (client && everContacted) {
        const classification = classifyInboundMessage({ fromAddress: parsed.from, headers: parsed.headers, bodyText: parsed.bodyText });
        if (classification === "auto-reply") return; // logged implicitly by not erroring; no state change
        if (classification === "bounce") {
            await markEndpointBounced(parsed.from, db);
            return;
        }
        for (const lead of client.leads) {
            await cancelMessagesForLead(lead.id, classification === "opt-out" ? "opt-out" : "reply", db);
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
        const auth = await ensureLeadInboxAuth();
        if (!auth.ok || !auth.client) {
            await recordPollHealth(db, startedAt, null, false);
            return { ran: false, reason: "lead inbox not connected" };
        }
        const gmail = gmailClientFor(auth.client);
        const settings = await db.companySettings.findUnique({ where: { id: "singleton" }, select: { leadInboxHistoryId: true } });

        if (!settings?.leadInboxHistoryId) {
            // First run: establish a cursor without processing any backlog — the
            // "launch cutoff bounds resync, so no old mail becomes a lead" promise.
            const profile = await gmail.users.getProfile({ userId: "me" });
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
                page = await gmail.users.history.list({ userId: "me", startHistoryId: settings.leadInboxHistoryId, historyTypes: ["messageAdded"], pageToken });
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
            const profile = await gmail.users.getProfile({ userId: "me" });
            await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxHistoryId: String(profile.data.historyId) } });
            await recordPollHealth(db, startedAt, new Date(), true);
            return { ran: true, processed: 0, resynced: true };
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
