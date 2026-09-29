/**
 * Regression test for POST /api/ai/sub-safety-tips: a model refusal
 * (stop_reason "refusal") must come back as a JSON 422, not an uncaught
 * AnthropicRefusalError. Stubs prisma delegates and global fetch (the SDK's
 * transport), so no database or real API call is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DATABASE_URL ??= "postgresql://u:p@127.0.0.1:1/db?pgbouncer=true";

import { prisma } from "../src/lib/prisma";
import { POST } from "../src/app/api/ai/sub-safety-tips/route";

function stubDb() {
    const db = prisma as unknown as {
        subcontractor: { findUnique: unknown };
        subTaskAssignment: { findMany: unknown };
    };
    db.subcontractor.findUnique = async () => ({ companyName: "Acme Framing", contactName: "Sam", trade: "Framing" });
    db.subTaskAssignment.findMany = async () => [];
}

function stubAnthropic(message: { stop_reason: string; content: unknown[] }) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response(
            JSON.stringify({
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-5-5",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
                ...message,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

function req(body: unknown) {
    return new Request("https://example.test/api/ai/sub-safety-tips", { method: "POST", body: JSON.stringify(body) });
}

test("a model refusal returns JSON 422 instead of throwing", async () => {
    stubDb();
    const restore = stubAnthropic({ stop_reason: "refusal", content: [] });
    try {
        const res = await POST(req({ subcontractorId: "sub1" }) as never);
        assert.equal(res.status, 422);
        const body = (await res.json()) as { error: string };
        assert.equal(typeof body.error, "string");
        assert.ok(body.error.length > 0);
    } finally {
        restore();
    }
});

test("a normal response still returns the parsed tips", async () => {
    stubDb();
    const restore = stubAnthropic({
        stop_reason: "end_turn",
        content: [
            { type: "thinking", thinking: "", signature: "s" },
            { type: "text", text: '[{"title":"Ladder Check","tip":"Inspect rungs."}]', citations: null },
        ],
    });
    try {
        const res = await POST(req({ subcontractorId: "sub1" }) as never);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { success: boolean; tips: Array<{ title: string }> };
        assert.equal(body.success, true);
        assert.equal(body.tips[0].title, "Ladder Check");
    } finally {
        restore();
    }
});
