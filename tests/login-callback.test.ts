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
 * and re-checks.
 *
 * Codex round 1 on the login-callback PR (login-callback-codex-r1.md) found
 * round 3's fix still had two gaps, both from doing too little work on the
 * decoded form:
 *   1. Decoding happened AFTER normalization, so an encoded separator could
 *      walk a ".." resolution as an opaque path segment and never reach the
 *      decode step at all: `/safe%2F..//evil.example` decodes to
 *      `/safe/..//evil.example`, whose *normalized* pathname is
 *      `//evil.example` -- but only the flat pattern ran on the decoded
 *      string, not a fresh normalization pass.
 *   2. The flat pattern alone also missed a real backslash revealed only by
 *      decoding, after normalization had already discarded it:
 *      `/%5C/../jobs` resolves to `/jobs` before the encoded backslash is
 *      ever inspected.
 * The fix: reject dangerous *encoded* sequences in the raw input before any
 * normalization happens, and run the FULL check (pattern + URL
 * normalization + re-check), not just the flat pattern, on both the
 * normalized value and its once-decoded form. Every case below is verified
 * against Node's own `URL` parser, not just reasoned about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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
    // Codex round 1, gap 1: the encoded slash is itself an opaque path
    // segment character at the raw-normalize stage (no literal "/" for the
    // URL parser to act on), so ".." next to it is never a real dot-segment
    // until AFTER decoding -- by which point the old code only ran the flat
    // pattern, not a fresh normalize, on the decoded string. Rejected now at
    // the raw stage, before normalization ever sees it.
    { name: "encoded slash hides a dot-segment escape (uppercase %2F)", raw: "/safe%2F..//evil.example" },
    { name: "encoded slash hides a dot-segment escape (lowercase %2f)", raw: "/safe%2f..//evil.example" },
    // Codex round 1, gap 2: normalizing "/%5C/../jobs" resolves the ".."
    // against the opaque "%5C" segment and discards it, producing "/jobs"
    // -- so decoding the normalized result loses the encoded backslash
    // before it can ever be inspected.
    { name: "encoded backslash consumed by a dot-segment before it can be inspected (uppercase)", raw: "/%5C/../jobs" },
    { name: "encoded backslash consumed by a dot-segment before it can be inspected (lowercase)", raw: "/%5c/../jobs" },
    // Double-encoded separators: "%252F" contains no raw "%2f" substring, so
    // it is inert through the raw check and the first normalize pass, and
    // only becomes the literal text "%2F" (still dangerous) after the
    // once-decode step -- caught only because the decoded form gets the
    // FULL check, not just the flat pattern.
    { name: "double-encoded double slash (%252F%252F)", raw: "/%252F%252Fevil.example" },
    { name: "double-encoded backslash (%255C)", raw: "/%255Cevil.example" },
    { name: "double-encoded dot-segment (%252E%252E)", raw: "/safe/%252E%252E//evil.example" },
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

/**
 * Codex round 1 also found the two enforcement points disagreed on absolute
 * same-origin URLs: the login page only ever validated a relative path, so
 * a legitimate `https://app.example/jobs/123` deep link fell back to "/",
 * while the NextAuth redirect callback accepted it. safeCallbackPath now
 * takes the caller's trusted origin as a second argument and applies the
 * exact same full check to the extracted path either way -- both callers
 * (see the structural test below) pass their own trusted origin through the
 * same function, so there is one policy, not two.
 */
const TRUSTED_ORIGIN = "https://app.example";

test("safeCallbackPath allows a same-origin absolute URL when the trusted origin matches", () => {
    assert.equal(safeCallbackPath("https://app.example/jobs/123", TRUSTED_ORIGIN), "/jobs/123");
    assert.equal(
        safeCallbackPath("https://app.example/jobs/123?x=1#y", TRUSTED_ORIGIN),
        "/jobs/123?x=1#y"
    );
    assert.equal(safeCallbackPath("https://app.example", TRUSTED_ORIGIN), "/", "bare origin, no path");
    assert.equal(safeCallbackPath("https://app.example/", TRUSTED_ORIGIN), "/");
    // A relative path still works when a trusted origin is also supplied.
    assert.equal(safeCallbackPath("/jobs/123", TRUSTED_ORIGIN), "/jobs/123");
});

test("safeCallbackPath rejects an absolute URL on a different origin even with a trusted origin set", () => {
    assert.equal(safeCallbackPath("https://evil.example/jobs/123", TRUSTED_ORIGIN), "/");
    // A lookalike origin (subdomain trick) is a different origin, not a match.
    assert.equal(safeCallbackPath("https://app.example.evil.example/x", TRUSTED_ORIGIN), "/");
    assert.equal(safeCallbackPath("http://app.example/x", TRUSTED_ORIGIN), "/", "scheme must match too");
});

test("safeCallbackPath still rejects every absolute URL when no trusted origin is supplied", () => {
    assert.equal(safeCallbackPath("https://app.example/jobs/123"), "/");
    assert.equal(safeCallbackPath("https://app.example/jobs/123", undefined), "/");
});

test("safeCallbackPath applies the full hostile-input check to an absolute URL's path too", () => {
    // Same dot-segment/encoding attacks as the relative-path table above,
    // just wrapped in a same-origin absolute URL -- the trusted-origin
    // branch must reduce to the same validated path, not a separate,
    // weaker check.
    assert.equal(safeCallbackPath("https://app.example/safe/..//evil.example", TRUSTED_ORIGIN), "/");
    assert.equal(safeCallbackPath("https://app.example/safe%2F..//evil.example", TRUSTED_ORIGIN), "/");
    assert.equal(safeCallbackPath("https://app.example/%5C/../jobs", TRUSTED_ORIGIN), "/");
});

test("the login page and the NextAuth redirect callback both gate through safeCallbackPath alone", () => {
    const authSrc = readFileSync(path.join(__dirname, "..", "src", "lib", "auth.ts"), "utf8");
    assert.match(
        authSrc,
        /return baseUrl \+ safeCallbackPath\(url, baseUrl\);/,
        "the redirect callback must call safeCallbackPath as its only gate, passing baseUrl as the trusted origin -- " +
            "not a second, hand-rolled origin check"
    );

    const loginPageSrc = readFileSync(path.join(__dirname, "..", "src", "app", "login", "page.tsx"), "utf8");
    assert.match(
        loginPageSrc,
        /safeCallbackPath\(\s*searchParams\.get\(['"]callbackUrl['"]\)/,
        "the login page must call safeCallbackPath as its only gate on callbackUrl"
    );
    assert.match(
        loginPageSrc,
        /window\.location\.origin/,
        "the login page must pass its own origin through so same-origin absolute callback URLs are accepted " +
            "the same way the redirect callback accepts them"
    );
});
