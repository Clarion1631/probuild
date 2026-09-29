// Where a signed-out tap on a staff link lands after Google sign-in.
// next-auth's `withAuth` sends a signed-out request to
// `/login?callbackUrl=<relative path>` (see src/proxy.ts), and the login
// page passes that value straight to `signIn("google", { callbackUrl })`.
// This is the one place that decides whether that value is safe to send
// the browser to afterwards -- it must never resolve off this origin. The
// NextAuth redirect callback (src/lib/auth.ts) calls the same function, so
// there is exactly one policy for both entry points.
//
// Codex round 3 (pick-job-ask-holder-codex-r3.md) found that checking only
// the raw input is not enough: `/safe/..//evil.example` passes every raw
// check (starts with one "/", no control character, no backslash), and
// still parses cleanly against the dummy origin below -- but resolving its
// ".." segment collapses it to "//evil.example", a protocol-relative
// reference. The fix there was to re-check the *normalized* result with the
// same rule, and to decode it once and check that too, since a
// percent-encoded separator (e.g. "/%2F%2Fevil.example") survives URL
// parsing unchanged and only becomes "//evil.example" once something
// downstream decodes it.
//
// Codex round 1 on this PR (login-callback-codex-r1.md) found that round 3's
// fix still had two gaps, both from doing too little work on the decoded
// form:
//   1. Decoding only happened AFTER normalization, so an encoded separator
//      could walk a ".." resolution as an opaque path segment during
//      normalization and never survive to the decode step at all:
//      "/safe%2F..//evil.example" decodes to "/safe/..//evil.example",
//      whose *normalized* pathname is "//evil.example" -- but the decode
//      step only ran the flat pattern test on the decoded string, not a
//      fresh normalization pass, so this never got caught.
//   2. The flat pattern test alone also missed cases where decoding revealed
//      a real backslash that normalization had already discarded, e.g.
//      "/%5C/../jobs" resolves to "/jobs" before the encoded backslash is
//      ever inspected.
// The fix is threefold: reject dangerous *encoded* sequences in the raw
// input before any normalization happens at all (closing gap 1 at the
// source, since an encoded separator can never reach the normalizer to be
// misread as an opaque segment); and run the FULL check -- pattern test,
// URL normalization, and a re-check of the normalized result, not just the
// flat pattern -- on both the normalized value and its once-decoded form
// (closing gap 2, and acting as defense in depth for anything gap 1's
// pattern doesn't happen to name, e.g. a double-encoded separator like
// "%252F" that only becomes "%2F" after a single decode).
const UNSAFE_CALLBACK_PATTERN = /[\u0000-\u001F\u007F\\]/;

// Percent-encoded forms of the same dangerous bytes UNSAFE_CALLBACK_PATTERN
// already bans as literal characters (backslash, control characters) plus
// encoded path separators and dot-segment characters ("/", "." -- %2F, %5C,
// %2E, case-insensitive). These are the sequences that can walk a ".."
// resolution, or hide a separator, during URL normalization -- see the
// gap-1/gap-2 note above. Checked against the RAW input, before any
// normalization or decoding, so an encoded separator can never reach the
// normalizer disguised as an opaque path segment.
const ENCODED_DANGEROUS_PATTERN = /%(?:2f|5c|2e|[01][0-9a-f]|7f)/i;

function hasDangerousRawContent(value: string): boolean {
    return UNSAFE_CALLBACK_PATTERN.test(value) || ENCODED_DANGEROUS_PATTERN.test(value);
}

function isSafeRelativePath(value: string): boolean {
    if (value.length === 0 || value.length > 2048) return false;
    if (hasDangerousRawContent(value)) return false;
    if (!value.startsWith("/") || value.startsWith("//")) return false;
    return true;
}

// The full check: the flat pattern test, then URL normalization (which
// resolves ".." segments and would turn a protocol-relative escape into a
// literal "//" prefix), then the flat pattern test again on what came out.
// Used on both the raw/normalized value and its once-decoded form, so
// neither stage relies on the other to catch what only it can see.
function normalizeAndCheck(value: string): string | null {
    if (!isSafeRelativePath(value)) return null;

    let url: URL;
    try {
        url = new URL(value, "https://callback.invalid");
    } catch {
        return null;
    }
    if (url.origin !== "https://callback.invalid") return null;

    const normalized = url.pathname + url.search + url.hash;
    if (!isSafeRelativePath(normalized)) return null;

    return normalized;
}

/**
 * Validates a callback target and returns a same-origin relative path, or
 * "/" if the input isn't one.
 *
 * `raw` is normally a relative path (what the login page reads off its own
 * `callbackUrl` query param). Passing `trustedOrigin` also allows an
 * absolute URL through, but only when it resolves to exactly that origin --
 * callers must supply the origin they actually trust (e.g. NextAuth's
 * `baseUrl`, or the login page's own `window.location.origin`); there is no
 * implicit notion of "home origin" here. Without `trustedOrigin`, any
 * absolute URL is rejected, same as before.
 */
export function safeCallbackPath(raw: string | null | undefined, trustedOrigin?: string): string {
    if (typeof raw !== "string") return "/";

    // Checked on the untouched input first, before `new URL()` below ever
    // runs: the URL constructor resolves ".." segments as an intrinsic part
    // of parsing, not as a separate step we control, so by the time it
    // returns a `.pathname` an encoded separator that walked a dot-segment
    // resolution is already gone. This is the same evidence-loss gap
    // (login-callback-codex-r1.md) whether `raw` is a relative path or a
    // full absolute URL -- so it is checked here, once, before either branch
    // below gets a chance to normalize anything away.
    if (hasDangerousRawContent(raw)) return "/";

    let candidate = raw;
    if (!candidate.startsWith("/")) {
        if (!trustedOrigin) return "/";
        let parsed: URL;
        try {
            parsed = new URL(candidate);
        } catch {
            return "/";
        }
        if (parsed.origin !== trustedOrigin) return "/";
        candidate = parsed.pathname + parsed.search + parsed.hash;
    }

    const normalized = normalizeAndCheck(candidate);
    if (normalized === null) return "/";

    let decoded: string;
    try {
        decoded = decodeURIComponent(normalized);
    } catch {
        return "/";
    }
    if (normalizeAndCheck(decoded) === null) return "/";

    return normalized;
}
