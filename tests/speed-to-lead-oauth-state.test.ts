/**
 * The lead-inbox OAuth `state`: signed over {approverEmail, sid, nonce,
 * issuedAt}, single-use through an AutomationSetting unique-key insert. This
 * file covers every check that runs BEFORE that DB insert (signature, sid
 * binding, expiry, double-submit cookie) without touching the database —
 * the single-use DB consumption itself is exercised end to end manually
 * during R2/R3 (Justin connecting the real mailbox), since mocking the
 * global `prisma` singleton is out of scope for this pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    mintLeadInboxState, isLeadInboxState, leadInboxStateNonce, verifyAndConsumeLeadInboxState,
} from "../src/lib/speed-to-lead/gmail-inbox-client";

const ORIGINAL_SECRET = process.env.NEXTAUTH_SECRET;
test.before(() => { process.env.NEXTAUTH_SECRET = "test-nextauth-secret"; });
test.after(() => { process.env.NEXTAUTH_SECRET = ORIGINAL_SECRET; });

test("a minted state is recognized and carries its nonce", () => {
    const state = mintLeadInboxState("justin@goldentouchremodeling.com", "sid-1");
    assert.equal(isLeadInboxState(state), true);
    assert.ok(leadInboxStateNonce(state));
});

test("an ordinary NextAuth state (or anything else) is never mistaken for ours", () => {
    assert.equal(isLeadInboxState("some-other-state-value"), false);
    assert.equal(isLeadInboxState(null), false);
});

test("verification fails with no sid at all — a session issued before this feature shipped is refused, not wildcarded", async () => {
    const state = mintLeadInboxState("justin@goldentouchremodeling.com", "sid-1");
    const nonce = leadInboxStateNonce(state)!;
    const ok = await verifyAndConsumeLeadInboxState(state, "justin@goldentouchremodeling.com", null, nonce);
    assert.equal(ok, false);
});

test("verification fails when the session's sid does not match the one the state was minted for", async () => {
    const state = mintLeadInboxState("justin@goldentouchremodeling.com", "sid-1");
    const nonce = leadInboxStateNonce(state)!;
    const ok = await verifyAndConsumeLeadInboxState(state, "justin@goldentouchremodeling.com", "sid-2", nonce);
    assert.equal(ok, false);
});

test("verification fails without the double-submit cookie nonce", async () => {
    const state = mintLeadInboxState("justin@goldentouchremodeling.com", "sid-1");
    const ok = await verifyAndConsumeLeadInboxState(state, "justin@goldentouchremodeling.com", "sid-1", null);
    assert.equal(ok, false);
});

test("verification fails when the cookie nonce does not match the state's own nonce", async () => {
    const state = mintLeadInboxState("justin@goldentouchremodeling.com", "sid-1");
    const ok = await verifyAndConsumeLeadInboxState(state, "justin@goldentouchremodeling.com", "sid-1", "wrong-nonce");
    assert.equal(ok, false);
});

test("verification fails on a mismatched email", async () => {
    const state = mintLeadInboxState("justin@goldentouchremodeling.com", "sid-1");
    const nonce = leadInboxStateNonce(state)!;
    const ok = await verifyAndConsumeLeadInboxState(state, "someone-else@example.com", "sid-1", nonce);
    assert.equal(ok, false);
});

test("verification fails on a tampered state (base64 payload edited)", async () => {
    const state = mintLeadInboxState("justin@goldentouchremodeling.com", "sid-1");
    const nonce = leadInboxStateNonce(state)!;
    const tampered = state.slice(0, -4) + "AAAA";
    const ok = await verifyAndConsumeLeadInboxState(tampered, "justin@goldentouchremodeling.com", "sid-1", nonce);
    assert.equal(ok, false);
});

test("verification fails on an expired state (beyond the 10-minute TTL)", async () => {
    const nonce = "fixed-nonce";
    const issuedAt = Date.now() - 11 * 60 * 1000;
    const { createHmac } = await import("node:crypto");
    const payload = `justin@goldentouchremodeling.com:sid-1:${nonce}:${issuedAt}`;
    const sig = createHmac("sha256", process.env.NEXTAUTH_SECRET ?? "").update(payload).digest("hex");
    const state = `leadinbox.${Buffer.from(`${payload}:${sig}`).toString("base64url")}`;
    const ok = await verifyAndConsumeLeadInboxState(state, "justin@goldentouchremodeling.com", "sid-1", nonce);
    assert.equal(ok, false);
});
