/**
 * Front Desk v1 acceptance test 3 — the bridge number's Voice URL (§3.2):
 * bad `X-Twilio-Signature`, wrong `AccountSid`, wrong `From`/`To`, and a
 * missing auth token, against the REAL route handler
 * (src/app/api/front-desk/bridge-twiml/route.ts). No test in this repo
 * previously invoked that route at all — every existing "twiml" test only
 * exercises the pure string-building functions in twiml.ts. Against a REAL
 * PostgreSQL (SPEED_TO_LEAD_TEST_URL): `logLeadEvent` writes a
 * SpeedToLeadEvent row on every reject path this file exercises, and the
 * `?step=…&t=…` cases read a real FrontDeskTransfer row.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

const AUTH_TOKEN = "test-twilio-auth-token-for-bridge-twiml";
const ACCOUNT_SID = "ACtestaccount00000000000000000000";
const BRIDGE_NUMBER = "+13605559000";
const FRONT_DESK_NUMBER = "+13608032397";
const RICHARD_NUMBER = "+13602071549";
const APP_URL = "https://probuild-frontdesk-test.example";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (request: Request) => Promise<any>;
let POST: RouteHandler;
let db: PrismaClient;
let originalEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
    "DATABASE_URL", "TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "NEXT_PUBLIC_APP_URL",
    "FRONT_DESK_MODE", "SPEED_TO_LEAD_MODE", "FRONT_DESK_BRIDGE_NUMBER_E164",
    "FRONT_DESK_NUMBER_E164", "FRONT_DESK_RICHARD_E164",
] as const;

before(async () => {
    if (skip) return;
    originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    process.env.DATABASE_URL = databaseUrl;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    process.env.FRONT_DESK_MODE = "TEST";
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    process.env.FRONT_DESK_BRIDGE_NUMBER_E164 = BRIDGE_NUMBER;
    process.env.FRONT_DESK_NUMBER_E164 = FRONT_DESK_NUMBER;
    process.env.FRONT_DESK_RICHARD_E164 = RICHARD_NUMBER;

    const routeMod = await import("../src/app/api/front-desk/bridge-twiml/route");
    POST = routeMod.POST as RouteHandler;
    const prismaMod = await import("../src/lib/prisma");
    db = prismaMod.prisma;
});

after(async () => {
    if (skip) return;
    for (const k of ENV_KEYS) {
        if (originalEnv[k] === undefined) delete process.env[k];
        else process.env[k] = originalEnv[k];
    }
    await db.$disconnect();
});

function buildUrl(step?: string, t?: string): URL {
    const url = new URL(`${APP_URL}/api/front-desk/bridge-twiml`);
    if (step) url.searchParams.set("step", step);
    if (t) url.searchParams.set("t", t);
    return url;
}

function sign(url: URL, params: Record<string, string>, authToken = AUTH_TOKEN): string {
    return twilio.getExpectedTwilioSignature(authToken, url.toString(), params);
}

function postRequest(url: URL, params: Record<string, string>, signature: string): Request {
    const body = new URLSearchParams(params);
    return new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
        body: body.toString(),
    });
}

function inboundParams(overrides: Partial<{ To: string; From: string; AccountSid: string }> = {}): Record<string, string> {
    return {
        CallSid: `CA-${randomUUID()}`,
        AccountSid: ACCOUNT_SID,
        To: BRIDGE_NUMBER,
        From: FRONT_DESK_NUMBER,
        ...overrides,
    };
}

async function readTextBody(response: Response): Promise<string> {
    return response.text();
}

// ── Missing auth token -> 503 ───────────────────────────────────────────

test("a missing TWILIO_AUTH_TOKEN -> 503, before any signature check or DB access", { skip }, async () => {
    const original = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_AUTH_TOKEN;
    try {
        const url = buildUrl();
        const params = inboundParams();
        const res = await POST(postRequest(url, params, "irrelevant-because-token-is-checked-first"));
        assert.equal(res.status, 503);
    } finally {
        process.env.TWILIO_AUTH_TOKEN = original;
    }
});

// ── Bad signature -> 403 ─────────────────────────────────────────────────

test("a bad/tampered X-Twilio-Signature -> 403 forbidden", { skip }, async () => {
    const url = buildUrl();
    const params = inboundParams();
    const res = await POST(postRequest(url, params, "0000not-a-real-signature0000"));
    assert.equal(res.status, 403);
});

test("a signature computed with the WRONG auth token -> 403 forbidden", { skip }, async () => {
    const url = buildUrl();
    const params = inboundParams();
    const badSig = sign(url, params, "a-different-auth-token-entirely");
    const res = await POST(postRequest(url, params, badSig));
    assert.equal(res.status, 403);
});

// ── Valid signature, wrong AccountSid/From/To -> Reject, logged ─────────

test("a valid signature but wrong AccountSid -> 200 <Reject/> (never a 403 — the signature itself was genuine)", { skip }, async () => {
    const url = buildUrl();
    const params = inboundParams({ AccountSid: "ACwrongaccount000000000000000000" });
    const sig = sign(url, params);
    const res = await POST(postRequest(url, params, sig));
    assert.equal(res.status, 200);
    assert.match(await readTextBody(res), /<Reject\/>/);
});

test("a valid signature but wrong From -> Reject, and a front-desk-bridge-rejected event is logged with reason number-mismatch", { skip }, async () => {
    const url = buildUrl();
    const params = inboundParams({ From: "+15555550123" });
    const sig = sign(url, params);
    const res = await POST(postRequest(url, params, sig));
    assert.equal(res.status, 200);
    assert.match(await readTextBody(res), /<Reject\/>/);

    const events = await db.speedToLeadEvent.findMany({ where: { kind: "front-desk-bridge-rejected" }, orderBy: { createdAt: "desc" }, take: 5 });
    const match = events.find(e => (e.detail as { reason?: string } | null)?.reason === "number-mismatch");
    assert.ok(match, "a wrong From must be logged as number-mismatch");

    // Codex SHIP-BLOCKING finding #4 (round 2 follow-up): this authenticated
    // CallSid's reject decision must be persisted here too, not only for the
    // "no eligible row" case, or a replay after the gate no longer applies
    // could claim a different caller's transfer (see the mode-off test below).
    const ledgerRow = await db.frontDeskTransfer.findUnique({ where: { bridgeCallSid: params.CallSid } });
    assert.equal(ledgerRow?.status, "EXPIRED");
    assert.equal(ledgerRow?.reason, "number-mismatch");
});

test("a valid signature but wrong To -> Reject, logged as number-mismatch", { skip }, async () => {
    const url = buildUrl();
    const params = inboundParams({ To: "+15555550199" });
    const sig = sign(url, params);
    const res = await POST(postRequest(url, params, sig));
    assert.equal(res.status, 200);
    assert.match(await readTextBody(res), /<Reject\/>/);

    const events = await db.speedToLeadEvent.findMany({ where: { kind: "front-desk-bridge-rejected" }, orderBy: { createdAt: "desc" }, take: 5 });
    const match = events.find(e => (e.detail as { reason?: string } | null)?.reason === "number-mismatch");
    assert.ok(match, "a wrong To must be logged as number-mismatch");
});

// ── Codex SHIP-BLOCKING finding #4 (round 2 follow-up) ───────────────────
// An authenticated request rejected by a route-level gate (mode OFF, not
// configured) used to leave no ledger row, so a Twilio retry of the exact
// same signed request, replayed after the gate no longer applies, reached
// resolveInboundBridgeClaim completely fresh and could claim a different,
// later caller's PREPARED transfer. These tests reproduce that replay
// against the real route and prove the persisted decision blocks it.

test("mode OFF -> Reject, and the CallSid's decision is persisted as reason mode-off", { skip }, async () => {
    const original = process.env.FRONT_DESK_MODE;
    process.env.FRONT_DESK_MODE = "OFF";
    try {
        const url = buildUrl();
        const params = inboundParams();
        const sig = sign(url, params);
        const res = await POST(postRequest(url, params, sig));
        assert.equal(res.status, 200);
        assert.match(await readTextBody(res), /<Reject\/>/);

        const ledgerRow = await db.frontDeskTransfer.findUnique({ where: { bridgeCallSid: params.CallSid } });
        assert.equal(ledgerRow?.status, "EXPIRED");
        assert.equal(ledgerRow?.reason, "mode-off");
    } finally {
        process.env.FRONT_DESK_MODE = original;
    }
});

test("a request rejected while mode is OFF, replayed with the identical CallSid after mode flips back on, still Rejects — it must NOT claim a different caller's PREPARED transfer", { skip }, async () => {
    const url = buildUrl();
    const params = inboundParams();
    const sig = sign(url, params);

    const original = process.env.FRONT_DESK_MODE;
    process.env.FRONT_DESK_MODE = "OFF";
    try {
        const firstRes = await POST(postRequest(url, params, sig));
        assert.equal(firstRes.status, 200);
        assert.match(await readTextBody(firstRes), /<Reject\/>/);
    } finally {
        process.env.FRONT_DESK_MODE = original;
    }

    // A different, genuine caller prepares a transfer while mode is back on.
    const victim = await db.frontDeskTransfer.create({
        data: {
            id: randomUUID(), conversationId: `bridge-replay-victim-${randomUUID()}`, status: "PREPARED", isTest: true,
            callerName: "Victim Caller", callbackPhoneE164: "+13605550111", city: "X", project: "Y",
            preparedAt: new Date(),
        },
    });

    try {
        // Twilio retries the IDENTICAL signed request (same CallSid, same
        // signature) now that mode is back on.
        const replayRes = await POST(postRequest(url, params, sig));
        assert.equal(replayRes.status, 200);
        assert.match(await readTextBody(replayRes), /<Reject\/>/, "the replay must still reject, not dial Richard for someone else's transfer");

        const victimAfter = await db.frontDeskTransfer.findUniqueOrThrow({ where: { id: victim.id } });
        assert.equal(victimAfter.status, "PREPARED", "the victim's own transfer must be untouched and still claimable by ITS real inbound call");
        assert.equal(victimAfter.bridgeCallSid, null);
    } finally {
        // Left PREPARED, the victim is claimed by the NEXT inbound request in
        // this file, which then leaves a lead plus due NTFY/NTFY_URGENT alerts
        // on the shared CI Postgres for every later deliverDueAlerts() call.
        await db.frontDeskTransfer.deleteMany({ where: { id: victim.id } }).catch(() => undefined);
    }
});

// ── A genuinely valid, well-formed request with nothing PREPARED -> Reject, logged ──

test("a fully valid, well-formed inbound request with no PREPARED transfer waiting -> Reject, logged as front-desk-bridge-unmatched", { skip }, async () => {
    const url = buildUrl();
    const params = inboundParams();
    const sig = sign(url, params);
    const res = await POST(postRequest(url, params, sig));
    assert.equal(res.status, 200);
    assert.match(await readTextBody(res), /<Reject\/>/);

    const events = await db.speedToLeadEvent.findMany({ where: { kind: "front-desk-bridge-unmatched" }, orderBy: { createdAt: "desc" }, take: 5 });
    assert.ok(events.some(e => (e.detail as { callSid?: string } | null)?.callSid === params.CallSid));
});

// ── The signature is validated over the FULL URL, including ?step=…&t=… ──

test("a valid signature over a URL carrying ?step=action&t=<id> validates — an unmatched id resolves through the normal action/Hangup path", { skip }, async () => {
    const fakeTransferId = randomUUID();
    const url = buildUrl("action", fakeTransferId);
    const params = { CallSid: `CA-${randomUUID()}`, AccountSid: ACCOUNT_SID, DialCallStatus: "completed", DialBridged: "false" };
    const sig = sign(url, params);
    const res = await POST(postRequest(url, params, sig));
    // A valid signature over the step/t-carrying URL reaches handleAction
    // (not a 403), which hangs up on an unmatched transfer id.
    assert.equal(res.status, 200);
    assert.match(await readTextBody(res), /<Hangup\/>/);
});

test("tampering with the t= value after signing (a different transfer id) invalidates the signature -> 403", { skip }, async () => {
    const signedUrl = buildUrl("action", randomUUID());
    const params = { CallSid: `CA-${randomUUID()}`, AccountSid: ACCOUNT_SID, DialCallStatus: "completed", DialBridged: "false" };
    const sig = sign(signedUrl, params);
    // Swap in a different `t` after signing — the signature no longer matches this URL.
    const tamperedUrl = buildUrl("action", randomUUID());
    const res = await POST(postRequest(tamperedUrl, params, sig));
    assert.equal(res.status, 403);
});
