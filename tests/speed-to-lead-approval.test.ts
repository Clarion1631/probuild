import test from "node:test";
import assert from "node:assert/strict";
import { computeApprovalHash, hashesMatch, currentEnvironmentContext, type ApprovalHashInput } from "../src/lib/speed-to-lead/approval";

const BASE: ApprovalHashInput = {
    leadId: "lead-1", messageId: "msg-1", generation: 1,
    from: "gtrsupport@goldentouchremodeling.com", to: "client@example.com",
    subject: "Hi", body: "Body text", footer: "Footer text",
    inReplyTo: null, references: null, threadId: null,
};
const ENV = { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://probuild.goldentouchremodeling.com" } as unknown as NodeJS.ProcessEnv;

test("computeApprovalHash is deterministic for identical input and environment", () => {
    assert.equal(computeApprovalHash(BASE, ENV), computeApprovalHash({ ...BASE }, ENV));
});

test("computeApprovalHash changes when any covered field changes", () => {
    const base = computeApprovalHash(BASE, ENV);
    for (const key of Object.keys(BASE) as (keyof ApprovalHashInput)[]) {
        const value = BASE[key];
        const changed = computeApprovalHash({ ...BASE, [key]: typeof value === "number" ? value + 1 : `${value}-changed` }, ENV);
        assert.notEqual(changed, base, `changing ${key} should change the hash`);
    }
});

test("computeApprovalHash changes when the environment (VERCEL_ENV or base URL) changes", () => {
    const preview = computeApprovalHash(BASE, { ...ENV, VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv);
    const prod = computeApprovalHash(BASE, ENV);
    assert.notEqual(preview, prod);

    const differentUrl = computeApprovalHash(BASE, { ...ENV, NEXT_PUBLIC_APP_URL: "https://staging.example.com" } as unknown as NodeJS.ProcessEnv);
    assert.notEqual(differentUrl, prod);
});

test("threading fields (inReplyTo/references/threadId) are covered by the hash", () => {
    const withThreading = computeApprovalHash({ ...BASE, inReplyTo: "<abc@x>", references: "<abc@x>", threadId: "t1" }, ENV);
    assert.notEqual(withThreading, computeApprovalHash(BASE, ENV));
});

test("hashesMatch is a true constant-time equality check", () => {
    const a = computeApprovalHash(BASE, ENV);
    assert.equal(hashesMatch(a, a), true);
    assert.equal(hashesMatch(a, computeApprovalHash({ ...BASE, subject: "different" }, ENV)), false);
});

test("hashesMatch never throws on mismatched lengths", () => {
    assert.equal(hashesMatch("ab", "abcd"), false);
    assert.equal(hashesMatch("", ""), false);
});

test("currentEnvironmentContext falls back to NEXTAUTH_URL when NEXT_PUBLIC_APP_URL is unset", () => {
    const ctx = currentEnvironmentContext({ VERCEL_ENV: "production", NEXTAUTH_URL: "https://fallback.example.com" } as unknown as NodeJS.ProcessEnv);
    assert.ok(ctx.includes("fallback.example.com"));
});
