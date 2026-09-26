import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/lib/speed-to-lead/hmac";

const SECRET = "test-secret";

function sign(timestamp: string, body: string, secret = SECRET): string {
    return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

test("a correctly signed, fresh request verifies", () => {
    const now = () => new Date(1_700_000_000_000);
    const timestamp = String(Math.floor(1_700_000_000_000 / 1000));
    const body = JSON.stringify({ a: 1 });
    const signature = sign(timestamp, body);
    const result = verifyWebhookSignature({ timestamp, signature, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, true);
});

test("skew: a timestamp more than 5 minutes old fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const timestamp = String(Math.floor((1_700_000_000_000 - 6 * 60 * 1000) / 1000));
    const body = "{}";
    const signature = sign(timestamp, body);
    const result = verifyWebhookSignature({ timestamp, signature, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /skew/);
});

test("skew: a timestamp in the future beyond 5 minutes fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const timestamp = String(Math.floor((1_700_000_000_000 + 6 * 60 * 1000) / 1000));
    const body = "{}";
    const signature = sign(timestamp, body);
    const result = verifyWebhookSignature({ timestamp, signature, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("a tampered body fails even with a valid-looking signature", () => {
    const now = () => new Date(1_700_000_000_000);
    const timestamp = String(Math.floor(1_700_000_000_000 / 1000));
    const signature = sign(timestamp, JSON.stringify({ a: 1 }));
    const result = verifyWebhookSignature({ timestamp, signature, rawBody: JSON.stringify({ a: 2 }), secret: SECRET }, now);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /mismatch/);
});

test("a signature made with the wrong secret fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const timestamp = String(Math.floor(1_700_000_000_000 / 1000));
    const body = "{}";
    const signature = sign(timestamp, body, "wrong-secret");
    const result = verifyWebhookSignature({ timestamp, signature, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("missing secret refuses rather than skipping verification", () => {
    const result = verifyWebhookSignature({ timestamp: "1700000000", signature: "aa", rawBody: "{}", secret: undefined });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /secret/);
});

test("missing timestamp or signature header refuses", () => {
    assert.equal(verifyWebhookSignature({ timestamp: null, signature: "aa", rawBody: "{}", secret: SECRET }).ok, false);
    assert.equal(verifyWebhookSignature({ timestamp: "1700000000", signature: null, rawBody: "{}", secret: SECRET }).ok, false);
});

test("non-numeric timestamp is refused, not coerced", () => {
    const result = verifyWebhookSignature({ timestamp: "not-a-number", signature: "aa", rawBody: "{}", secret: SECRET });
    assert.equal(result.ok, false);
});

test("non-hex signature is refused before any comparison", () => {
    const now = () => new Date(1_700_000_000_000);
    const timestamp = String(Math.floor(1_700_000_000_000 / 1000));
    const result = verifyWebhookSignature({ timestamp, signature: "not-hex!!", rawBody: "{}", secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("a signature of different length than expected never throws (constant-time guard)", () => {
    const now = () => new Date(1_700_000_000_000);
    const timestamp = String(Math.floor(1_700_000_000_000 / 1000));
    assert.doesNotThrow(() => verifyWebhookSignature({ timestamp, signature: "ab", rawBody: "{}", secret: SECRET }, now));
});
