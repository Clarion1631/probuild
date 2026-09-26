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
const DB_CLOCK_SPECIFIER = "./db-clock";
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
/** When set and `connected` is false, ensureLeadInboxAuth's mock reports this as the failure's error (a credential that WAS stored but can't be used) instead of the bare `{ok:false}` "never connected yet" shape. */
let authError: unknown = null;
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
/**
 * The fake "database clock" `dbNow` returns: the CURRENT poll's own `now`,
 * by default, so every existing timing assertion in this file (all written
 * against the app clock) keeps meaning what it always meant — `now` and the
 * database's clock trivially agree unless a test says otherwise. Set by
 * `poll()` before every call. This is the real database's clock in
 * production (src/lib/speed-to-lead/db-clock.ts) — only the TEST double
 * ties it to the logical `now` this file already controls.
 */
let fakeDbNow = new Date();

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
                ensureLeadInboxAuth: async () => (connected ? { ok: true, client: {} } : authError ? { ok: false, error: authError } : { ok: false }),
                gmailClientFor: () => fakeGmailClient(),
            };
        }
        if (id === DB_CLOCK_SPECIFIER) {
            return { dbNow: async () => fakeDbNow };
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
    authError = null;
    failListPages = new Set();
    failAllLists = false;
    afterListHook = null;
    listCalls = [];
    getCalls = [];
    pushes = [];
    ntfyUp = true;
    fakeDbNow = new Date();
});

function freshDb() {
    return new PrismaClient({ datasources: { db: { url: `${databaseUrl}?pgbouncer=true` } } });
}

const RECONCILE_LAST_RECONCILED_KEY = "speedToLeadReconcileLastCompletedAt";
const RECONCILE_PROGRESS_KEY = "speedToLeadReconcileProgress";

const MARKER_KEYS = [
    "speedToLeadPollLease",
    "speedToLeadPollAlertSentAt",
    "speedToLeadInboxDisconnectedAlertSent",
    "speedToLeadDisconnectNoticePending",
    "speedToLeadScanStaleAlertSentAt",
    "speedToLeadUnacceptedNoticeSentAt",
    RECONCILE_LAST_RECONCILED_KEY,
    RECONCILE_PROGRESS_KEY,
];

async function resetState(db: PrismaClient) {
    await db.companySettings.deleteMany({ where: { id: "singleton" } });
    await db.leadInboxMessage.deleteMany({});
    await db.automationSetting.deleteMany({ where: { key: { in: MARKER_KEYS } } });
}

/**
 * `cutoffAt`/`watermarkAt` as before, PLUS a just-now `RECONCILE_LAST_RECONCILED_KEY`
 * marker, so a test that seeds settings and does not care about the daily
 * reconciliation sweep never has one sprung on it (see the sweep-specific
 * tests below, which explicitly clear this marker to force a sweep).
 */
async function seedSettings(db: PrismaClient, data: { cutoffAt: Date; watermarkAt: Date }) {
    await db.companySettings.create({ data: { id: "singleton", leadInboxCutoffAt: data.cutoffAt, leadInboxScanWatermarkAt: data.watermarkAt } });
    await db.automationSetting.upsert({
        where: { key: RECONCILE_LAST_RECONCILED_KEY },
        create: { key: RECONCILE_LAST_RECONCILED_KEY, value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
    });
}

async function poll(db: PrismaClient, now: Date) {
    listCallsThisPoll = 0;
    fakeDbNow = now;
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

/**
 * Wraps a real PrismaClient so every `$transaction` it opens runs with
 * `tx[modelName][methodName]` replaced by a function that throws — the same
 * Proxy-around-a-real-transaction technique tests/attribution-lock-order-db
 * .test.ts uses to inject a failure at one exact point inside an otherwise
 * real, committed-or-rolled-back transaction. Every other property (every
 * other model, every other method, `$disconnect`, ...) passes straight
 * through to the real client untouched.
 */
function dbFailingTransactionOn(realDb: PrismaClient, modelName: string, methodName: string): PrismaClient {
    return new Proxy(realDb, {
        get(target, prop) {
            if (prop !== "$transaction") return (target as unknown as Record<string | symbol, unknown>)[prop];
            const typedTarget = target as unknown as { $transaction: (fn: (tx: unknown) => unknown) => unknown };
            // Called AS a method on `typedTarget` (not torn off into a bare
            // reference) — Prisma's real $transaction needs its own client
            // as `this`; calling it detached throws a TypeError before it
            // ever opens a transaction, which looked like "the injected
            // failure" but was really just a broken test double.
            return (fn: (tx: unknown) => unknown) => typedTarget.$transaction((tx: unknown) => {
                const proxiedTx = new Proxy(tx as Record<string, unknown>, {
                    get(txTarget, txProp) {
                        if (txProp !== modelName) return txTarget[txProp as string];
                        const model = txTarget[txProp as string] as Record<string, unknown>;
                        return new Proxy(model, {
                            get(modelTarget, modelProp) {
                                if (modelProp !== methodName) return modelTarget[modelProp as string];
                                return async () => { throw new Error("injected boundary failure"); };
                            },
                        });
                    },
                });
                return fn(proxiedTx);
            });
        },
    }) as unknown as PrismaClient;
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
        // round-7 finding 1: a message's own `get` error no longer blocks
        // the scan's completion — it already has a durable PENDING ledger
        // row from the moment it was listed, so the watermark is safe to
        // advance past it (`resolvePendingMessages` retries it independent
        // of this window, every poll, until it resolves or 404s).
        assert.deepEqual({ ran: first.ran, complete: first.complete }, { ran: true, complete: true });
        assert.ok(await intakeRow(db, fresh.id), "the lead after the stuck message is not held back");
        assert.equal(await intakeRow(db, stuck.id), null);
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: stuck.id } }))?.outcome, "PENDING", "durably tracked, not lost, even though it errored");
        let settings = await settingsOf(db);
        assert.equal(settings?.leadInboxScanWatermarkAt?.getTime(), T, "safe to advance because the unfinished message is durably PENDING, not because it finished");
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
        const { SCAN_OVERLAP_MS } = await import("../src/lib/speed-to-lead/gmail-poll");
        assert.ok(lastList.q.includes(`after:${Math.floor((watermark.getTime() - SCAN_OVERLAP_MS) / 1000) - 1}`), `the recovery window reaches back past the whole outage: ${lastList.q}`);
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

test("round-6 finding 1: a broken (invalid_grant) credential alerts immediately even with no watermark yet, so a bad reconnect is never silent", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        // No seedSettings: this is a fresh singleton with no watermark at
        // all — alertIfScanStale has nothing to check, so before this fix
        // the disconnected alert never fired here (see gmail-poll.ts's
        // runPoll, and the finding's own repro of "zero intake, zero
        // pushes, failure count zero").
        const T = Date.now();
        connected = false;
        authError = Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });

        const result = await poll(db, new Date(T));
        assert.equal(result.reason, "lead inbox not connected");
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 1, "the disconnected alert fires on the very first failed poll, with no watermark to age");
        assert.equal((await settingsOf(db))?.leadInboxRefreshTokenEnc, null, "the stale credential is cleared so the settings page shows disconnected");
    } finally {
        await db.$disconnect();
    }
});

test("round-6 finding 1: a broken (non-invalid_grant) credential still trips the repeated-failure alert with no watermark yet", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        connected = false;
        authError = new Error("token refresh timed out");

        // Spaced past each step's backoff (1, 2, 4, 8 minutes) so every poll
        // actually attempts auth again instead of returning early.
        await poll(db, new Date(T));
        await poll(db, new Date(T + 1 * MINUTE));
        await poll(db, new Date(T + 3 * MINUTE));
        await poll(db, new Date(T + 7 * MINUTE));
        assert.equal(pushes.filter(p => /poll failing/.test(p.title)).length, 0, "not yet — only 4 failures");
        await poll(db, new Date(T + 15 * MINUTE));

        assert.equal(pushes.filter(p => /poll failing/.test(p.title)).length, 1, "the 5th consecutive auth failure alerts, exactly like a scan failure would");
        const settings = await settingsOf(db);
        assert.equal(settings?.leadInboxFailureCount, 5);
        assert.equal(settings?.leadInboxScanWatermarkAt, null, "still no watermark — this alert could only have come from the failure count, not alertIfScanStale");
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

test("round-7 finding 1: a listed message whose get fails and is then permanently deleted is durably tracked as PENDING and resolved to GONE, never silent", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - MINUTE) });
        const doomed = website("t12-doomed", T - 30_000, { failGets: 1 });
        mailbox = [doomed];

        const first = await poll(db, new Date(T));
        assert.equal(first.complete, true, "a message's own get error no longer blocks the scan: it is durably PENDING instead");
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: doomed.id } }))?.outcome, "PENDING", "ledgered before the failing get, so it can never vanish with no trace");
        assert.equal(await intakeRow(db, doomed.id), null);
        assert.equal((await settingsOf(db))?.leadInboxScanWatermarkAt?.getTime(), T, "safe to advance past it because it is durably tracked");
        assert.equal(pushes.length, 0, "still being retried — not yet reported as unaccepted");

        // Deleted from Gmail entirely before the next poll: search will
        // never list it again, so only a direct get-by-id can resolve it.
        mailbox = [];

        const second = await poll(db, new Date(T + MINUTE));
        assert.equal(second.complete, true);
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: doomed.id } }))?.outcome, "GONE", "resolved by the independent retry-by-id, not by search (which lists nothing at all now)");
        const notice = pushes.find(p => /not taken in as leads/.test(p.title));
        assert.ok(notice, "never silent: the batched push covers it as soon as it resolves");
        assert.ok(notice!.body.includes(doomed.id) && notice!.body.includes("deleted before it could be read"));
    } finally {
        await db.$disconnect();
    }
});

test("round-7 finding 2: a disconnect notice whose first push fails is retried every poll until delivered, exactly once, even though later auth returns no error", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - MINUTE) });
        connected = false;
        authError = Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });
        ntfyUp = false;

        const first = await poll(db, new Date(T));
        assert.equal(first.reason, "lead inbox not connected");
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 0, "the push failed, nothing delivered yet");
        assert.equal((await settingsOf(db))?.leadInboxRefreshTokenEnc, null, "the credential is cleared immediately regardless of the push outcome");
        assert.ok(await db.automationSetting.findUnique({ where: { key: "speedToLeadDisconnectNoticePending" } }), "a durable pending flag persists across the failed push");

        // The credential is now cleared, so ensureLeadInboxAuth's mock
        // returns the bare {ok:false} "never connected yet" shape (no
        // `error`) on every later poll — exactly the round-7 finding 2 gap
        // that used to make the notice un-retriable from here on.
        authError = null;
        ntfyUp = false;
        const second = await poll(db, new Date(T + MINUTE));
        assert.equal(second.reason, "lead inbox not connected");
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 0, "still not delivered, still retried rather than abandoned");

        ntfyUp = true;
        await poll(db, new Date(T + 2 * MINUTE));
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 1, "delivered on the first poll after ntfy recovers");
        assert.equal(await db.automationSetting.findUnique({ where: { key: "speedToLeadDisconnectNoticePending" } }), null, "the pending flag is cleared once delivered");

        await poll(db, new Date(T + 3 * MINUTE));
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 1, "delivered exactly once, not re-sent on later polls");
    } finally {
        await db.$disconnect();
    }
});

test("round-8 finding A: a sustained new-mail flood never starves the pending retry, and a PENDING row that crosses the stuck-attempts threshold surfaces in the batched notice", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 7 * 24 * HOUR), watermarkAt: new Date(T - MINUTE) });

        // An old PENDING row from an earlier ordinary `get` error (round-7
        // finding 1's shape) — present in the fake mailbox so a direct
        // get-by-id can reach it, but it keeps 500ing.
        const starved = website("t14-starved", T - 10 * MINUTE, { failGets: 10 });
        mailbox = [starved];
        await db.leadInboxMessage.create({ data: { gmailMessageId: starved.id, outcome: "PENDING" } });

        // Every poll, 50 more lead-sender messages arrive — comfortably over
        // MAX_MESSAGE_GETS (50): if resolvePendingMessages still ran AFTER
        // scanWindow with no reserved share (the pre-fix order), a flood
        // this size would spend the WHOLE budget on new mail every single
        // poll and `starved` would never get a look-in, poll after poll.
        // Polls are spaced 20 minutes apart (well past
        // UNACCEPTED_NOTICE_MIN_INTERVAL_MS's 15-minute batching window) so
        // each poll's own flood of newly-REJECTED messages gets its own
        // fresh notice instead of being held back by the previous one —
        // otherwise the one push that DOES fire (reporting poll 0's flood)
        // would be the only one, sent long before `starved` ever crosses
        // the stuck threshold.
        const STEP = 20 * MINUTE;
        for (let i = 0; i < 4; i++) {
            const flood = Array.from({ length: 50 }, (_, j) => forgedWebsite(`t14-flood-${i}-${j}`, T + i * STEP - j * 1000));
            mailbox.push(...flood);

            await poll(db, new Date(T + i * STEP));

            const row = await db.leadInboxMessage.findUnique({ where: { gmailMessageId: starved.id } });
            assert.equal(row?.outcome, "PENDING", `poll ${i}: still open, never lost`);
            assert.equal(row?.failedAttempts, i + 1, `poll ${i}: retried despite the flood, not starved out`);
            assert.ok(row?.lastAttemptAt && row.lastAttemptAt.getTime() >= T + i * STEP, `poll ${i}: lastAttemptAt advanced`);
        }

        // 4 failed attempts > PENDING_STUCK_ATTEMPTS (3): no longer "merely
        // still retrying" — reported to Justin so it can never sit invisible
        // and indefinite. Each poll's own flood earns its own notice (see
        // above), so `starved` only ever shows up in the LAST one — the
        // first three only cover that poll's freshly-rejected flood.
        const notice = pushes.findLast(p => /not taken in as leads/.test(p.title));
        assert.ok(notice, "the long-stuck row surfaces in the batched notice");
        assert.ok(notice!.body.includes(starved.id), "names the stuck message");
        assert.ok(notice!.body.includes("stuck retrying, not yet resolved"), "labelled as stuck, not as a plain rejection");
    } finally {
        await db.$disconnect();
    }
});

test("round-8 finding B: clearing the credential and persisting the disconnect-notice pending flag are one transaction — a boundary failure leaves neither, and the next poll still produces the notice", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        // A placeholder credential value, so clearing it is observable —
        // otherwise the field starts and stays null regardless of whether
        // the clear itself committed or rolled back.
        await db.companySettings.create({ data: { id: "singleton", leadInboxRefreshTokenEnc: "test-refresh-token" } });
        connected = false;
        authError = Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });
        // Kept down for this whole test: retryDisconnectNotice runs in the
        // SAME poll's finally block and would otherwise clear the pending
        // flag itself (that atomic clear is item C, tested separately),
        // which would make it look like item B's own write never committed.
        ntfyUp = false;

        const failingDb = dbFailingTransactionOn(db, "automationSetting", "upsert");
        const first = await poll(failingDb, new Date(T));
        // The injected failure throws out of recordFailure's invalid_grant
        // branch, so runPoll's own outer catch is what actually returns —
        // "error", not the ordinary "lead inbox not connected" — and its
        // own (unrelated, non-transactional) recordFailure call is what
        // schedules the 1-minute backoff below.
        assert.equal(first.reason, "error");
        assert.equal(
            (await db.companySettings.findUnique({ where: { id: "singleton" } }))?.leadInboxRefreshTokenEnc,
            "test-refresh-token",
            "the credential clear rolled back with everything else in the failed transaction",
        );
        assert.equal(await db.automationSetting.findUnique({ where: { key: "speedToLeadDisconnectNoticePending" } }), null, "the pending flag never landed either — atomic, not half-applied");

        // No more injected failure: the next failed poll's transaction
        // commits both writes together. (Past the 1-minute backoff the
        // first poll's generic-failure path scheduled.)
        const second = await poll(db, new Date(T + 2 * MINUTE));
        assert.equal(second.reason, "lead inbox not connected");
        assert.equal(
            (await db.companySettings.findUnique({ where: { id: "singleton" } }))?.leadInboxRefreshTokenEnc,
            null,
            "this time the credential clear committed",
        );
        assert.ok(await db.automationSetting.findUnique({ where: { key: "speedToLeadDisconnectNoticePending" } }), "and the pending flag committed with it, in the same transaction — retryDisconnectNotice (ntfy still down) never got the chance to clear it itself");
    } finally {
        await db.$disconnect();
    }
});

test("round-8 finding C: recording the disconnect notice's delivery and clearing its pending flag are one transaction — a boundary failure leaves neither, so a later reconnect can never re-trigger the notice", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        connected = false;
        authError = Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });
        ntfyUp = true;

        // The credential-clear + pending-flag write (item B, above) succeeds
        // normally here; only the LATER clear-the-pending-flag write, inside
        // retryDisconnectNotice's own transaction, is made to fail.
        const failingDb = dbFailingTransactionOn(db, "automationSetting", "delete");
        const first = await poll(failingDb, new Date(T));
        assert.equal(first.reason, "lead inbox not connected");
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 1, "the push itself still went out — sendPlainNtfy runs before the atomic write");
        assert.equal(
            await db.automationSetting.findUnique({ where: { key: "speedToLeadInboxDisconnectedAlertSent" } }),
            null,
            "the delivery marker did NOT commit: the pending-flag clear failed inside the SAME transaction",
        );
        assert.ok(
            await db.automationSetting.findUnique({ where: { key: "speedToLeadDisconnectNoticePending" } }),
            "...so the pending flag is still set too — atomic, it's never true that one landed without the other",
        );

        // No more injected failure: genuinely not yet delivered, so this is
        // a real retry, not a phantom resend — and this time both halves
        // commit together.
        const second = await poll(db, new Date(T + MINUTE));
        assert.equal(second.reason, "lead inbox not connected");
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 2);
        assert.ok(await db.automationSetting.findUnique({ where: { key: "speedToLeadInboxDisconnectedAlertSent" } }), "delivered, and this time recorded");
        assert.equal(await db.automationSetting.findUnique({ where: { key: "speedToLeadDisconnectNoticePending" } }), null, "cleared in the SAME commit as the marker above");

        // Reconnect: a clean, successful poll. recordSuccessAndClearBackoff
        // clears the delivered marker as part of ordinary recovery
        // bookkeeping — the exact event that used to re-trigger the push
        // when the pending flag had been left set by an earlier failed
        // clear (round-8 finding C). It is gone now, so there is nothing
        // left for retryDisconnectNotice to (re)send.
        connected = true;
        const third = await poll(db, new Date(T + 2 * MINUTE));
        assert.equal(third.ran, true);
        assert.equal(await db.automationSetting.findUnique({ where: { key: "speedToLeadInboxDisconnectedAlertSent" } }), null, "recordSuccessAndClearBackoff clears it on reconnect, same as before this fix");
        assert.equal(pushes.filter(p => /disconnected/.test(p.title)).length, 2, "no third push: the pending flag was already gone, so there was nothing left to re-send");
    } finally {
        await db.$disconnect();
    }
});

test("round-9: a corrupted future watermark (Codex's T+96h clock-jump scenario) leaves a message the incremental scan can never reach, and the daily reconciliation sweep recovers it within a day and pushes a health alert", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        const cutoff = new Date(T - 30 * 24 * HOUR);
        // Stands in for the pre-fix bug's aftermath: a scan that completed
        // while the app clock briefly read T+96h committed the watermark
        // there. The fix (dbNow-sourced scan-start timestamps, in
        // gmail-poll.ts's runPoll) stops this from happening again — this
        // test is about the second layer, the sweep, recovering from it if
        // it ever happens anyway, from any cause.
        const corruptedWatermark = new Date(T + 96 * HOUR);
        await seedSettings(db, { cutoffAt: cutoff, watermarkAt: corruptedWatermark });
        // Force the sweep due, as if it had never run before this corruption.
        await db.automationSetting.deleteMany({ where: { key: RECONCILE_LAST_RECONCILED_KEY } });

        // The clock has since corrected: this and the next poll run at real
        // time again — Codex's "clock correction" step. The incremental
        // scan's own window (watermark - SCAN_OVERLAP_MS) starts far ahead
        // of real time, so it alone could never see this message.
        const missed = website("t-skew-missed", T + MINUTE);
        mailbox = [missed];

        const first = await poll(db, new Date(T + MINUTE));
        assert.equal(first.ran, true);
        assert.equal(await intakeRow(db, missed.id), null, "not resolved yet — the sweep only ledgers, it never calls get itself");
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: missed.id } }))?.outcome, "PENDING", "the sweep gave it a ledger row the incremental scan's own window never would have");
        const recovery = pushes.find(p => /reconciliation/i.test(p.title));
        assert.ok(recovery, "one health push announces the recovery as soon as the sweep's own pass finishes");
        assert.match(recovery.body, /watermark was wrong/);
        assert.match(recovery.body, /found 1 lead-sender message/);
        assert.equal(await db.automationSetting.findUnique({ where: { key: RECONCILE_PROGRESS_KEY } }), null, "the sweep finished and cleared its own resume state");
        assert.ok(await db.automationSetting.findUnique({ where: { key: RECONCILE_LAST_RECONCILED_KEY } }), "and stamped the daily marker");

        // The pre-existing PENDING retry (round-7 finding 1) — independent of
        // any window — is what actually resolves it, well within the "within
        // a day" bound this fix is required to meet.
        const second = await poll(db, new Date(T + 2 * MINUTE));
        assert.equal(second.ran, true);
        assert.ok(await intakeRow(db, missed.id), "the recovered lead is now a real intake row");
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: missed.id } }))?.outcome, "INTAKE");
        assert.equal(pushes.filter(p => /reconciliation/i.test(p.title)).length, 1, "the recovery push fires exactly once, not again on a later poll");
    } finally {
        await db.$disconnect();
    }
});

test("round-9: a reconciliation sweep never re-lists into a reset — messages the ledger already has a row for cost no gets and are not recounted as recovered", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 30 * 24 * HOUR), watermarkAt: new Date(T - MINUTE) });
        await db.automationSetting.deleteMany({ where: { key: RECONCILE_LAST_RECONCILED_KEY } });

        const already = website("t-sweep-known", T - 3 * HOUR);
        mailbox = [already];
        await db.leadInboxMessage.create({ data: { gmailMessageId: already.id, outcome: "INTAKE" } });

        const result = await poll(db, new Date(T));
        assert.equal(result.ran, true);
        assert.equal(gets(already.id), 0, "already-ledgered messages cost no gets — not from the sweep (which never gets at all) and not from the incremental scan (which skips anything already resolved)");
        assert.equal(pushes.filter(p => /reconciliation/i.test(p.title)).length, 0, "nothing new to recover, so no health push");
        assert.ok(await db.automationSetting.findUnique({ where: { key: RECONCILE_LAST_RECONCILED_KEY } }), "the sweep still completes and stamps the marker even with nothing to recover");
        assert.equal(await db.automationSetting.findUnique({ where: { key: RECONCILE_PROGRESS_KEY } }), null);
        assert.equal((await db.leadInboxMessage.findUnique({ where: { gmailMessageId: already.id } }))?.outcome, "INTAKE", "its outcome is untouched, never reset back to PENDING");
    } finally {
        await db.$disconnect();
    }
});

test("round-9: a reconciliation sweep interrupted by its own list-page budget resumes on the next poll from exactly where it left off, and reports the full recovered count only once it finishes", { skip }, async () => {
    const db = freshDb();
    try {
        await resetState(db);
        const T = Date.now();
        await seedSettings(db, { cutoffAt: new Date(T - 30 * 24 * HOUR), watermarkAt: new Date(T - MINUTE) });
        await db.automationSetting.deleteMany({ where: { key: RECONCILE_LAST_RECONCILED_KEY } });

        pageSize = 1;
        // Well outside the incremental scan's own window (afterMs ~= T-72h)
        // but inside the sweep's 14-day floor, so only the sweep ever lists
        // these — keeps this test about the sweep's own resumability.
        const old = Array.from({ length: 22 }, (_, i) => website(`t-sweep-resume-${i}`, T - 10 * 24 * HOUR - i * 1000));
        mailbox = [...old];

        const first = await poll(db, new Date(T));
        assert.equal(first.ran, true);
        assert.equal(gets(old[0].id), 0, "the sweep itself never calls get — it only ledgers ids");
        const afterFirst = await db.leadInboxMessage.count({ where: { gmailMessageId: { in: old.map(m => m.id) } } });
        assert.equal(afterFirst, 20, "capped at the sweep's own list-page budget (MAX_LIST_PAGES x pageSize 1), not all 22 yet");
        assert.equal(pushes.filter(p => /reconciliation/i.test(p.title)).length, 0, "the pass has not finished, so no push yet");
        const progressRow = await db.automationSetting.findUnique({ where: { key: RECONCILE_PROGRESS_KEY } });
        assert.ok(progressRow, "durable resume state persists across polls");
        const savedProgress = JSON.parse(progressRow!.value) as { windowFromMs: number };
        const sweepEpoch = Math.floor(savedProgress.windowFromMs / 1000) - 1;
        assert.equal(listCalls.filter(c => c.q.includes(`after:${sweepEpoch}`)).length, 20, "20 pages fetched before the cap");

        const second = await poll(db, new Date(T + MINUTE));
        assert.equal(second.ran, true);
        const afterSecond = await db.leadInboxMessage.count({ where: { gmailMessageId: { in: old.map(m => m.id) } } });
        assert.equal(afterSecond, 22, "the remaining ids are picked up on resume, not skipped");
        assert.equal(listCalls.filter(c => c.q.includes(`after:${sweepEpoch}`)).length, 22, "22 pages total across both polls — resuming never re-lists a page already covered by the first poll");
        const recovery = pushes.find(p => /reconciliation/i.test(p.title));
        assert.ok(recovery, "the push fires once the sweep actually finishes");
        assert.match(recovery.body, /found 22 lead-sender message/);
        assert.equal(await db.automationSetting.findUnique({ where: { key: RECONCILE_PROGRESS_KEY } }), null, "progress cleared once complete");
    } finally {
        await db.$disconnect();
    }
});
