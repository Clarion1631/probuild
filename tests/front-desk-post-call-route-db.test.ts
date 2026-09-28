/**
 * Front Desk v1 acceptance test 10 — "a non-transcription type or another
 * agent_id -> 200 ignored, no lead", against the REAL route handler
 * (src/app/api/front-desk/post-call/route.ts). No prior test exercised this:
 * front-desk-post-call.test.ts only unit-tests extractPostCallFacts/
 * determinePostCallOutcome, and front-desk-post-call-db.test.ts only calls
 * processPostCallInTx directly — the route's own step-5 ignore branch
 * (type/agent_id gating, before processPostCallInTx is ever reached) had
 * zero coverage. Against a REAL PostgreSQL (SPEED_TO_LEAD_TEST_URL), since
 * the ignore branch writes a `front-desk-webhook-ignored` SpeedToLeadEvent.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

const WEBHOOK_SECRET = "test-elevenlabs-webhook-secret-for-post-call-route";
const AGENT_ID = "agent_test_for_post_call_route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (request: Request) => Promise<any>;
let POST: RouteHandler;
let db: PrismaClient;
let originalEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["DATABASE_URL", "FRONT_DESK_ELEVENLABS_WEBHOOK_SECRET", "FRONT_DESK_AGENT_ID", "FRONT_DESK_MODE", "SPEED_TO_LEAD_MODE"] as const;

before(async () => {
    if (skip) return;
    originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    process.env.DATABASE_URL = databaseUrl;
    process.env.FRONT_DESK_ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.FRONT_DESK_AGENT_ID = AGENT_ID;
    process.env.FRONT_DESK_MODE = "TEST";
    process.env.SPEED_TO_LEAD_MODE = "TEST";

    const routeMod = await import("../src/app/api/front-desk/post-call/route");
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

function signedRequest(body: unknown, secret = WEBHOOK_SECRET): Request {
    const rawBody = JSON.stringify(body);
    const t = String(Math.floor(Date.now() / 1000));
    const v0 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
    return new Request("https://probuild-frontdesk-test.example/api/front-desk/post-call", {
        method: "POST",
        headers: { "content-type": "application/json", "elevenlabs-signature": `t=${t},v0=${v0}` },
        body: rawBody,
    });
}

function envelope(overrides: { type?: string; agentId?: string | null; conversationId?: string } = {}) {
    return {
        type: overrides.type ?? "post_call_transcription",
        data: {
            agent_id: overrides.agentId === undefined ? AGENT_ID : overrides.agentId,
            conversation_id: overrides.conversationId ?? `conv-${randomUUID()}`,
            metadata: { phone_call: { external_number: "+13605550100" } },
            analysis: { transcript_summary: "test", data_collection_results: {} },
        },
    };
}

async function assertNoFrontDeskCall(conversationId: string): Promise<void> {
    const rows = await db.frontDeskCall.findMany({ where: { conversationId } });
    assert.deepEqual(rows, [], "an ignored webhook must write no FrontDeskCall row");
}

test("a non-transcription type (post_call_audio) -> 200 {ok:true, ignored:'type'}, logged, no FrontDeskCall row", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const res = await POST(signedRequest(envelope({ type: "post_call_audio", conversationId })));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, ignored: "type" });

    await assertNoFrontDeskCall(conversationId);
    const events = await db.speedToLeadEvent.findMany({ where: { kind: "front-desk-webhook-ignored" }, orderBy: { createdAt: "desc" }, take: 10 });
    const match = events.find(e => (e.detail as { reason?: string; type?: string } | null)?.reason === "type" && (e.detail as { type?: string } | null)?.type === "post_call_audio");
    assert.ok(match, "the ignored-type event must be logged with the actual type value");
});

test("call_initiation_failure (a real ElevenLabs event type, just not the one this route processes) -> ignored:'type'", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const res = await POST(signedRequest(envelope({ type: "call_initiation_failure", conversationId })));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "type" });
    await assertNoFrontDeskCall(conversationId);
});

test("a wrong agent_id (correct type) -> 200 {ok:true, ignored:'agent'}, logged, no FrontDeskCall row", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const res = await POST(signedRequest(envelope({ agentId: "agent_someone_elses", conversationId })));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "agent" });

    await assertNoFrontDeskCall(conversationId);
    const events = await db.speedToLeadEvent.findMany({ where: { kind: "front-desk-webhook-ignored" }, orderBy: { createdAt: "desc" }, take: 10 });
    const match = events.find(e => (e.detail as { reason?: string; agentId?: string } | null)?.reason === "agent" && (e.detail as { agentId?: string } | null)?.agentId === "agent_someone_elses");
    assert.ok(match, "the ignored-agent event must be logged with the actual agent_id value");
});

test("a null agent_id -> ignored:'agent' (never matches an unset expected agent, never crashes)", { skip }, async () => {
    const conversationId = `conv-${randomUUID()}`;
    const res = await POST(signedRequest(envelope({ agentId: null, conversationId })));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "agent" });
    await assertNoFrontDeskCall(conversationId);
});

// Note: a genuinely valid type+agent request is deliberately NOT exercised
// through this real route handler — its success path calls next/server's
// `after()`, which throws "called outside a request scope" when the route
// is invoked directly outside Next's own request lifecycle (confirmed by a
// standalone repro against this exact Next.js version). That full
// success path is already covered end-to-end via `processPostCallInTx`
// directly in tests/front-desk-post-call-db.test.ts; this file's job is
// only the route's own pre-processPostCallInTx type/agent gate.
