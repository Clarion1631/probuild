/**
 * getFreshQBTokens must not swallow a refresh TIMEOUT.
 *
 * Codex gate: refreshQBToken throws QBTimeoutError, but the catch here returned
 * the STALE tokens instead. The caller then spent another full QBO deadline on
 * its next request, so an Intuit outage still ate the route's 60s ceiling —
 * the exact hang the per-request deadline exists to prevent.
 *
 * These exercise the REAL policy (refreshTokensOrFallBack is what
 * getFreshQBTokens calls, with these same defaults); only the network boundary
 * is faked, because a unit test has no database for the settings row.
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const STALE = { accessToken: "stale-access", refreshToken: "stale-refresh", realmId: "realm-1" };

test("a refresh TIMEOUT propagates instead of handing back stale tokens", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const { QBTimeoutError } = await import("../src/lib/quickbooks");

    let saved = false;
    const error = await refreshTokensOrFallBack(
        STALE,
        async () => {
            throw new QBTimeoutError("QBO token refresh timed out");
        },
        async () => {
            saved = true;
        },
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(error instanceof QBTimeoutError, `expected QBTimeoutError, got ${String(error)}`);
    assert.equal(saved, false, "a timed-out refresh must never persist anything");
});

test("an ORDINARY refresh failure still falls back to the old access token", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const tokens = await refreshTokensOrFallBack(
        STALE,
        async () => {
            throw new Error("500 from Intuit");
        },
        async () => {},
    );
    // Deliberate: the old access token may still be valid, and this is the
    // long-standing behaviour for non-timeout failures.
    assert.deepEqual(tokens, STALE);
});

test("a successful refresh persists the rotated token and returns it", async () => {
    const { refreshTokensOrFallBack } = await import("../src/lib/quickbooks-payments");
    const saves: Array<{ accessToken: string; refreshToken: string }> = [];
    const tokens = await refreshTokensOrFallBack(
        STALE,
        async () => ({ accessToken: "new-access", refreshToken: "new-refresh" }),
        async (settings) => {
            saves.push(settings as { accessToken: string; refreshToken: string });
        },
    );
    assert.deepEqual(tokens, { accessToken: "new-access", refreshToken: "new-refresh", realmId: "realm-1" });
    assert.deepEqual(saves, [{ accessToken: "new-access", refreshToken: "new-refresh" }]);
});
