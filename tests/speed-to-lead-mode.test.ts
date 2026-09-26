import test from "node:test";
import assert from "node:assert/strict";
import {
    speedToLeadMode, isProduction, isApprover, approverEmail, templateAEnabled,
    dailySendCap, testAllowlist, isAllowlistedRecipient,
} from "../src/lib/speed-to-lead/constants";

test("unset SPEED_TO_LEAD_MODE reads as OFF", () => {
    assert.equal(speedToLeadMode({} as unknown as NodeJS.ProcessEnv), "OFF");
});

test("a mistyped mode value reads as OFF, never as a guess", () => {
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "LIEV" } as unknown as NodeJS.ProcessEnv), "OFF");
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "on" } as unknown as NodeJS.ProcessEnv), "OFF");
});

test("TEST and LIVE are recognized case-sensitively after trim/uppercase", () => {
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "TEST" } as unknown as NodeJS.ProcessEnv), "TEST");
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "live" } as unknown as NodeJS.ProcessEnv), "LIVE");
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "  TEST  " } as unknown as NodeJS.ProcessEnv), "TEST");
});

test("isProduction is true only when VERCEL_ENV is exactly 'production'", () => {
    assert.equal(isProduction({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(isProduction({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv), false);
    assert.equal(isProduction({} as unknown as NodeJS.ProcessEnv), false);
});

test("isApprover matches case-insensitively and requires a configured approver", () => {
    const env = { SPEED_TO_LEAD_APPROVER_EMAIL: "Justin@GoldenTouchRemodeling.com" } as unknown as NodeJS.ProcessEnv;
    assert.equal(isApprover("justin@goldentouchremodeling.com", env), true);
    assert.equal(isApprover("someone-else@example.com", env), false);
    assert.equal(isApprover("justin@goldentouchremodeling.com", {} as unknown as NodeJS.ProcessEnv), false);
    assert.equal(isApprover(null, env), false);
});

test("approverEmail is normalized lowercase/trimmed", () => {
    assert.equal(approverEmail({ SPEED_TO_LEAD_APPROVER_EMAIL: " Justin@X.com " } as unknown as NodeJS.ProcessEnv), "justin@x.com");
});

test("templateAEnabled requires exactly 'on'", () => {
    assert.equal(templateAEnabled({ SPEED_TO_LEAD_TEMPLATE_A: "on" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(templateAEnabled({ SPEED_TO_LEAD_TEMPLATE_A: "true" } as unknown as NodeJS.ProcessEnv), false);
    assert.equal(templateAEnabled({} as unknown as NodeJS.ProcessEnv), false);
});

test("dailySendCap: unset or invalid means no cap (Infinity), never 0", () => {
    assert.equal(dailySendCap({} as unknown as NodeJS.ProcessEnv), Number.POSITIVE_INFINITY);
    assert.equal(dailySendCap({ SPEED_TO_LEAD_DAILY_CAP: "not-a-number" } as unknown as NodeJS.ProcessEnv), Number.POSITIVE_INFINITY);
    assert.equal(dailySendCap({ SPEED_TO_LEAD_DAILY_CAP: "0" } as unknown as NodeJS.ProcessEnv), Number.POSITIVE_INFINITY);
    assert.equal(dailySendCap({ SPEED_TO_LEAD_DAILY_CAP: "-5" } as unknown as NodeJS.ProcessEnv), Number.POSITIVE_INFINITY);
});

test("dailySendCap parses a positive integer, floored", () => {
    assert.equal(dailySendCap({ SPEED_TO_LEAD_DAILY_CAP: "12.7" } as unknown as NodeJS.ProcessEnv), 12);
});

test("testAllowlist parses a comma-separated, normalized set", () => {
    const set = testAllowlist({ SPEED_TO_LEAD_TEST_ALLOWLIST: "A@x.com, B@Y.com ,," } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual([...set].sort(), ["a@x.com", "b@y.com"]);
});

test("isAllowlistedRecipient matches case-insensitively", () => {
    const env = { SPEED_TO_LEAD_TEST_ALLOWLIST: "test@example.com" } as unknown as NodeJS.ProcessEnv;
    assert.equal(isAllowlistedRecipient("Test@Example.com", env), true);
    assert.equal(isAllowlistedRecipient("other@example.com", env), false);
});
