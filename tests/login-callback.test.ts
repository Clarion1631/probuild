/**
 * safeCallbackPath (src/lib/login-callback.ts): where a signed-out tap on a
 * staff link is sent back to after Google sign-in.
 *
 * The hostile-input table exists because checking only the raw input is not
 * enough. Codex round 3 (pick-job-ask-holder-codex-r3.md) found that
 * `/safe/..//evil.example` passes every raw check -- one leading "/", no
 * control character, no backslash -- and still resolves cleanly against the
 * dummy origin, but its ".." segment collapses to "//evil.example", a
 * protocol-relative reference. `%2E%2E` is treated the same as ".." by the
 * URL parser, so the encoded form collapses the same way. And a
 * percent-encoded separator (`/%2F%2Fevil.example`, `/%5Cevil.example`)
 * survives URL parsing completely unchanged, only becoming dangerous once
 * something downstream decodes it -- which is why the helper decodes once
 * and re-checks. Every case below is verified against Node's own `URL`
 * parser, not just reasoned about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeCallbackPath } from "../src/lib/login-callback";

const HOSTILE_INPUTS: Array<{ name: string; raw: string | null | undefined }> = [
    { name: "empty string", raw: "" },
    { name: "null", raw: null },
    { name: "undefined", raw: undefined },
    { name: "protocol-relative //", raw: "//evil.example" },
    { name: "protocol-relative /// (triple slash)", raw: "///evil.example" },
    { name: "absolute https URL", raw: "https://evil.example" },
    { name: "absolute http URL", raw: "http://evil.example" },
    { name: "javascript: scheme", raw: "javascript:alert(1)" },
    { name: "mailto: scheme", raw: "mailto:x@evil.example" },
    { name: "no leading slash at all", raw: "evil.example" },
    { name: "literal backslash right after the slash", raw: "/\\evil.example" },
    { name: "backslash with no leading slash", raw: "\\\\evil.example" },
    { name: "backslash in the middle", raw: "/a\\b" },
    { name: "real tab control character", raw: "/\t/evil.example" },
    { name: "real newline control character", raw: "/\n/evil.example" },
    { name: "real carriage-return control character", raw: "/\r/evil.example" },
    { name: "CRLF header-injection shape", raw: "/x\r\nSet-Cookie:evil" },
    { name: "NUL control character", raw: "/\u0000evil.example" },
    { name: "DEL control character", raw: "/\u007Fevil.example" },
    { name: "2,049-character path (over the limit)", raw: "/" + "a".repeat(2048) },
    // The exact Codex round 3 finding: normalizes to "//evil.example".
    { name: "dot-segment escape: /safe/..//evil.example", raw: "/safe/..//evil.example" },
    { name: "dot-segment escape, one more layer: /a/..//evil.example", raw: "/a/..//evil.example" },
    // %2E%2E is a double-dot path segment per the URL Standard, same as "..".
    { name: "encoded dot-segment escape (uppercase %2E%2E)", raw: "/safe/%2E%2E//evil.example" },
    { name: "encoded dot-segment escape (lowercase %2e%2e)", raw: "/safe/%2e%2e//evil.example" },
    // Encoded separators: unchanged by URL parsing, caught by the decode-and-recheck step.
    { name: "encoded double slash (uppercase %2F%2F)", raw: "/%2F%2Fevil.example" },
    { name: "encoded double slash (lowercase %2f%2f)", raw: "/%2f%2fevil.example" },
    { name: "encoded backslash", raw: "/%5Cevil.example" },
    { name: "encoded backslash (lowercase)", raw: "/%5cevil.example" },
    // Unicode lookalikes for "/" are not the ASCII separator the checks require.
    { name: "unicode division slash lookalike, no real leading /", raw: "∕evil.example" },
    { name: "unicode fullwidth solidus lookalike, no real leading /", raw: "／evil.example" },
    { name: "malformed percent-escape", raw: "/%" },
];

test(`safeCallbackPath rejects ${HOSTILE_INPUTS.length} hostile inputs`, () => {
    assert.ok(HOSTILE_INPUTS.length >= 25, "the table itself must carry at least 25 cases");
    for (const { name, raw } of HOSTILE_INPUTS) {
        assert.equal(safeCallbackPath(raw), "/", name);
    }
});

const SAFE_INPUTS: Array<{ name: string; raw: string }> = [
    { name: "a plain deep link", raw: "/automation/which-job/abc" },
    { name: "a deep link with a query string and a hash", raw: "/automation/which-job/abc?x=1#y" },
    { name: "a query string on its own path", raw: "/my-receipts?issue=abc" },
    { name: "root", raw: "/" },
    { name: "a mid-path double slash (not at the start, so not protocol-relative)", raw: "/a//evil.example" },
];

test("safeCallbackPath returns good same-origin paths unchanged", () => {
    for (const { name, raw } of SAFE_INPUTS) {
        assert.equal(safeCallbackPath(raw), raw, name);
    }
});
