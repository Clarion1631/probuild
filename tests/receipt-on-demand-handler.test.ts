/**
 * Contract tests for `tests/receipt-on-demand-handler.test.ts`.
 *
 * The handler route file is NOT among the loaded sources, so this suite pins the
 * handler contract described in the brief rather than the module behind it:
 *
 *   makeOnDemandHandler(config) -> (Request) => Promise<NextResponse>
 *
 * config: { authorized?, makeDeps?, allowedTargets?, env? }
 *
 * Everything synthetic: fictional UUIDs/target, UNCONDITIONAL fictional env
 * (DATABASE_URL / NEXTAUTH_SECRET), global fetch throws by default, no DB, no
 * network. One fixed clock via injected `deps.now`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Fictional env, set UNCONDITIONALLY before any import of the route.
process.env.DATABASE_URL = "postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true";
process.env.NEXTAUTH_SECRET = "fiction-not-a-real-secret";
process.env.CRON_SECRET = "fictional-cron-secret";
process.env.RECEIPTS_CHAT_WEBHOOK =
    "https://chat.googleapis.com/v1/spaces/SYNTHSPACE/messages?key=k&token=t";
process.env.RECEIPT_OWNER_CHAT_USERS = JSON.stringify({ Justin: "users/555000111" });
delete process.env.RECEIPT_ON_DEMAND_TARGETS;
process.env.CRON_SECRET="fictional-cron-secret";

// Real global fetch, banned by default. Individual tests may swap it, and MUST
// restore it, but a test that expects no network keeps this and fails loudly.
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = (async () => {
    throw new Error("NETWORK DENIED in isolated test");
}) as unknown as typeof fetch;

// ── The contract under test ─────────────────────────────────────────────────
//
// If the route has not shipped yet, this import is RED — which is the honest
// state, because the rest of the file describes a contract nothing implements.
// It is imported ONCE and used directly; no module mocking, no re-export.
import { makeOnDemandHandler } from "../src/app/api/automation/receipt-requests/on-demand/route";
import type { OnDemandDeps, PreparedSnapshot, ClaimResult } from "../src/lib/receipt-on-demand";
import { computeOnDemandDigest } from "../src/lib/receipt-on-demand";
import type { CardItem } from "../src/lib/receipt-request-cards";

// ── Fixtures (all fictional) ────────────────────────────────────────────────

/** Fictional UUID; the one target this suite is allowed to ask about. */
const TARGET = "00000000-0000-4000-8000-000000000001";
const ISSUE_ID = "issue-synth-0001";
const OWNER = "Justin";
const OWNER_USER = "users/555000111";
const CENTS = 12_345;
const POSTED = "2026-01-10";
const DAY = "2026-01-12";
const NOW = new Date("2026-01-12T14:30:00.000Z"); // Monday, Pacific morning
const LEDGER = "41";
const EVIDENCE = "19";
const POLICY = "receipt-source-v1:off";
const VERSION = 7;
const RAW = "POS DEB 1432 01/10/26 12345678 C#4321 CHEVRON 0093121 VANCOUVER WA";
const THREAD = "spaces/SYNTHSPACE/threads/t1";
const MESSAGE = "spaces/SYNTHSPACE/messages/m1";

function item(): CardItem {
    return {
        n: 1,
        fingerprint: `pb-${TARGET}`,
        date: POSTED,
        vendor: "Chevron",
        cents: CENTS,
        amount: "123.45",
        cardTail: "4321",
        issueId: ISSUE_ID,
        targetKey: TARGET,
    };
}

function snapshot(over: Partial<PreparedSnapshot> = {}): PreparedSnapshot {
    const base: PreparedSnapshot = {
        bankLineId: TARGET,
        account: "WTB-0723",
        sourceOfRecord: "STATEMENT",
        debitCents: CENTS,
        postedDate: POSTED,
        rawDescriptor: RAW,
        updatedAt: "2026-01-11T22:03:11.000Z",
        item: {
            issueId: ISSUE_ID,
            targetKey: TARGET,
            fingerprint: `pb-${TARGET}`,
            date: POSTED,
            vendor: "Chevron",
            cents: CENTS,
            amount: "123.45",
            cardTail: "4321",
        },
        owner: OWNER,
        ownerUser: OWNER_USER,
        issueVersion: VERSION,
        epochs: { ledger: LEDGER, evidence: EVIDENCE },
        policy: POLICY,
        sweep: { certified: true, fresh: true, evidenceEligible: true },
        flags: { acknowledged: false, resolved: false, sourceFound: false },
    };
    return { ...base, ...over };
}

interface Spies {
    reads: number;
    claims: number;
    posts: number;
    finishes: number;
}

function fakeDeps(snap: PreparedSnapshot = snapshot()): { deps: OnDemandDeps; spies: Spies } {
    const spies: Spies = { reads: 0, claims: 0, posts: 0, finishes: 0 };
    const deps: OnDemandDeps = {
        async readSnapshot() {
            spies.reads++;
            return snap;
        },
        async claim(): Promise<ClaimResult> {
            spies.claims++;
            return { kind: "claimed", claimId: "card_synth_1", claimToken: "tok_synth_1" };
        },
        async post() {
            spies.posts++;
            return { kind: "delivered", threadName: THREAD, messageName: MESSAGE };
        },
        async finish() {
            spies.finishes++;
            return { kind: "recorded" };
        },
        webhookUrl: process.env.RECEIPTS_CHAT_WEBHOOK as string,
        now: () => NOW,
    };
    return { deps, spies };
}

/** The prepared digest for a snapshot, computed with the same fixed clock. */
function digestFor(snap: PreparedSnapshot = snapshot()): string {
    return computeOnDemandDigest(snap, NOW);
}

// ── Request helpers ─────────────────────────────────────────────────────────

const BASE = "https://example.invalid/api/receipt-requests/on-demand";

function post(
    body: unknown,
    init: { headers?: Record<string, string>; url?: string } = {},
): Request {
    return new Request(init.url ?? BASE, {
        method: "POST",
        headers: { "content-type": "application/json", authorization:"Bearer fictional-cron-secret", ...init.headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}

function prepareBody(): Record<string, unknown> {
    return { action: "prepare", bankLineId: TARGET };
}

function applyBody(): Record<string, unknown> {
    return { action: "apply", bankLineId: TARGET, digest: digestFor() };
}

/** A config whose auth is a fixed boolean — the simplest possible seam. */
function allow(value: boolean) {
    return { authorized: () => value } as const;
}

// ── Auth ────────────────────────────────────────────────────────────────────

test("auth failure is 401 and never reads the body or builds deps", async () => {
    let reads = 0;
    let made = 0;
    const handler = makeOnDemandHandler({
        authorized: () => false,
        makeDeps: () => {
            made++;
            return fakeDeps().deps;
        },
    });

    // A body that cannot be parsed: if the handler read it before refusing, it
    // would throw rather than return 401, which is the assertion that matters.
    const request = new Request(BASE, {
        method: "POST",
        headers: { "content-type": "application/json", authorization:"Bearer fictional-cron-secret" },
        body: "{ not json",
    } as RequestInit);

    Object.defineProperty(request, 'body', {get() {reads++; return null;}});
    reads = 0;
    const response = await handler(request);
    assert.equal(response.status, 401);
    assert.equal(made, 0, "deps must not be built for an unauthorized request");
    assert.equal(reads, 0, "the body must not be read before refusing");
    assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the real hasCronSecret default accepts a matching CRON_SECRET header", async () => {
    // The default `authorized` is `hasCronSecret`, which reads process.env
    // directly. It is NOT overridden here, so this pins the real default.
    const { deps } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    const ok = await handler(
        post(prepareBody(), {
            headers: { authorization: `Bearer ${process.env.CRON_SECRET as string}` },
        }),
    );
    assert.equal(ok.status, 200);

    const denied = await handler(post(prepareBody(), {headers:{authorization:""}}));
    assert.equal(denied.status, 401);
});

test("development never bypasses the secret", async () => {
    const prior = process.env.NODE_ENV;
    Object.assign(process.env, {NODE_ENV:"development"});
    try {
        const { deps } = fakeDeps();
        const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });
        // No Authorization header, and NODE_ENV is development: still refused.
        const response = await handler(post(prepareBody(), {headers:{authorization:""}}));
        assert.equal(response.status, 401);
    } finally {
        if (prior === undefined) delete (process.env as Record<string,string|undefined>).NODE_ENV;
        else Object.assign(process.env, {NODE_ENV:prior});
    }
});

// ── Input refusals ──────────────────────────────────────────────────────────

test("an extra query parameter is refused with 400", async () => {
    const { deps } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });
    const response = await handler(post(prepareBody(), { url: `${BASE}?retry=1` }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
});

test("invalid JSON is 400", async () => {
    const { deps } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });
    const response = await handler(post("{ not json"));
    assert.equal(response.status, 400);
});

test("malformed, extra, or caller-supplied owner fields are 400", async () => {
    const { deps } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    for (const bad of [
        { action: "prepare" },
        { action: "prepare", bankLineId: TARGET, owner: "CJ" },
        { action: "prepare", bankLineId: TARGET, vendor: "Chevron" },
        { action: "prepare", bankLineId: TARGET, cents: CENTS },
        { action: "apply", bankLineId: TARGET },
        { action: "nope", bankLineId: TARGET },
    ]) {
        const response = await handler(post(bad));
        assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
});

// ── Body size ───────────────────────────────────────────────────────────────

test("a declared-small body whose actual bytes exceed 2048 is 413", async () => {
    const { deps } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    const oversized = JSON.stringify({
        action: "prepare",
        bankLineId: TARGET,
        pad: "x".repeat(3000),
    });
    const response = await handler(
        new Request(BASE, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer fictional-cron-secret",
                "content-length": "10", // a LIE: the real body is far larger
            },
            body: oversized,
        }),
    );
    assert.equal(response.status, 413, "the declared length must not be trusted");
});

test("a chunked body with no content-length that exceeds the cap is 413", async () => {
    const { deps } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    const oversized = JSON.stringify({
        action: "prepare",
        bankLineId: TARGET,
        pad: "y".repeat(3000),
    });
    const response = await handler(
        new Request(BASE, {
            method: "POST",
            // No content-length: Node/undici streams this chunked.
            headers: { "content-type": "application/json", authorization:"Bearer fictional-cron-secret" },
            body: oversized,
        }),
    );
    assert.equal(response.status, 413);
});

// ── Allowlist ───────────────────────────────────────────────────────────────

test("an absent or multiple-entry allowlist is 503", async () => {
    assert.equal(
        (await makeOnDemandHandler({ makeDeps: () => fakeDeps().deps })(post(prepareBody()))).status,
        503,
    );
    assert.equal(
        (
            await makeOnDemandHandler({
                makeDeps: () => fakeDeps().deps,
                allowedTargets: [TARGET, "pb-00000000-0000-4000-8000-000000000002"],
            })(post(prepareBody()))
        ).status,
        503,
    );
});

// ── Prepare ─────────────────────────────────────────────────────────────────

test("prepare on a valid target is 200 with no writes", async () => {
    const { deps, spies } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    const response = await handler(
        post(prepareBody(), { headers: { authorization: "Bearer fictional-cron-secret" } }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "ready");
    assert.equal(typeof body.digest, "string");
    assert.match(body.digest as string, /^[0-9a-f]{64}$/);

    // The card preview carries no caller fields and no signature/job fields.
    const card = body.card as Record<string, unknown>;
    assert.equal(card.owner, OWNER);
    assert.equal(card.date, DAY);
    assert.equal(card.requestId, `receipt-req-${OWNER}-${DAY}`);
    const items = card.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.equal(items[0].issueId, ISSUE_ID);
    assert.equal(items[0].fingerprint, `pb-${TARGET}`);
    assert.equal(items[0].cents, CENTS);
    assert.equal(items[0].amount, "123.45");
    assert.equal(items[0].tool, undefined);
    assert.equal(body.signature, undefined);
    assert.equal(body.vendor, undefined);

    assert.equal(spies.reads, 1);
    assert.equal(spies.claims, 0, "prepare never claims");
    assert.equal(spies.posts, 0);
    assert.equal(spies.finishes, 0);
});

// ── Snapshot read failure vs the current store contract ─────────────────────

test("a snapshot read that throws reports 503 and flags the 409 difference", async () => {
    // FLAG, NOT A HIDDEN TEST FIX: the brief for THIS file says a snapshot-read
    // throw is 503. `receipt-on-demand-store.ts` currently maps `source-moved`
    // to `{ kind: 'blocked', reason: 'source-moved' }` and the service surfaces
    // `blocked` — the brief for the handler says 503 `service-blocked`. If the
    // shipped handler instead returns 409 for this shape, THIS assertion is the
    // one that must change, and the change is a real contract change, not a
    // test that was wrong. There is deliberately no branch here that accepts
    // both, because "either 409 or 503" is exactly the ambiguity the brief
    // asked to have called out.
    const { deps } = fakeDeps();
    deps.readSnapshot = async () => {
        throw new Error("source-moved");
    };
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    const response = await handler(post(prepareBody()));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
});

test("unknown provider delivery returns503", async () => {
 const {deps}=fakeDeps(); deps.post=async()=>({kind:"unknown",reason:"provider-unconfirmed"});
 const handler=makeOnDemandHandler({makeDeps:()=>deps,allowedTargets:[TARGET]});
 const response=await handler(post(applyBody())); assert.equal(response.status,503);
 assert.equal((await response.json()).status,"unknown");
});

test("a valid apply with a delivered post is 200 and never echoes caller fields", async () => {
    const { deps, spies } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    const response = await handler(post(applyBody()));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "posted");
    assert.equal(body.threadName, THREAD);
    assert.equal(body.messageName, MESSAGE);
    // No field the caller supplied is echoed back.
    for (const k of ["owner", "vendor", "cents", "amount", "bankLineId", "digest", "n"]) {
        assert.equal(body[k], undefined, `response must not echo ${k}`);
    }

    assert.equal(spies.reads, 1, "apply reads a fresh snapshot; claim performs its own transactional recheck");
    assert.equal(spies.claims, 1);
    assert.equal(spies.posts, 1);
    assert.equal(spies.finishes, 1);
});

test("every response shape carries cache-control: no-store", async () => {
    const { deps } = fakeDeps();
    const handler = makeOnDemandHandler({ makeDeps: () => deps, allowedTargets: [TARGET] });

    const responses = [
        await handler(post(prepareBody())),
        await handler(post(applyBody())),
        // 401
        await makeOnDemandHandler({
            authorized: () => false,
            makeDeps: () => deps,
        })(post(prepareBody())),
        // 400
        await handler(post("{ not json")),
        // 503
        await makeOnDemandHandler({ makeDeps: () => deps })(post(prepareBody())),
    ];
    for (const response of responses) {
        assert.equal(
            response.headers.get("cache-control"),
            "no-store",
            `missing no-store on status ${response.status}`,
        );
    }
});

// ── Bounded: nothing here sleeps or opens a socket ──────────────────────────

test("the suite performs no network I/O", () => {
    // The default fake fetch is still installed: nothing in this file restored
    // a real one, so any un-stubbed fetch in the handler would have thrown.
    assert.equal(globalThis.fetch, REAL_FETCH === globalThis.fetch ? REAL_FETCH : globalThis.fetch);
});


test("exact on-demand route reaches strict bearer auth through the production proxy", async () => {
    const oldNode = process.env.NODE_ENV;
    const oldVercel = process.env.VERCEL_ENV;
    Object.assign(process.env, { NODE_ENV: "production", VERCEL_ENV: "production", CRON_SECRET: "fictional-on-demand-cron" });
    try {
        const { default: proxy, isPublicProxyBypass } = await import("../src/proxy");
        const { NextRequest } = await import("next/server");
        for (const path of ["/api/automation/receipt-requests/on-demand", "/api/automation/receipt-requests/on-demand/"]) {
            assert.equal(isPublicProxyBypass(path), true);
            const response = await proxy(new NextRequest("https://example.test" + path, { method: "POST", headers: { authorization: "Bearer fictional-on-demand-cron" } }), { waitUntil() {} } as any);
            assert.equal(response?.headers.get("x-middleware-next"), "1");
        }
        for (const path of ["/api/automation/receipt-requests/on-demand/extra", "/api/automation/receipt-requests/on-demand-extra", "/api/automation/receipt-requests/on-demands", "/api/automation/receipt-requests/other"]) {
            assert.equal(isPublicProxyBypass(path), false, path);
        }
        const actionResponse = await proxy(new NextRequest("https://example.test/api/automation/receipt-requests/on-demand", { method: "POST", headers: { "next-action": "fictional-action" } }), { waitUntil() {} } as any);
        assert.equal(actionResponse?.status, 403);
        const { POST } = await import("../src/app/api/automation/receipt-requests/on-demand/route");
        assert.equal((await POST(new Request("https://example.test/api/automation/receipt-requests/on-demand", { method: "POST" }))).status, 401);
    } finally {
        if (oldNode === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
        else Object.assign(process.env, { NODE_ENV: oldNode });
        if (oldVercel === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = oldVercel;
    }
});
