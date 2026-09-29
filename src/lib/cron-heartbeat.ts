import { after } from "next/server";

/**
 * External heartbeat pings for money-touching cron jobs (Healthchecks.io-style
 * dead man's switch): `/start` when a run begins, a plain ping when it finishes
 * cleanly, `/fail` when it errors. Each job reads its own
 * `HC_PING_URL_<JOB_KEY>` — unset is a no-op, so this is opt-in per job and
 * costs nothing where it is not configured.
 *
 * `withCronHeartbeat` is the intended entry point — wrap a route handler at
 * its export:
 *
 *   export const GET = withCronHeartbeat("JOB_KEY", async function GET(request) {
 *       ...unchanged handler body...
 *   });
 *
 * Round 2 (Codex review of the first pass, which called `pingCronHeartbeat`
 * inline in each of the 9 route bodies): that shape awaited both pings on the
 * request path, which on the tightest handlers stacked with their own
 * internal budget close enough to `maxDuration` that a platform hard-kill
 * during the finish ping could skip a `finally` lease release, wedging the
 * next run behind the lease's TTL. The wrapper fixes this structurally: the
 * start ping is fired without awaiting (it runs concurrently with the
 * handler), and the finish ping runs via next/server's `after()` — AFTER the
 * response is sent, and so after the handler's own `finally`/lease-release —
 * which adds no latency at all on the request path. Every route's `finally`
 * now runs exactly where it always did.
 *
 * Round 3 (Codex review of round 2) fixed two more:
 *  - Round 2's single `isFailure(body)` was consulted for every response
 *    regardless of status, so returning `false` — the documented way to
 *    clear an intentional non-2xx skip — also cleared any UNRELATED non-2xx
 *    a route's predicate happened to say nothing about, including a bare
 *    401 `{ error: "Unauthorized" }` on every route that had a predicate at
 *    all. Split into `isFailure` (2xx-only, escalate-only) and `isSkip`
 *    (non-2xx-only, clear-only) below — structurally impossible to cross
 *    now, since each is never even called for the other status class.
 *  - The start ping was fired-and-forgotten (`void`-discarded), so its
 *    request could still be in flight when the terminal ping's request
 *    landed — out-of-order delivery at Healthchecks reads as a new run
 *    starting after the real one already finished, which then never closes.
 *    The finish task now awaits the kept start-ping promise (itself already
 *    bounded by PING_TIMEOUT_MS, failures already swallowed) before sending
 *    the terminal ping — ordered at the source, not by hoping the network
 *    preserves send order.
 */

const PING_TIMEOUT_MS = 3_000;

/** A short reason code, or the literal "status-<code>" shape — never free text. */
const SAFE_DETAIL = /^[a-z0-9_-]{1,40}$/i;

export type HeartbeatPhase = "start" | "success" | "fail";

/** A small guard `isFailure` predicates share to read a JSON body's fields safely. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pingUrl(jobKey: string, phase: HeartbeatPhase): string | undefined {
    const base = process.env[`HC_PING_URL_${jobKey}`];
    if (!base || !base.trim()) return undefined;
    const trimmed = base.trim();
    if (phase === "start") return `${trimmed}/start`;
    if (phase === "fail") return `${trimmed}/fail`;
    return trimmed;
}

/**
 * Anything that isn't a short code or "status-<code>" becomes "error". The
 * body this ships to an external URL, so a caller passing a raw error
 * message, a stack, or a request payload must never reach it verbatim.
 */
export function sanitizeDetail(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return SAFE_DETAIL.test(value) ? value : "error";
}

/**
 * Ping the heartbeat URL for `jobKey`. Never throws.
 *
 * Bounded to PING_TIMEOUT_MS for the WHOLE request, headers AND body: the
 * abort signal that guards `fetch()` also guards draining the response, so a
 * server that answers with headers and then stalls the body cannot hold this
 * open past the timeout either (round-2 finding 4 — the first pass's timeout
 * covered only the headers).
 */
export async function pingCronHeartbeat(
    jobKey: string,
    phase: HeartbeatPhase,
    detail?: string,
): Promise<void> {
    const url = pingUrl(jobKey, phase);
    if (!url) return;

    const body = phase === "fail" ? sanitizeDetail(detail) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
        const res = await fetch(url, { method: "POST", body, signal: controller.signal });
        // Drained under the SAME signal/timer as the request itself, so a
        // response that stalls its body (headers arrived, body never
        // finishes) is bounded too, not just the initial connect.
        await res.text().catch(() => undefined);
        if (!res.ok) {
            console.error("[cron-heartbeat] ping responded with an error status", { jobKey, phase, status: res.status });
        }
    } catch (error) {
        console.error("[cron-heartbeat] ping failed", {
            jobKey,
            phase,
            error: error instanceof Error ? error.name : "UnknownError",
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Run `task` after the response is sent (next/server's `after()`), so it can
 * never add latency or delay a handler's own `finally`. `after()` throws
 * synchronously outside a real request scope — a script, or (this is the
 * case that matters here) a route handler imported and called directly from
 * a `node:test` file, same as the existing guard in
 * src/lib/after-request.ts and src/lib/qbo-expense-sync.ts's post-sync
 * review-alert scheduling. The fallback there is a detached, uncaught
 * promise; this fallback AWAITS instead, because callers here (tests) need
 * the ping to have already happened by the time this function resolves.
 */
async function finishAfterResponse(task: () => Promise<void>): Promise<void> {
    try {
        after(task);
    } catch {
        await task();
    }
}

export interface WithCronHeartbeatOptions {
    /**
     * Consulted ONLY for a 2xx response (round-3 fix — see module doc).
     * Return `true` to flag a 2xx that carries its own error signal in the
     * body that the status code alone doesn't show (e.g. per-row errors on
     * an otherwise-200 summary). Anything else — `false`, `undefined`,
     * omitting the option, or the body failing to parse as JSON — leaves a
     * 2xx classified as a success. Never consulted for a non-2xx response,
     * so it can only ESCALATE, never clear one.
     */
    isFailure?: (body: unknown, status: number) => boolean | undefined;
    /**
     * Consulted ONLY for a non-2xx response (round-3 fix — see module doc).
     * Return `true` to clear it to a success, for an INTENTIONAL skip that
     * answers a non-2xx status by design (e.g. a disabled/paused sync
     * answering 503 — the status code stays exactly what the route already
     * returns; only this heartbeat's classification changes). Anything else
     * — `false`, `undefined`, omitting the option, or the body failing to
     * parse as JSON — leaves a non-2xx classified as a failure. Never
     * consulted for a 2xx response, so it can only CLEAR, never escalate.
     */
    isSkip?: (body: unknown, status: number) => boolean | undefined;
}

/**
 * Wrap a route handler with start/success/fail heartbeat pings. Never changes
 * the handler's response, its thrown-error behavior, or (see module doc) its
 * request-path latency.
 */
export function withCronHeartbeat(
    jobKey: string,
    handler: (request: Request) => Promise<Response>,
    opts: WithCronHeartbeatOptions = {},
): (request: Request) => Promise<Response> {
    return async function cronHeartbeatWrapped(request: Request): Promise<Response> {
        // Fired without awaiting the WORK — runs concurrently with the
        // handler. Kept (not `void`-discarded) so the finish task below can
        // await it: round-3 fix — an un-awaited /start could still be
        // in flight when the terminal ping lands, and Healthchecks reading
        // them out of order opens a new "run in progress" window that the
        // real run's own finish ping already closed, which never clears and
        // eventually false-alarms as stuck. pingCronHeartbeat never throws,
        // so there is nothing to catch here.
        const startPing = pingCronHeartbeat(jobKey, "start");

        let response: Response;
        try {
            response = await handler(request);
        } catch (error) {
            await finishAfterResponse(async () => {
                await startPing;
                await pingCronHeartbeat(jobKey, "fail", error instanceof Error ? error.name : undefined);
            });
            throw error;
        }

        // Cloned so the caller's own body is still readable — draining or
        // parsing the original here would consume it out from under them.
        const clone = response.clone();
        await finishAfterResponse(async () => {
            await startPing;

            let failed = !response.ok;
            let detail = failed ? `status-${response.status}` : undefined;
            try {
                const body = await clone.json();
                // isFailure/isSkip are mutually exclusive by construction
                // (round-3 fix): a predicate written to ESCALATE a 2xx must
                // never be given the chance to CLEAR an unrelated non-2xx —
                // that is exactly how round 2's single isFailure predicate
                // turned a misconfigured-CRON_SECRET 401 into a "success"
                // ping on every route that had one.
                if (response.ok) {
                    if (opts.isFailure?.(body, response.status) === true) {
                        failed = true;
                        detail = "predicate";
                    }
                } else if (opts.isSkip?.(body, response.status) === true) {
                    failed = false;
                    detail = undefined;
                }
            } catch {
                // Unparseable body decides nothing; the status-based
                // default above stands.
            }
            await pingCronHeartbeat(jobKey, failed ? "fail" : "success", detail);
        });
        return response;
    };
}
