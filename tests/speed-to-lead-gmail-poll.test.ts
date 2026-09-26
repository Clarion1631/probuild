/**
 * The inbox poll's cursor/resync/bounds state machine (finding 4/6), against
 * REAL Postgres for CompanySettings/LeadIntakeEvent, with a fake Gmail
 * client standing in for the Google API — no real Gmail account is ever
 * touched. The fake is applied via a manual `Module.prototype.require`
 * patch scoped to gmail-poll.ts's own literal `"./gmail-inbox-client"`
 * specifier, the same technique (and for the same Node-20-vs-`mock.module()`
 * reason) documented in tests/takeoff-convert-tax.test.ts's header comment.
 *
 * `DATABASE_URL` is pointed at the SAME disposable database as
 * `SPEED_TO_LEAD_TEST_URL` (with `?pgbouncer=true`, harmless on vanilla
 * Postgres) so `acquireCronLease`'s default store — which always uses the
 * global `src/lib/prisma.ts` singleton, not the `db` parameter passed to
 * `pollLeadInbox` — has a real, reachable database instead of failing
 * closed on every call.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

const GMAIL_INBOX_CLIENT_SPECIFIER = "./gmail-inbox-client";

interface GmailPayload {
    headers?: { name: string; value: string }[];
    mimeType?: string;
    body?: { data: string };
    parts?: unknown[];
}

interface FakeGmailScript {
    getProfile: () => { historyId: string };
    historyList?: (args: { startHistoryId: string; pageToken?: string }) => { history?: unknown[]; historyId?: string; nextPageToken?: string } | { throw404: true };
    messagesList?: (args: { q: string; pageToken?: string }) => { messages?: { id: string }[]; nextPageToken?: string };
    messagesGet?: (id: string, format: "metadata" | "full") => { payload: GmailPayload };
}

let script: FakeGmailScript | null = null;
let getCallCount = 0;
let messagesListCalls = 0;

function fakeGmailClient() {
    return {
        users: {
            getProfile: async () => ({ data: { historyId: script!.getProfile().historyId, emailAddress: "gtrsupport@goldentouchremodeling.com" } }),
            history: {
                list: async (args: { startHistoryId: string; pageToken?: string }) => {
                    const result = script!.historyList?.(args) ?? {};
                    if ((result as { throw404?: boolean }).throw404) {
                        const err = new Error("Requested entity was not found.") as Error & { code: number };
                        err.code = 404;
                        throw err;
                    }
                    return { data: result };
                },
            },
            messages: {
                list: async (args: { q: string; pageToken?: string }) => {
                    messagesListCalls++;
                    return { data: script!.messagesList?.(args) ?? {} };
                },
                get: async (args: { id: string; format: "metadata" | "full" }) => {
                    getCallCount++;
                    return { data: script!.messagesGet?.(args.id, args.format) ?? { payload: {} } };
                },
            },
        },
    };
}

let originalRequire: typeof Module.prototype.require;

before(() => {
    process.env.DATABASE_URL = `${databaseUrl}?pgbouncer=true`;
    originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === GMAIL_INBOX_CLIENT_SPECIFIER) {
            return {
                ensureLeadInboxAuth: async () => ({ ok: true, client: {} }),
                gmailClientFor: () => fakeGmailClient(),
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
});

after(() => {
    Module.prototype.require = originalRequire;
});

async function freshDb() {
    return new PrismaClient({ datasources: { db: { url: `${databaseUrl}?pgbouncer=true` } } });
}

async function resetCompanySettings(db: PrismaClient) {
    await db.companySettings.deleteMany({ where: { id: "singleton" } });
}

const WEBSITE_HEADERS_METADATA: { payload: GmailPayload } = {
    payload: {
        headers: [
            { name: "From", value: "website@goldentouchremodeling.com" },
            { name: "Subject", value: "New website inquiry" },
            { name: "X-Google-Group-Id", value: "347075611006" },
            { name: "List-ID", value: "<Connect.goldentouchremodeling.com>" },
            { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@goldentouchremodeling.com header.s=google; arc=pass (i=2); dmarc=pass header.from=goldentouchremodeling.com" },
            { name: "ARC-Seal", value: "i=1; a=rsa-sha256; cv=none; d=google.com; s=x; t=1; b=z" },
            { name: "ARC-Authentication-Results", value: "i=1; mx.google.com; dkim=pass header.i=@goldentouchremodeling.com header.s=resend header.b=x; dmarc=pass header.from=goldentouchremodeling.com" },
        ],
    },
};

const UNTRUSTED_HEADERS_METADATA: { payload: GmailPayload } = {
    payload: {
        headers: [
            { name: "From", value: "someone@example.com" },
            { name: "Subject", value: "Re: your invoice" },
        ],
    },
};

test("first run establishes a cursor without processing any backlog", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        script = { getProfile: () => ({ historyId: "100" }) };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");
        const result = await pollLeadInbox(db, new Date());
        assert.equal(result.ran, true);
        assert.equal(result.processed, 0);
        const settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        assert.equal(settings?.leadInboxHistoryId, "100");
        assert.ok(settings?.leadInboxCutoffAt);
    } finally {
        await db.$disconnect();
    }
});

test("a trusted website message costs exactly two message-get calls (metadata, then full) and becomes a PENDING_FALLBACK row", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        await db.companySettings.create({ data: { id: "singleton", leadInboxHistoryId: "100", leadInboxCutoffAt: new Date(Date.now() - 60_000) } });
        getCallCount = 0;
        script = {
            getProfile: () => ({ historyId: "999" }),
            historyList: () => ({ history: [{ messagesAdded: [{ message: { id: "web-msg-1" } }] }], historyId: "101" }),
            messagesGet: (id, format) => {
                if (format === "metadata") return WEBSITE_HEADERS_METADATA;
                return { payload: { mimeType: "text/plain", body: { data: Buffer.from("Name: Jane\nEmail: jane@example.com\nMessage:\nplease call me about a remodel").toString("base64url") } } };
            },
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");
        const result = await pollLeadInbox(db, new Date());
        assert.equal(result.ran, true);
        assert.equal(result.processed, 1);
        assert.equal(getCallCount, 2, "metadata-first: exactly one metadata get plus one full get for a trusted sender");

        const rows = await db.leadIntakeEvent.findMany({ where: { source: "WEB_EMAIL_FALLBACK" }, orderBy: { createdAt: "desc" }, take: 1 });
        assert.equal(rows[0]?.state, "PENDING_FALLBACK");

        const settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        assert.equal(settings?.leadInboxHistoryId, "101");
    } finally {
        await db.$disconnect();
    }
});

test("a non-trusted message costs exactly one metadata get and creates no intake row", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        await db.companySettings.create({ data: { id: "singleton", leadInboxHistoryId: "200", leadInboxCutoffAt: new Date(Date.now() - 60_000) } });
        getCallCount = 0;
        const before = await db.leadIntakeEvent.count();
        script = {
            getProfile: () => ({ historyId: "999" }),
            historyList: () => ({ history: [{ messagesAdded: [{ message: { id: "spam-msg-1" } }] }], historyId: "201" }),
            messagesGet: (_id, format) => (format === "metadata" ? UNTRUSTED_HEADERS_METADATA : { payload: {} }),
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");
        const result = await pollLeadInbox(db, new Date());
        assert.equal(result.processed, 1);
        assert.equal(getCallCount, 1, "an untrusted message must never trigger a full fetch");
        const after = await db.leadIntakeEvent.count();
        assert.equal(after, before, "no intake row for an untrusted message");
    } finally {
        await db.$disconnect();
    }
});

test("an expired history cursor (404) resyncs via messages.list and the new cursor is the pre-scan H0", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        const now = new Date();
        await db.companySettings.create({
            data: { id: "singleton", leadInboxHistoryId: "stale-cursor", leadInboxCutoffAt: new Date(now.getTime() - 60 * 60 * 1000), leadInboxLastPollStartedAt: new Date(now.getTime() - 30 * 60 * 1000) },
        });
        script = {
            getProfile: () => ({ historyId: "h0-after-resync" }),
            historyList: () => ({ throw404: true }),
            messagesList: () => ({ messages: [{ id: "voice-msg-1" }] }),
            messagesGet: (_id, format) => {
                if (format === "metadata") {
                    return {
                        payload: {
                            headers: [
                                { name: "From", value: "Google Voice <voice-noreply@google.com>" },
                                { name: "Subject", value: "New missed call from (360) 555-0100" },
                                { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@google.com header.s=x; dmarc=pass header.from=google.com" },
                            ],
                        },
                    };
                }
                return { payload: { mimeType: "text/plain", body: { data: Buffer.from("Missed call from (360) 555-0100").toString("base64url") } } };
            },
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");
        const result = await pollLeadInbox(db, now);
        assert.equal(result.resynced, true);
        const settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        assert.equal(settings?.leadInboxHistoryId, "h0-after-resync");
        const rows = await db.leadIntakeEvent.findMany({ where: { source: "VOICE" }, orderBy: { createdAt: "desc" }, take: 1 });
        assert.equal(rows[0]?.verdict, "REVIEW");
    } finally {
        await db.$disconnect();
    }
});

test("the fixed per-run message-get budget can be exhausted by leading untrusted messages before a trusted one is ever reached, and the cursor never commits past it", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        await db.companySettings.create({ data: { id: "singleton", leadInboxHistoryId: "500", leadInboxCutoffAt: new Date(Date.now() - 60_000) } });
        // 60 untrusted messages (each costs exactly one metadata `get`) ahead
        // of a single trusted one — comfortably more than MAX_MESSAGE_GETS
        // (50), so the run-budget exhausts on an untrusted message before the
        // trusted one is ever reached.
        const untrustedIds = Array.from({ length: 60 }, (_, i) => `untrusted-${i}`);
        const messagesAdded = [...untrustedIds, "trusted-1"].map(id => ({ message: { id } }));
        script = {
            getProfile: () => ({ historyId: "999" }),
            historyList: () => ({ history: [{ messagesAdded }], historyId: "600" }),
            messagesGet: (id, format) => {
                if (id === "trusted-1") return format === "metadata" ? WEBSITE_HEADERS_METADATA : { payload: { mimeType: "text/plain", body: { data: Buffer.from("Name: Jane\nEmail: jane@example.com\nMessage:\nplease call me about a remodel").toString("base64url") } } };
                return UNTRUSTED_HEADERS_METADATA;
            },
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");
        const result = await pollLeadInbox(db, new Date());
        assert.equal(result.ran, true);
        assert.equal(result.processed, 50, "exactly MAX_MESSAGE_GETS untrusted messages processed before the budget ran out");

        const settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        assert.equal(settings?.leadInboxHistoryId, "500", "the cursor must NOT advance while the trusted message further down the list is still unhandled");
        const pending = settings?.leadInboxIncrementalState as unknown as { newHistoryId: string; pendingMessageIds: string[] } | null;
        assert.equal(pending?.newHistoryId, "600");
        assert.equal(pending?.pendingMessageIds.length, 11, "the 10 remaining untrusted messages plus the trusted one must be persisted for the next run");
        assert.ok(pending?.pendingMessageIds.includes("trusted-1"), "the trusted message must still be queued, not lost");

        // Scoped to THIS message's own externalId (voice:trusted-1 — the
        // WEBSITE_HEADERS_METADATA fixture carries no X-GTR-Submission-Id),
        // not a bare source filter — an earlier test in this same file
        // leaves its own WEB_EMAIL_FALLBACK row behind.
        const row = await db.leadIntakeEvent.findUnique({ where: { externalId: "voice:trusted-1" } });
        assert.equal(row, null, "the trusted message must not be recorded until it is actually reached");
    } finally {
        await db.$disconnect();
    }
});

test("repeated poll runs make forward progress through a persisted budget-exhausted queue, eventually recording the trusted message and committing the cursor — with no message ever re-fetched", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        await db.companySettings.create({ data: { id: "singleton", leadInboxHistoryId: "500", leadInboxCutoffAt: new Date(Date.now() - 60_000) } });
        const untrustedIds = Array.from({ length: 60 }, (_, i) => `untrusted-${i}`);
        const messagesAdded = [...untrustedIds, "trusted-1"].map(id => ({ message: { id } }));
        getCallCount = 0;
        script = {
            getProfile: () => ({ historyId: "999" }),
            historyList: () => ({ history: [{ messagesAdded }], historyId: "600" }),
            messagesGet: (id, format) => {
                if (id === "trusted-1") return format === "metadata" ? WEBSITE_HEADERS_METADATA : { payload: { mimeType: "text/plain", body: { data: Buffer.from("Name: Jane\nEmail: jane@example.com\nMessage:\nplease call me about a remodel").toString("base64url") } } };
                return UNTRUSTED_HEADERS_METADATA;
            },
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");

        let settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        let runs = 0;
        while (settings?.leadInboxHistoryId !== "600" && runs < 10) {
            await pollLeadInbox(db, new Date());
            settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
            runs++;
        }
        assert.ok(runs > 1, "the scenario must actually require more than one run to finish");
        assert.equal(settings?.leadInboxHistoryId, "600", "the cursor must eventually commit once every message is handled");
        assert.equal(settings?.leadInboxIncrementalState, null, "no leftover queue once done");

        const row = await db.leadIntakeEvent.findUnique({ where: { externalId: "voice:trusted-1" } });
        assert.ok(row, "the trusted message buried behind 60 untrusted ones must eventually be recorded");
        assert.equal(row?.source, "WEB_EMAIL_FALLBACK");

        // 60 untrusted messages x 1 get each, plus the trusted message's 2
        // gets (metadata + full) = 62 total, no matter how many runs it took
        // — proves no message was ever re-fetched across runs.
        assert.equal(getCallCount, 62, "every message must be fetched exactly once across all runs combined");
    } finally {
        await db.$disconnect();
    }
});

test("11 history pages plus 60 leading untrusted messages: pagination resumes via a persisted page token across runs, page 11's trusted message is eventually processed, and the cursor advances only once enumeration is fully complete (round-4: incremental starvation)", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        await db.companySettings.create({ data: { id: "singleton", leadInboxHistoryId: "1000", leadInboxCutoffAt: new Date(Date.now() - 60_000) } });
        getCallCount = 0;
        let historyListCalls = 0;
        // Pages 1-10 hold 4 leading untrusted messages each (40 total, well
        // under MAX_MESSAGE_GETS on their own) — page 11 alone would be
        // unreachable under the OLD code's page cap (MAX_HISTORY_PAGES=10)
        // with no persisted page token to resume from. Page 11 then adds 20
        // more untrusted messages (60 leading untrusted overall) plus the
        // one trusted message, last.
        script = {
            getProfile: () => ({ historyId: "999" }),
            historyList: (args: { pageToken?: string }) => {
                historyListCalls++;
                const pageNum = args.pageToken ? Number(args.pageToken.replace("page-", "")) : 1;
                const ids = pageNum <= 10
                    ? Array.from({ length: 4 }, (_, i) => `untrusted-p${pageNum}-${i}`)
                    : [...Array.from({ length: 20 }, (_, i) => `untrusted-p11-${i}`), "trusted-p11"];
                return {
                    history: [{ messagesAdded: ids.map(id => ({ message: { id } })) }],
                    historyId: "1100",
                    nextPageToken: pageNum < 11 ? `page-${pageNum + 1}` : undefined,
                };
            },
            messagesGet: (id, format) => {
                if (id === "trusted-p11") {
                    return format === "metadata"
                        ? WEBSITE_HEADERS_METADATA
                        : { payload: { mimeType: "text/plain", body: { data: Buffer.from("Name: Jane\nEmail: jane@example.com\nMessage:\nplease call me about a remodel").toString("base64url") } } };
                }
                return UNTRUSTED_HEADERS_METADATA;
            },
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");

        let settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        let runs = 0;
        while (settings?.leadInboxHistoryId !== "1100" && runs < 10) {
            await pollLeadInbox(db, new Date());
            settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
            runs++;
            if (runs === 1) {
                assert.equal(settings?.leadInboxHistoryId, "1000", "the cursor must not advance while page 11 is still unreached");
            }
        }
        assert.ok(runs > 1 && runs < 10, `the scenario must span more than one run and actually terminate, got ${runs}`);
        assert.equal(settings?.leadInboxHistoryId, "1100", "the cursor advances only once enumeration is fully complete");
        assert.equal(settings?.leadInboxIncrementalState, null, "no leftover incremental state once done");
        assert.equal(historyListCalls, 11, "each of the 11 history pages must be fetched exactly once across every run combined — no page 1-10 refetch loop");
        assert.equal(getCallCount, 62, "60 untrusted x 1 get + 1 trusted x 2 gets = 62, no matter how many runs — proves no message is ever re-fetched");

        const row = await db.leadIntakeEvent.findUnique({ where: { externalId: "voice:trusted-p11" } });
        assert.ok(row, "the trusted message on page 11, behind 60 leading untrusted ones, must eventually be recorded");
        assert.equal(row?.source, "WEB_EMAIL_FALLBACK");
    } finally {
        await db.$disconnect();
    }
});

test("a resync whose last page's own leftover messages exceed one run's budget terminates in a bounded number of runs, instead of re-listing from page 1 forever (round-4: pagination-done vs not-started ambiguity)", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        const now = new Date();
        await db.companySettings.create({
            data: { id: "singleton", leadInboxHistoryId: "stale-cursor-2", leadInboxCutoffAt: new Date(now.getTime() - 60 * 60 * 1000), leadInboxLastPollStartedAt: new Date(now.getTime() - 30 * 60 * 1000) },
        });
        getCallCount = 0;
        let messagesListCallsLocal = 0;
        // Page 1 (10 messages) plus page 2 — the LAST page (no
        // nextPageToken) — with 45 more: 55 total, more than one run's
        // MAX_MESSAGE_GETS (50), so page 2's own trailing messages are left
        // pending with `pageToken: null` — the exact same representation a
        // FRESH, not-yet-started resync also uses. Without an explicit
        // "pagination is actually done" flag, draining that leftover on the
        // next run would fall through into re-listing page 1 forever.
        const page1Ids = Array.from({ length: 10 }, (_, i) => `resync-a-${i}`);
        const page2Ids = Array.from({ length: 45 }, (_, i) => `resync-b-${i}`);
        script = {
            getProfile: () => ({ historyId: "h0-after-resync-2" }),
            historyList: () => ({ throw404: true }),
            messagesList: (args: { pageToken?: string }) => {
                messagesListCallsLocal++;
                if (!args.pageToken) return { messages: page1Ids.map(id => ({ id })), nextPageToken: "resync-page-2" };
                if (args.pageToken === "resync-page-2") return { messages: page2Ids.map(id => ({ id })) };
                throw new Error(`unexpected pageToken ${args.pageToken}`);
            },
            messagesGet: () => UNTRUSTED_HEADERS_METADATA,
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");

        let settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        let runs = 0;
        while (settings?.leadInboxHistoryId !== "h0-after-resync-2" && runs < 5) {
            await pollLeadInbox(db, now);
            settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
            runs++;
        }
        assert.ok(runs > 1 && runs <= 3, `must terminate in a small, bounded number of runs, got ${runs}`);
        assert.equal(settings?.leadInboxHistoryId, "h0-after-resync-2", "the resync must actually complete and commit its H0 cursor");
        assert.equal(settings?.leadInboxResyncState, null, "no leftover resync state once done");
        assert.equal(messagesListCallsLocal, 2, "each of the resync's 2 pages must be listed exactly once across every run combined — no re-list from page 1");
        assert.equal(getCallCount, 55, "all 55 messages (10 + 45) must be fetched exactly once total, no matter how many runs it took");
    } finally {
        await db.$disconnect();
    }
});

test("a gap over 72h resets the cutoff to now WITHOUT attempting a resync scan", { skip }, async () => {
    const db = await freshDb();
    try {
        await resetCompanySettings(db);
        const now = new Date();
        const veryOld = new Date(now.getTime() - 100 * 60 * 60 * 1000);
        await db.companySettings.create({ data: { id: "singleton", leadInboxHistoryId: "ancient-cursor", leadInboxCutoffAt: veryOld, leadInboxLastPollStartedAt: veryOld } });
        messagesListCalls = 0;
        script = {
            getProfile: () => ({ historyId: "h0-after-gap" }),
            historyList: () => ({ throw404: true }),
        };
        const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");
        const result = await pollLeadInbox(db, now);
        assert.equal(result.resynced, true);
        assert.equal(messagesListCalls, 0, "an unrecoverable gap must never attempt the resync scan");
        const settings = await db.companySettings.findUnique({ where: { id: "singleton" } });
        assert.equal(settings?.leadInboxHistoryId, "h0-after-gap");
        assert.ok(settings!.leadInboxCutoffAt!.getTime() >= now.getTime() - 1000);
    } finally {
        await db.$disconnect();
    }
});
