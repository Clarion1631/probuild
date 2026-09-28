/**
 * Front Desk v1 acceptance tests 1 and 2 (docs/plans/FRONT-DESK-V1.md §6):
 * ElevenLabs post-call signature verification and the tool-route shared
 * secret.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyElevenLabsSignature, verifyToolSecret } from "../src/lib/front-desk/auth";

const SECRET = "front-desk-webhook-secret";

function sign(t: string, body: string, secret = SECRET): string {
    return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

test("a valid ElevenLabs signature verifies", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor(1_700_000_000_000 / 1000));
    const body = JSON.stringify({ type: "post_call_transcription" });
    const header = `t=${t},v0=${sign(t, body)}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, true);
});

test("a tampered body fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor(1_700_000_000_000 / 1000));
    const header = `t=${t},v0=${sign(t, JSON.stringify({ a: 1 }))}`;
    const result = verifyElevenLabsSignature({ header, rawBody: JSON.stringify({ a: 2 }), secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("wrong secret fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor(1_700_000_000_000 / 1000));
    const body = "{}";
    const header = `t=${t},v0=${sign(t, body, "some-other-secret")}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("missing t fails", () => {
    const result = verifyElevenLabsSignature({ header: "v0=abcd", rawBody: "{}", secret: SECRET });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /t=/);
});

test("missing v0 fails", () => {
    const result = verifyElevenLabsSignature({ header: "t=1700000000", rawBody: "{}", secret: SECRET });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /v0=/);
});

test("a non-hex v0 fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor(1_700_000_000_000 / 1000));
    const result = verifyElevenLabsSignature({ header: `t=${t},v0=not-hex-zzzz`, rawBody: "{}", secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("t older than 30 minutes fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor((1_700_000_000_000 - 31 * 60 * 1000) / 1000));
    const body = "{}";
    const header = `t=${t},v0=${sign(t, body)}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("t exactly 29 minutes old still passes (inside the 30-minute rule)", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor((1_700_000_000_000 - 29 * 60 * 1000) / 1000));
    const body = "{}";
    const header = `t=${t},v0=${sign(t, body)}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, true);
});

test("t more than 5 minutes in the future fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor((1_700_000_000_000 + 6 * 60 * 1000) / 1000));
    const body = "{}";
    const header = `t=${t},v0=${sign(t, body)}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("an unset secret always fails, even with a correctly-formed signature", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor(1_700_000_000_000 / 1000));
    const body = "{}";
    const header = `t=${t},v0=${sign(t, body)}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: undefined }, now);
    assert.equal(result.ok, false);
});

test("exactly one t= and at least one v0= is required — two t= values fails", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor(1_700_000_000_000 / 1000));
    const body = "{}";
    const header = `t=${t},t=${t},v0=${sign(t, body)}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, false);
});

test("multiple v0 values: any matching one verifies (key-rotation shape)", () => {
    const now = () => new Date(1_700_000_000_000);
    const t = String(Math.floor(1_700_000_000_000 / 1000));
    const body = "{}";
    const header = `t=${t},v0=deadbeef,v0=${sign(t, body)}`;
    const result = verifyElevenLabsSignature({ header, rawBody: body, secret: SECRET }, now);
    assert.equal(result.ok, true);
});

// ── Tool secret (§2.0) ──────────────────────────────────────────────────

test("an exact tool-secret match verifies", () => {
    assert.equal(verifyToolSecret("s3cr3t", "s3cr3t"), true);
});

test("a wrong tool secret fails", () => {
    assert.equal(verifyToolSecret("wrong", "s3cr3t"), false);
});

test("an empty given value fails", () => {
    assert.equal(verifyToolSecret("", "s3cr3t"), false);
    assert.equal(verifyToolSecret(null, "s3cr3t"), false);
});

test("a different-length value fails (no length-oracle exception)", () => {
    assert.equal(verifyToolSecret("short", "a-much-longer-secret-value"), false);
});

test("an unset env secret always fails", () => {
    assert.equal(verifyToolSecret("anything", undefined), false);
});
