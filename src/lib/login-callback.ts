// Where a signed-out tap on a staff link lands after Google sign-in.
// next-auth's `withAuth` sends a signed-out request to
// `/login?callbackUrl=<relative path>` (see src/proxy.ts), and the login
// page passes that value straight to `signIn("google", { callbackUrl })`.
// This is the one place that decides whether that value is safe to send
// the browser to afterwards -- it must never resolve off this origin.
//
// Codex round 3 (pick-job-ask-holder-codex-r3.md) found that checking only
// the raw input is not enough: `/safe/..//evil.example` passes every raw
// check (starts with one "/", no control character, no backslash), and
// still parses cleanly against the dummy origin below -- but resolving its
// ".." segment collapses it to "//evil.example", a protocol-relative
// reference. The fix is to re-check the *normalized* result with the same
// rule, and to decode it once and check that too, since a percent-encoded
// separator (e.g. "/%2F%2Fevil.example") survives URL parsing unchanged
// and only becomes "//evil.example" once something downstream decodes it.
const UNSAFE_CALLBACK_PATTERN = /[\u0000-\u001F\u007F\\]/;

function isSafeRelativePath(value: string): boolean {
    if (value.length === 0 || value.length > 2048) return false;
    if (UNSAFE_CALLBACK_PATTERN.test(value)) return false;
    if (!value.startsWith("/") || value.startsWith("//")) return false;
    return true;
}

export function safeCallbackPath(raw: string | null | undefined): string {
    if (typeof raw !== "string" || !isSafeRelativePath(raw)) return "/";

    let url: URL;
    try {
        url = new URL(raw, "https://callback.invalid");
    } catch {
        return "/";
    }
    if (url.origin !== "https://callback.invalid") return "/";

    const result = url.pathname + url.search + url.hash;
    if (!isSafeRelativePath(result)) return "/";

    let decoded: string;
    try {
        decoded = decodeURIComponent(result);
    } catch {
        return "/";
    }
    if (!isSafeRelativePath(decoded)) return "/";

    return result;
}
