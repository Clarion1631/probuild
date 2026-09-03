/**
 * The repair queues need something that actually runs them.
 *
 * Every sweep this branch added — pay links, pending deletions, parked document
 * syncs — lived behind the `sync-payment-options` action of a POST-only,
 * secret-gated route that NOTHING called on a schedule. `vercel.json` scheduled
 * it nowhere and Vercel cron issues GET, so the UI copy promising "the
 * maintenance sweep will finish this" described a job that only ran when a human
 * remembered to curl it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the maintenance cron is scheduled, on a slot that does not contend", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
        crons: Array<{ path: string; schedule: string }>;
    };
    const entry = vercel.crons.find((c) => c.path === "/api/cron/qbo-maintenance");
    assert.ok(entry, "the repair queues must have a scheduled runner");
    assert.equal(entry!.schedule, "45 * * * *", "hourly at :45");

    // :45 is the only free quarter-hour in the existing schedule, so the sweeps
    // never fight the payments cron for the same QuickBooks connection.
    const minutes = vercel.crons
        .filter((c) => c.path !== "/api/cron/qbo-maintenance")
        .map((c) => c.schedule.split(" ")[0]);
    assert.ok(!minutes.includes("45"), `:45 must stay uncontended, saw ${minutes.join(",")}`);
});

test("the cron route is a GET, fails closed, and does not reimplement the sweeps", () => {
    const src = readFileSync("src/app/api/cron/qbo-maintenance/route.ts", "utf8");

    // Vercel cron issues GET. A POST-only handler is why none of this ran.
    assert.match(src, /export async function GET\(/);
    assert.doesNotMatch(src, /export async function POST\(/);

    // The shared cron gate: constant-time bearer, no environment escape hatch.
    assert.match(src, /isCronAuthorized\(request\)/);
    assert.match(src, /status: 401/);

    // ONE implementation. Delegating to the existing handler is what stops the
    // scheduled path and the manual one drifting apart.
    assert.match(src, /import \{ POST as runMaintenance \}/);
    assert.match(src, /action: "sync-payment-options"/);
    assert.doesNotMatch(src, /sweepPendingDeletions|sweepPendingDocumentSyncs/,
        "the cron must delegate, never carry its own copy of the sweeps");

    // And it stamps the heartbeat pipeline-health reads — only on a clean run,
    // so a run that finished with work outstanding cannot look healthy.
    assert.match(src, /QBO_MAINTENANCE_SOURCE/);
    assert.match(src, /status: ok \? "ok" : "error"/);
});

test("an unauthorised cron request is refused before any work", async () => {
    const { GET } = await import("../src/app/api/cron/qbo-maintenance/route");
    const previous = process.env.CRON_SECRET;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.CRON_SECRET = "the-real-secret";
    // The dev escape hatch would let a missing header through; this asserts the
    // production path. `process.env` rejects defineProperty, so assign it.
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
        const cases: Array<Record<string, string>> = [{}, { authorization: "Bearer wrong" }, { authorization: "the-real-secret" }];
        for (const headers of cases) {
            const res = await GET(new Request("https://x/api/cron/qbo-maintenance", { headers }));
            assert.equal(res.status, 401, `refused: ${JSON.stringify(headers)}`);
            assert.equal((await res.json()).reason, "unauthorized");
        }
    } finally {
        if (previous === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previous;
        if (previousNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = previousNodeEnv;
    }
});

test("a valid secret with no ingest secret configured says so, rather than reporting a clean run", async () => {
    const { GET } = await import("../src/app/api/cron/qbo-maintenance/route");
    const prevCron = process.env.CRON_SECRET;
    const prevIngest = process.env.RECEIPT_INGEST_SECRET;
    process.env.CRON_SECRET = "the-real-secret";
    delete process.env.RECEIPT_INGEST_SECRET;
    try {
        const res = await GET(new Request("https://x/api/cron/qbo-maintenance", {
            headers: { authorization: "Bearer the-real-secret" },
        }));
        assert.equal(res.status, 503);
        assert.equal((await res.json()).reason, "receipt-ingest-secret-missing");
    } finally {
        if (prevCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevCron;
        if (prevIngest !== undefined) process.env.RECEIPT_INGEST_SECRET = prevIngest;
    }
});

// --- Round 48: the cron's status code tells the truth about the run ---

/**
 * The delegate answers 200 with `{ ok: false, reason: ... }` whenever repair
 * work failed or is still outstanding — that is its normal shape, not an
 * error. This route passed that 200 straight through, so Vercel recorded a
 * SUCCESSFUL cron invocation: the one signal an operator sees without opening
 * the logs said everything was fine while the queue was not moving.
 *
 * Source-level, because the branch is one expression and reaching it through
 * the real handler means standing up the whole maintenance POST. The behaviour
 * either side of it — the 401 and the missing-secret 503 — is covered above by
 * real requests.
 */
test("round 48: a run that is not ok:true is reported as 503, keeping its body", () => {
    const src = readFileSync("src/app/api/cron/qbo-maintenance/route.ts", "utf8");
    const returnAt = src.indexOf("return NextResponse.json(");
    assert.ok(returnAt > 0, "the route must return a JSON response");
    const tail = src.slice(returnAt);
    assert.match(
        tail,
        /status:\s*ok\s*\?\s*status\s*:\s*\(status\s*>=\s*400\s*\?\s*status\s*:\s*503\)/,
        "a not-ok run must not be able to return the delegate's 200",
    );
    // The body is passed through unchanged: only the status is corrected.
    assert.match(tail, /body \?\? \{ ok: false, reason: "no-response" \}/);
    // And `ok` is still computed from the delegate's own answer, not assumed.
    assert.match(src, /const ok = status === 200 && !!\(body as \{ ok\?: boolean \} \| null\)\?\.ok;/);
});
