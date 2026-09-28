/**
 * Front Desk v1 acceptance test 41: the 5 exact machine paths bypass the
 * proxy, and neither a sibling path nor Server Action dispatch through them
 * does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isPublicProxyBypass, isMachineOnlyBypass, ANONYMOUS_ACTION_PATTERN } from "../src/proxy";

const BYPASS_PATHS = [
    "/api/front-desk/post-call",
    "/api/front-desk/tools/availability",
    "/api/front-desk/tools/book",
    "/api/front-desk/tools/prepare-transfer",
    "/api/front-desk/bridge-twiml",
];

test("the 5 Front Desk machine routes bypass the proxy", () => {
    for (const p of BYPASS_PATHS) {
        assert.equal(isPublicProxyBypass(p), true, p);
        assert.equal(isPublicProxyBypass(`${p}/`), true, `${p}/`);
    }
});

test("a sibling path does not bypass", () => {
    assert.equal(isPublicProxyBypass("/api/front-desk/other"), false);
    assert.equal(isPublicProxyBypass("/api/front-desk/tools"), false);
    assert.equal(isPublicProxyBypass("/api/front-desk/tools/other"), false);
});

test("none of the 5 routes are in ANONYMOUS_ACTION_PATTERN — Server Action dispatch through them is refused", () => {
    for (const p of BYPASS_PATHS) {
        assert.equal(ANONYMOUS_ACTION_PATTERN.test(p), false, p);
        assert.equal(isMachineOnlyBypass(p), true, p);
    }
});
