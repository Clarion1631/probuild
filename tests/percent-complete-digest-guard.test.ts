/**
 * Both Monday senders must decide "is there anywhere to send this?" BEFORE they
 * touch the database.
 *
 * loadMarginDigestJobs runs computeProjectFinancials for every active job —
 * roughly eight queries each. Doing all of that to build a message that is then
 * discarded because nobody has configured the webhook is pure waste on a weekly
 * cron, and it makes an unconfigured digest look like real database load in the
 * logs. Both env vars are still unset in production, so this is the path that
 * actually runs today, not a hypothetical.
 *
 * The fake prisma below THROWS on every accessor, so any query at all fails the
 * test loudly rather than being silently tolerated.
 */

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

let dbTouched: string[] = [];

const explodingModel = (name: string) =>
    new Proxy({}, {
        get: (_t, method) => async () => {
            dbTouched.push(`${name}.${String(method)}`);
            throw new Error(`database touched before the destination was checked: ${name}.${String(method)}`);
        },
    });

const fakePrisma = new Proxy({} as Record<string, unknown>, {
    get: (_t, model) => explodingModel(String(model)),
});

let sendMondayMarginCard: () => Promise<any>;
let sendDraggingUsLine: () => Promise<any>;

const ORIGINAL_ENV = { ...process.env };

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/lib/margin-digest");
    } finally {
        Module.prototype.require = originalRequire;
    }
    sendMondayMarginCard = mod.sendMondayMarginCard;
    sendDraggingUsLine = mod.sendDraggingUsLine;
});

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    dbTouched = [];
});

// ── the margin card ─────────────────────────────────────────────────────────

test("margin card: an unset webhook skips WITHOUT querying anything", async () => {
    delete process.env.MAIN_OFFICE_CHAT_WEBHOOK;
    const result = await sendMondayMarginCard();

    assert.equal(result.sent, false);
    assert.equal(result.reason, "no webhook configured");
    assert.equal(result.jobCount, 0);
    assert.deepEqual(dbTouched, [], "no query may run before the destination is known");
});

test("margin card: a blank webhook skips without querying", async () => {
    process.env.MAIN_OFFICE_CHAT_WEBHOOK = "   ";
    const result = await sendMondayMarginCard();

    assert.equal(result.sent, false);
    assert.deepEqual(dbTouched, []);
});

test("margin card: a non-Google-Chat webhook is refused before any query (SSRF guard)", async () => {
    process.env.MAIN_OFFICE_CHAT_WEBHOOK = "https://evil.example.com/v1/spaces/x";
    const result = await sendMondayMarginCard();

    assert.equal(result.sent, false);
    assert.match(result.reason, /google chat/i);
    assert.deepEqual(dbTouched, [], "an invalid URL must not cost a full financial sweep either");
});

// ── the dragging-us email ───────────────────────────────────────────────────

test("dragging-us: an unset recipient skips WITHOUT querying anything", async () => {
    delete process.env.PIPELINE_DIGEST_TO;
    const result = await sendDraggingUsLine();

    assert.equal(result.sent, false);
    assert.equal(result.reason, "PIPELINE_DIGEST_TO not set");
    assert.deepEqual(dbTouched, []);
});

test("dragging-us: a blank recipient skips without querying", async () => {
    process.env.PIPELINE_DIGEST_TO = "   ";
    const result = await sendDraggingUsLine();

    assert.equal(result.sent, false);
    assert.equal(result.reason, "PIPELINE_DIGEST_TO not set");
    assert.deepEqual(dbTouched, []);
});

test("dragging-us: the skip still reports its counters so the cron log is complete", async () => {
    delete process.env.PIPELINE_DIGEST_TO;
    const result = await sendDraggingUsLine();

    assert.equal(result.ranked, 0);
    assert.equal(result.unmeasured, 0);
    assert.equal(result.awaitingContract, 0);
});
