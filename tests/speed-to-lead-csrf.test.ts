import test from "node:test";
import assert from "node:assert/strict";
import { mintOutreachCsrfToken, verifyOutreachCsrfToken, isSameOriginRequest } from "../src/lib/speed-to-lead/csrf";

const OLD_SECRET = process.env.NEXTAUTH_SECRET;
test.before(() => { process.env.NEXTAUTH_SECRET = "test-nextauth-secret"; });
test.after(() => { process.env.NEXTAUTH_SECRET = OLD_SECRET; });

test("a minted token verifies for the exact same email/message/version", () => {
    const token = mintOutreachCsrfToken("justin@x.com", "msg-1", "v-1");
    assert.equal(verifyOutreachCsrfToken(token, "justin@x.com", "msg-1", "v-1"), true);
});

test("a token minted for one message does not verify for another", () => {
    const token = mintOutreachCsrfToken("justin@x.com", "msg-1", "v-1");
    assert.equal(verifyOutreachCsrfToken(token, "justin@x.com", "msg-2", "v-1"), false);
});

test("a token minted for one session email does not verify for another", () => {
    const token = mintOutreachCsrfToken("justin@x.com", "msg-1", "v-1");
    assert.equal(verifyOutreachCsrfToken(token, "someone-else@x.com", "msg-1", "v-1"), false);
});

test("a token minted for one version discriminator (e.g. 'draft') does not verify for another ('send-again')", () => {
    const token = mintOutreachCsrfToken("justin@x.com", "msg-1", "draft");
    assert.equal(verifyOutreachCsrfToken(token, "justin@x.com", "msg-1", "send-again"), false);
});

test("verification fails closed when NEXTAUTH_SECRET is unset", () => {
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
        assert.equal(verifyOutreachCsrfToken("anything", "justin@x.com", "msg-1", "v-1"), false);
    } finally {
        process.env.NEXTAUTH_SECRET = saved;
    }
});

test("isSameOriginRequest matches the app's own configured origin", () => {
    const env = { NEXT_PUBLIC_APP_URL: "https://probuild.goldentouchremodeling.com" } as unknown as NodeJS.ProcessEnv;
    assert.equal(isSameOriginRequest("https://probuild.goldentouchremodeling.com", env), true);
    assert.equal(isSameOriginRequest("https://evil.example.com", env), false);
});

test("isSameOriginRequest refuses when there is no Origin header or no configured base URL", () => {
    assert.equal(isSameOriginRequest(null, { NEXT_PUBLIC_APP_URL: "https://x.com" } as unknown as NodeJS.ProcessEnv), false);
    assert.equal(isSameOriginRequest("https://x.com", {} as unknown as NodeJS.ProcessEnv), false);
});
