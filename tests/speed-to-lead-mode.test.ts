import test from "node:test";
import assert from "node:assert/strict";
import { speedToLeadMode, isProduction, chatCardsEnabled, isApprover, approverEmail } from "../src/lib/speed-to-lead/constants";

test("unset SPEED_TO_LEAD_MODE reads as OFF", () => {
    assert.equal(speedToLeadMode({} as unknown as NodeJS.ProcessEnv), "OFF");
});

test("a mistyped mode value reads as OFF, never as a guess", () => {
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "LIEV" } as unknown as NodeJS.ProcessEnv), "OFF");
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "yes" } as unknown as NodeJS.ProcessEnv), "OFF");
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "Live " } as unknown as NodeJS.ProcessEnv), "LIVE");
});

test("TEST and LIVE are recognized case-insensitively after trim/uppercase", () => {
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "TEST" } as unknown as NodeJS.ProcessEnv), "TEST");
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "live" } as unknown as NodeJS.ProcessEnv), "LIVE");
    assert.equal(speedToLeadMode({ SPEED_TO_LEAD_MODE: "  TEST  " } as unknown as NodeJS.ProcessEnv), "TEST");
});

test("isProduction is true only when VERCEL_ENV is exactly 'production'", () => {
    assert.equal(isProduction({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(isProduction({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv), false);
    assert.equal(isProduction({} as unknown as NodeJS.ProcessEnv), false);
});

test("chatCardsEnabled requires LIVE AND production together — LIVE on preview creates no CHAT rows", () => {
    assert.equal(chatCardsEnabled({ SPEED_TO_LEAD_MODE: "LIVE", VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(chatCardsEnabled({ SPEED_TO_LEAD_MODE: "LIVE", VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv), false);
    assert.equal(chatCardsEnabled({ SPEED_TO_LEAD_MODE: "TEST", VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), false);
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
