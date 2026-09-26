/**
 * The lead-inbox windowed scan (src/lib/speed-to-lead/gmail-poll.ts), against
 * REAL Postgres for CompanySettings / LeadInboxMessage / LeadIntakeEvent, with
 * a fake Gmail mailbox standing in for the Google API: no real Gmail account
 * is ever touched. The fake honors the scan's own query (`from:` senders and
 * `after:<epoch>` against each message's internalDate), `includeSpamTrash`,
 * and pagination, so the window arithmetic is actually exercised. It is
 * applied via a manual `Module.prototype.require` patch scoped to
 * gmail-poll.ts's own literal `"./gmail-inbox-client"` specifier, the same
 * technique (and for the same Node-20-vs-`mock.module()` reason) documented in
 * tests/takeoff-convert-tax.test.ts's header comment. ntfy pushes are captured
 * by replacing `globalThis.fetch`, so nothing leaves the process.
 *
 * Every poll gets an explicit logical `now`, so time is deterministic.
 *
 * `DATABASE_URL` is pointed at the SAME disposable database as
 * `SPEED_TO_LEAD_TEST_URL` (with `?pgbouncer=true`, harmless on vanilla
 * Postgres) so `acquireCronLease`'s default store, which always uses the
 * global `src/lib/prisma.ts` singleton, has a real, reachable database.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

const GMAIL_INBOX_CLIENT_SPECIFIER = "./gmail-inbox-client";
const RUN = `pt${Date.now().toString(36)}`;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

interface GmailPayload {
    headers?: { name: string; value: string }[];
    mimeType?: string;
    body?: { data: string };
    parts?: unknown[];
}

interface FakeMessage {
    id: string;
    internalDateMs: number;
    /** The From address the search index sees. */
    from: string;
    metadata: GmailPayload;
    full?: GmailPayload;
    /** Not yet visible to search (index lag); `get` still works. */
    hidden?: boolean;
    /** Throw a 500 on the next N `get` calls for this message. */
    failGets?: number;
}

let mailbox: FakeMessage[] = [];
let pageSize = 100;
let connected = true;
/** Throw a 500 on list calls whose 1-based index within a poll is in this set (reset per poll). */
let failListPages = new Set<number>();
let failAllLists = false;
let listCallsThisPoll = 0;
let afterListHook: (() => void) | null = null;
let listCalls: { q: string; pageToken?: string; includeSpamTrash?: boolean }[] = [];
let getCalls: { id: string; format: string }[] = [];

function httpError(code: number, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function searchMatches(q: string): FakeMessage[] {
    const afterSec = Number(/after:(\d+)/.exec(q)?.[1] ?? "0");
    const froms = [...q.matchAll(/from:([^\s{}]+)/g)].map(m => m[1].toLowerCase());
    return mailbox
        .filter(m => !m.hidden && froms.includes(m.from.toLowerCase()) && m.internalDateMs >= afterSec * 1000)
        .sort((a, b) => b.internalDateMs - a.internalDateMs);
}

function fakeGmailClient() {
    return {
        users: {
            messages: {
                list: async (args: { q: string; pageToken?: string; includeSpamTrash?: boolean }) => {
                    listCalls.push({ q: args.q, pageToken: args.pageToken, includeSpamTrash: args.includeSpamTrash });
                    listCallsThisPoll += 1;
                    if (failAllLists || failListPages.has(listCallsThisPoll)) throw httpError(500, "Backend Error");
                    const matches = searchMatches(args.q);
                    const offset = args.pageToken ? Number(args.pageToken.replace("off-", "")) : 0;
                    const slice = matches.slice(offset, offset + pageSize);
                    const next = offset + pageSize < matches.length ? `off-${offset + pageSize}` : undefined;
                    const data = { messages: slice.map(m => ({ id: m.id })), nextPageToken: next };
                    afterListHook?.();
                    return { data };
                },
                get: async (args: { id: string; format: "metadata" | "full" }) => {
                    getCalls.push({ id: args.id, format: args.format });
                    const message = mailbox.find(m => m.id === args.id);
                    if (!message) throw httpError(404, "Requested entity was not found.");
                    if (message.failGets && message.failGets > 0) {
                        message.failGets -= 1;
                        throw httpError(500, "Backend Error");
                    }
                    const payload = args.format === "metadata" ? message.metadata : message.full ?? {};
                    return { data: { id: message.id, internalDate: String(message.internalDateMs), payload } };
                },
            },
        },
    };
}

// ── ntfy capture ────────────────────────────────────────────────────────────
let pushes: { title: string; body: string }[] = [];
let ntfyUp = true;
const originalFetch = globalThis.fetch;
let originalRequire: typeof Module.prototype.require;

before(() => {
    process.env.DATABASE_URL = `${databaseUrl}?pgbouncer=true`;
    delete process.env.SPEED_TO_LEAD_TRUSTED_SENDERS;
    process.env.SPEED_TO_LEAD_NTFY_TOPIC = "poll-test-topic";
    process.env.SPEED_TO_LEAD_NTFY_BASE_URL = "http://ntfy.invalid";
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
        if (!ntfyUp) return new Response("down", { status: 503 });
        pushes.push({ title: init?.headers?.Title ?? "", body: String(init?.body ?? "") });
        return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === GMAIL_INBOX_CLIENT_SPECIFIER) {
            return {
                ensureLeadInboxAuth: async () => (connected ? { ok: true, client: {} } : { ok: false }),
                gmailClientFor: () => fakeGmailClient(),
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
});

after(async () => {
    Module.prototype.require = originalRequire;
    globalThis.fetch = originalFetch;
    if (!databaseUrl) return;
    // Remove every intake row (and any Lead a Voice intake created) this file wrote.
    const db = freshDb();
    try {
        const events = await db.leadIntakeEvent.findMany({ where: { OR: [{ externalId: { contains: RUN } }, { submissionId: { contains: RUN } }] }, select: { id: true, leadId: true } });
        await db.leadIntakeEvent.deleteMany({ where: { id: { in: events.map(e => e.id) } } });
        const leadIds = events.map(e => e.leadId).filter((id): id is string => !!id);
        if (leadIds.length) await db.lead.deleteMany({ where: { id: { in: leadIds } } });
        await resetState(db);
    } catch (error) {
        // Cleanup only: never turn a passing suite red over leftover rows in a throwaway database.
        console.warn("[gmail-poll test] cleanup failed", error instanceof Error ? error.name : error);
    } finally {
        await db.$disconnect();
    }
});

beforeEach(() => {
    mailbox = [];
    pageSize = 100;
    connected = true;
    failListPages = new Set();
    failAllLists = false;
    afterListHook = null;
    listCalls = [];
    getCalls = [];
    pushes = [];
    ntfyUp = true;
});

function freshDb() {
    return new PrismaClient({ datasources: { db: { url: `${databaseUrl}?pgbouncer=true` } } });
}

const MARKER_KEYS = [
    "speedToLeadPollLease",
    "speedToLeadPollAlertSentAt",
    "speedToLeadInboxDisconnectedAlertSent",
    "speedToLeadScanStaleAlertSentAt",
    "speedToLeadUnacceptedNoticeSentAt",
];

async function resetState(db: PrismaClient) {
    await db.companySettings.deleteMany({ where: { id: "singleton" } });
    await db.leadInboxMessage.deleteMany({});
    await db.automationSetting.deleteMany({ where: { key: { in: MARKER_KEYS } } });
}

async function seedSettings(db: PrismaClient, data: { cutoffAt: Date; watermarkAt: Date }) {
    await db.companySettings.create({ data: { id: "singleton", leadInboxCutoffAt: data.cutoffAt, leadInboxScanWatermarkAt: data.watermarkAt } });
}

async function poll(db: PrismaClient, now: Date) {
    listCallsThisPoll = 0;
    const { pollLeadInbox } = await import("../src/lib/speed-to-lead/gmail-poll");
    return pollLeadInbox(db, now);
}

async function settingsOf(db: PrismaClient) {
    return db.companySettings.findUnique({ where: { id: "singleton" } });
}

// ── Fixtures (the real R0-captured header shapes) ───────────────────────────

const WEBSITE_BODY: GmailPayload = { mimeType: "text/plain", body: { data: Buffer.from("Name: Jane\nEmail: jane@example.com\nMessage:\nplease call me about a remodel").toString("base64url") } };

function websiteMetadata(submissionId?: string): GmailPayload {
    return {
        headers: [
            { name: "From", value: "website@goldentouchremodeling.com" },
            { name: "Subject", value: "New website inquiry" },
            { name: "X-Google-Group-Id", value: "347075611006" },
            { name: "List-ID", value: "<Connect.goldentouchremodeling.com>" },
            { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@goldentouchremodeling.com header.s=google; arc=pass (i=2); dmarc=pass header.from=goldentouchremodeling.com" },
            { name: "ARC-Seal", value: "i=1; a=rsa-sha256; cv=none; d=google.com; s=x; t=1; b=z" },
            { name: "ARC-Authentication-Results", value: "i=1; mx.google.com; dkim=pass header.i=@goldentouchremodeling.com header.s=resend header.b=x; dmarc=pass header.from=goldentouchremodeling.com" },
            { name: "ARC-Seal", value: "i=2; a=rsa-sha256; cv=pass; d=google.com; s=x; t=2; b=y" },
            { name: "ARC-Authentication-Results", value: "i=2; mx.google.com; dkim=pass header.i=@goldentouchremodeling.com header.s=google; arc=pass (i=2); dmarc=pass header.from=goldentouchremodeling.com" },
            ...(submissionId ? [{ name: "X-GTR-Submission-Id", value: submissionId }] : []),
        ],
    };
}

function website(id: string, internalDateMs: number, extra: Partial<FakeMessage> = {}): FakeMessage {
    return { id: `${RUN}-${id}`, internalDateMs, from: "website@goldentouchremodeling.com", metadata: websiteMetadata(), full: WEBSITE_BODY, ...extra };
}

/** A spoofed `From: website@` with none of the Group/ARC chain: authentication rejects it. */
function forgedWebsite(id: string, internalDateMs: number): FakeMessage {
    return {
        id: `${RUN}-${id}`,
        internalDateMs,
        from: "website@goldentouchremodeling.com",
        metadata: { headers: [{ name: "From", value: "website@goldentouchremodeling.com" }, { name: "Subject", value: "New website inquiry" }, { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@goldentouchremodeling.com header.s=google; dmarc=pass header.from=goldentouchremodeling.com" }] },
    };
}

function voice(id: string, internalDateMs: number, phone: string): FakeMessage {
    return {
        id: `${RUN}-${id}`,
        internalDateMs,
        from: "voice-noreply@google.com",
        metadata: {
            headers: [
                { name: "From", value: "Google Voice <voice-noreply@google.com>" },
                { name: "Subject", value: `New missed call from ${phone}` },
                { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@google.com header.s=x; dmarc=pass header.from=google.com" },
            ],
        },
        full: { mimeType: "text/plain", body: { data: Buffer.from(`Missed call from ${phone}`).toString("base64url") } },
    };
}

function intakeRow(db: PrismaClient, messageId: string) {
    return db.leadIntakeEvent.findUnique({ where: { externalId: `voice:${messageId}` } });
}

function gets(id: string) {
    return getCalls.filter(c => c.id === id).length;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("first connected run pins the floor: mail older than the connection is never imported, and mail after it is", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Math.floor(Date.now() / 1000) * 1000;
        const backlog = website("t1-backlog", T - 2 * HOUR);
        mailbox = [backlog];

        const first = await poll(db, new Date(T));
        assert.equal(first.ran, true);
        assert.equal(first.complete, true);
        let settings = await settingsOf(db);
        assert.equal(settings?.leadInboxCutoffAt?.getTime(), T);
        assert.equal(settings?.leadInboxScanWatermarkAt?.getTime(), T);
        assert.ok(listCalls[0].q.includes(`after:${T / 1000 - 1}`), `the first window starts at the floor (one second of slack): ${listCalls[0].q}`);
        assert.ok(listCalls[0].q.includes("from:website@goldentouchremodeling.com") && listCalls[0].q.includes("from:voice-noreply@google.com"), "the query names exactly the trusted senders");
        assert.equal(listCalls[0].includeSpamTrash, true, "a lead Gmail filed as spam or a human trashed is still listed");

        const arrived = website("t1-new", T + 30_000);
        mailbox.push(arrived);
        await poll(db, new Date(T + MINUTE));
        assert.ok(await intakeRow(db, arrived.id), "mail after the connection is imported");
        assert.equal(gets(backlog.id), 0, "the pre-connection backlog is never fetched");
        settings = await settingsOf(db);
        assert.equal(settings?.leadInboxScanWatermarkAt?.getTime(), T + MINUTE);
    } finally {
        await db.$disconnect();
    }
});

test("a trusted website message costs two gets (metadata, then full) and becomes a PENDING_FALLBACK row plus an INTAKE ledger row", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - 5 * MINUTE) });
        const message = website("t2", T - 2 * MINUTE);
        mailbox = [message];

        const result = await poll(db, new Date(T));
        assert.deepEqual({ ran: result.ran, processed: result.processed, complete: result.complete }, { ran: true, processed: 1, complete: true });
        assert.deepEqual(getCalls.map(c => c.format), ["metadata", "full"]);
        assert.equal((await intakeRow(db, message.id))?.state, "PENDING_FALLBACK");
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: message.id } }))?.outcome, "INTAKE");
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), T, "a complete scan moves the watermark to its own start time");
        assert.equal(pushes.length, 0, "an accepted lead produces no poller push (its alert is the intake path's own)");
    } finally {
        await db.$disconnect();
    }
});

test("a lead-sender message authentication turns away costs one get, makes no intake row, and is pushed to Justin; other senders are never even listed", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - 5 * MINUTE) });
        const forged = forgedWebsite("t3-forged", T - 3 * MINUTE);
        const welcome = { ...voice("t3-welcome", T - 2 * MINUTE, "(360) 555-0103") };
        welcome.metadata = { headers: welcome.metadata.headers!.map(h => (h.name === "Subject" ? { name: "Subject", value: "Welcome to Google Voice" } : h)) };
        const stranger: FakeMessage = { id: `${RUN}-t3-stranger`, internalDateMs: T - MINUTE, from: "someone@example.com", metadata: { headers: [{ name: "From", value: "someone@example.com" }] } };
        mailbox = [forged, welcome, stranger];

        const result = await poll(db, new Date(T));
        assert.equal(result.complete, true);
        assert.equal(gets(forged.id), 1);
        assert.equal(gets(welcome.id), 1);
        assert.equal(gets(stranger.id), 0, "the narrow sender query never lists other mail");
        assert.equal(await intakeRow(db, forged.id), null);
        assert.equal(await intakeRow(db, welcome.id), null);

        const ledger = await db.leadInboxMessage.findMany({ where: { gmailMessageId: { in: [forged.id, welcome.id] } } });
        assert.deepEqual(ledger.map(r => r.outcome).sort(), ["REJECTED", "REJECTED"]);
        assert.ok(ledger.every(r => r.notifiedAt), "both are marked reported");
        assert.equal(pushes.length, 1, "one batched push");
        assert.match(pushes[0].title, /not taken in as leads/);
        assert.ok(pushes[0].body.includes(forged.id) && pushes[0].body.includes(welcome.id));
    } finally {
        await db.$disconnect();
    }
});

test("a scan that fails mid-way does not advance the watermark, and the next scan picks up the missed message without re-fetching the rest", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        const watermark = new Date(T - 5 * MINUTE);
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: watermark });
        pageSize = 2;
        const messages = [1, 2, 3, 4].map(n => website(`t4-${n}`, T - n * MINUTE));
        mailbox = [...messages];
        failListPages = new Set([2]);

        const first = await poll(db, new Date(T));
        assert.deepEqual({ ran: first.ran, reason: first.reason }, { ran: false, reason: "error" });
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), watermark.getTime(), "the watermark must not move");
        const page2 = messages.slice(2);
        for (const m of page2) assert.equal(await intakeRow(db, m.id), null, "page 2 was never reached");

        failListPages = new Set();
        const second = await poll(db, new Date(T + 2 * MINUTE));
        assert.equal(second.complete, true);
        for (const m of messages) assert.ok(await intakeRow(db, m.id), `${m.id} recorded`);
        assert.equal(getCalls.length, 8, "4 messages x 2 gets: page 1's messages were not fetched again");
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), T + 2 * MINUTE);
    } finally {
        await db.$disconnect();
    }
});

test("a message whose get fails stays open without holding back the leads after it or delaying the next poll, and a later scan finishes it (the 30-minute-old case)", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        // The watermark has been pinned 30 minutes back by an earlier failure.
        const watermark = new Date(T - 30 * MINUTE);
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: watermark });
        const stuck = website("t5-stuck", T - 29 * MINUTE, { failGets: 3 });
        const fresh = website("t5-fresh", T - MINUTE);
        mailbox = [stuck, fresh];

        const first = await poll(db, new Date(T));
        assert.deepEqual({ ran: first.ran, complete: first.complete }, { ran: true, complete: false });
        assert.ok(await intakeRow(db, fresh.id), "the lead after the stuck message is not held back");
        assert.equal(await intakeRow(db, stuck.id), null);
        let settings = await settingsOf(db);
        assert.equal(settings?.leadInboxScanWatermarkAt?.getTime(), watermark.getTime(), "the watermark must not move past an unfinished message");
        assert.equal(settings?.leadInboxFailureCount, 1);
        assert.equal(settings?.leadInboxLastPollOk, false);
        assert.equal(settings?.leadInboxNextPollAt, null, "no backoff: new leads keep flowing every minute");

        await poll(db, new Date(T + MINUTE));
        await poll(db, new Date(T + 2 * MINUTE));
        assert.equal(await intakeRow(db, stuck.id), null, "still failing, still open");
        const last = await poll(db, new Date(T + 3 * MINUTE));
        assert.equal(last.complete, true);
        assert.ok(await intakeRow(db, stuck.id), "the 30-minute-old message is recovered once its get works");
        settings = await settingsOf(db);
        assert.equal(settings?.leadInboxScanWatermarkAt?.getTime(), T + 3 * MINUTE);
        assert.equal(settings?.leadInboxFailureCount, 0);
        assert.equal(gets(fresh.id), 2, "the finished message was never fetched again on the retries");
    } finally {
        await db.$disconnect();
    }
});

test("a duplicate is never double-processed: a re-listed message costs no gets, and two copies of one website submission make one intake row", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - 5 * MINUTE) });
        const submissionId = `${RUN}-sub-t6`;
        const copyA = website("t6-a", T - 2 * MINUTE, { metadata: websiteMetadata(submissionId) });
        const copyB = website("t6-b", T - MINUTE, { metadata: websiteMetadata(submissionId) });
        mailbox = [copyA, copyB];

        await poll(db, new Date(T));
        assert.equal(getCalls.length, 4);
        assert.equal(await db.leadIntakeEvent.count({ where: { submissionId } }), 1, "one intake row per submission");

        const again = await poll(db, new Date(T + MINUTE));
        assert.equal(again.complete, true);
        assert.equal(again.processed, 0);
        assert.equal(getCalls.length, 4, "both copies are re-listed by the overlap, and cost nothing");
        assert.equal(await db.leadIntakeEvent.count({ where: { submissionId } }), 1);
    } finally {
        await db.$disconnect();
    }
});

test("a message that arrives during a scan, or shows up in search late, is caught by the next scan through the overlap", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - MINUTE) });
        const early = website("t7-early", T - 30_000);
        // Delivered 10 minutes BEFORE the scan started, but not visible to
        // search until after it: without the overlap, the next window
        // (after:T) would skip it for good.
        const lagged = website("t7-lagged", T - 10 * MINUTE, { hidden: true });
        const during = website("t7-during", T + 1000);
        mailbox = [early, lagged];
        afterListHook = () => {
            if (!mailbox.includes(during)) mailbox.push(during);
        };

        const first = await poll(db, new Date(T));
        assert.equal(first.complete, true);
        assert.ok(await intakeRow(db, early.id));
        assert.equal(await intakeRow(db, during.id), null, "arrived after this scan's list call");
        assert.equal(await intakeRow(db, lagged.id), null, "not yet visible to search");
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), T);

        afterListHook = null;
        lagged.hidden = false;
        const second = await poll(db, new Date(T + MINUTE));
        assert.equal(second.complete, true);
        assert.ok(await intakeRow(db, during.id), "the mid-scan arrival is caught by the next scan");
        assert.ok(await intakeRow(db, lagged.id), "the late-indexed message, older than the watermark, is caught through the overlap");
        assert.ok(lagged.internalDateMs < T, "precondition: it predates the watermark the first scan committed");
    } finally {
        await db.$disconnect();
    }
});

test("pagination over several pages: every page is listed and every message processed before the watermark moves", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - HOUR) });
        pageSize = 3;
        const messages = Array.from({ length: 10 }, (_, i) => website(`t8-${i}`, T - (i + 1) * MINUTE));
        mailbox = [...messages];

        const result = await poll(db, new Date(T));
        assert.equal(result.complete, true);
        assert.equal(result.processed, 10);
        assert.deepEqual(listCalls.map(c => c.pageToken), [undefined, "off-3", "off-6", "off-9"], "4 pages, each fetched once, in order");
        for (const m of messages) assert.ok(await intakeRow(db, m.id), `${m.id} recorded`);
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), T);
    } finally {
        await db.$disconnect();
    }
});

test("11 pages with 60 leading rejected messages and one real lead on the last page: runs progress through the get budget, each message is fetched once, and the watermark moves only on the finishing run", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        const watermark = new Date(T - 2 * HOUR);
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: watermark });
        pageSize = 6;
        const rejected = Array.from({ length: 60 }, (_, i) => forgedWebsite(`t9-rej-${i}`, T - (i + 1) * 1000));
        const lead = website("t9-lead", T - HOUR);
        mailbox = [...rejected, lead];

        const runs: boolean[] = [];
        for (let i = 0; i < 5 && !runs[runs.length - 1]; i++) {
            const result = await poll(db, new Date(T + i * MINUTE));
            runs.push(result.complete === true);
            if (!result.complete) {
                assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), watermark.getTime(), "an unfinished run never moves the watermark");
            }
        }
        assert.ok(runs.length > 1 && runs[runs.length - 1], `must span more than one run and then finish: ${JSON.stringify(runs)}`);
        assert.equal(listCalls.filter(c => !c.pageToken).length, runs.length, "each run re-lists from page 1 (no page-token state)");
        assert.ok(listCalls.some(c => c.pageToken === "off-60"), "page 11 was reached");
        assert.ok(await intakeRow(db, lead.id), "the real lead on page 11, behind 60 rejected messages, is recorded");
        assert.equal(getCalls.length, 62, "60 rejected x 1 get + the lead x 2 gets: nothing is ever fetched twice");
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), T + (runs.length - 1) * MINUTE);
    } finally {
        await db.$disconnect();
    }
});

test("a long outage raises one visible stale-scan alert and keeps the watermark, then the next complete scan recovers everything (the 72-hour-gap case: no reset, no unscanned window)", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        const watermark = new Date(T - 100 * HOUR);
        const cutoff = new Date(T - 30 * 24 * HOUR);
        await seedSettings(db, { cutoffAt: cutoff, watermarkAt: watermark });
        const during = [
            website("t10-a", T - 99 * HOUR),
            voice("t10-b", T - 50 * HOUR, "(360) 555-0110"),
            website("t10-c", T - HOUR),
        ];
        const forged = forgedWebsite("t10-forged", T - 70 * HOUR);
        mailbox = [...during, forged];
        failAllLists = true;

        await poll(db, new Date(T));
        assert.equal(pushes.filter(p => /scan behind/.test(p.title)).length, 1, "one stale-scan alert");
        assert.match(pushes.find(p => /scan behind/.test(p.title))!.body, new RegExp(watermark.toISOString()));
        await poll(db, new Date(T + 5 * MINUTE));
        assert.equal(pushes.filter(p => /scan behind/.test(p.title)).length, 1, "sent once per outage, not every poll");
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), watermark.getTime(), "kept, never reset");

        failAllLists = false;
        const recovered = await poll(db, new Date(T + 30 * MINUTE));
        assert.equal(recovered.complete, true);
        const lastList = listCalls[listCalls.length - 1];
        assert.ok(lastList.q.includes(`after:${Math.floor((watermark.getTime() - 24 * HOUR) / 1000) - 1}`), `the recovery window reaches back past the whole outage: ${lastList.q}`);
        for (const m of during) assert.ok(await intakeRow(db, m.id), `${m.id} recovered`);
        assert.equal((await intakeRow(db, during[1].id))?.verdict, "REVIEW", "Voice intake is REVIEW");
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: forged.id } }))?.outcome, "REJECTED");
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), T + 30 * MINUTE);
        assert.equal(pushes.filter(p => /caught up/.test(p.title)).length, 1, "recovery is announced");
        assert.equal(await db.automationSetting.findUnique({ where: { key: "speedToLeadScanStaleAlertSentAt" } }), null, "the next outage alerts again");
    } finally {
        await db.$disconnect();
    }
});

test("a disconnected inbox still raises the stale-scan alert, and a failed push is retried on the next poll", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - 7 * HOUR) });
        connected = false;
        ntfyUp = false;

        const first = await poll(db, new Date(T));
        assert.equal(first.reason, "lead inbox not connected");
        assert.equal(pushes.length, 0);

        ntfyUp = true;
        await poll(db, new Date(T + MINUTE));
        assert.equal(pushes.filter(p => /scan behind/.test(p.title)).length, 1, "retried once ntfy is back, not marked sent on the failed attempt");
    } finally {
        await db.$disconnect();
    }
});

test("health alerts are never held back, while unaccepted-message notices are batched to one push per 15 minutes with nothing lost", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - MINUTE) });
        const first = forgedWebsite("t11-r1", T - 30_000);
        mailbox = [first];

        await poll(db, new Date(T));
        assert.equal(pushes.filter(p => /not taken in/.test(p.title)).length, 1);

        const second = forgedWebsite("t11-r2", T + MINUTE);
        mailbox.push(second);
        await poll(db, new Date(T + 2 * MINUTE));
        assert.equal(pushes.filter(p => /not taken in/.test(p.title)).length, 1, "held back inside the 15-minute window");
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: second.id } }))?.notifiedAt, null, "still unreported, not dropped");

        // A health alert inside that same window is not held back.
        await db.companySettings.update({ where: { id: "singleton" }, data: { leadInboxScanWatermarkAt: new Date(T - 7 * HOUR) } });
        failAllLists = true;
        await poll(db, new Date(T + 3 * MINUTE));
        assert.equal(pushes.filter(p => /scan behind/.test(p.title)).length, 1, "the stale-scan alert goes out immediately");

        failAllLists = false;
        await poll(db, new Date(T + 20 * MINUTE));
        const notices = pushes.filter(p => /not taken in/.test(p.title));
        assert.equal(notices.length, 2, "the held-back notice goes out once the window has passed");
        assert.ok(notices[1].body.includes(second.id) && !notices[1].body.includes(first.id), "it covers exactly what was not yet reported");
        assert.ok((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: second.id } }))?.notifiedAt);
    } finally {
        await db.$disconnect();
    }
});
