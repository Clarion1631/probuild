/**
 * QuickBooks Online API client.
 * Uses OAuth2 tokens stored in integration-store.
 * Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting
 */
import {
    isE2eQboMockEnabled,
    recordMockReadInvoiceCall,
    getMockQboInvoice,
    mockSendQBPaymentCreate,
} from "./quickbooks-mock";
import { isEstimateSectionRow } from "./estimate-item-payload";

export const QB_API_BASE = process.env.QB_SANDBOX === "true"
    ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
    : "https://quickbooks.api.intuit.com/v3/company";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface QBTokens {
    accessToken: string;
    refreshToken: string;
    realmId: string;
}

/**
 * Raised when a QuickBooks HTTP call exceeded its own deadline — distinct from
 * any other network error so callers can treat it as "QBO is unreachable right
 * now, retry later" instead of a business failure.
 */
export class QBTimeoutError extends Error {
    name = "QBTimeoutError";
}

/**
 * The stranded-token error: we cannot tell whether Intuit rotated the refresh
 * token.
 *
 * Raised whenever a refresh ends ambiguously — a reset or TLS failure, a
 * truncated or malformed body, a 200 that omits the tokens, or a save that
 * did not stick. In every one of those the old refresh token may ALREADY be
 * spent on Intuit's side, so returning the stored pair reports a healthy
 * connection that cannot actually refresh again. There is no safe fallback:
 * surface it and let a human reconnect if the next refresh also fails.
 */
export class QBTokenStrandedError extends Error {
    name = "QBTokenStrandedError";
    constructor(detail: string) {
        super(`QuickBooks token refresh ended ambiguously (${detail}); reconnect QuickBooks if the next refresh fails`);
    }
}

export function isQBTokenStrandedError(error: unknown): boolean {
    return (
        error instanceof QBTokenStrandedError ||
        (error instanceof Error && error.name === "QBTokenStrandedError")
    );
}

/**
 * Identity check for a QB timeout that does NOT depend on `instanceof`.
 *
 * A bare `instanceof` compares class IDENTITY, so it silently returns false
 * whenever this module ends up loaded twice — different bundler chunks, a
 * CJS/ESM interop split (CI on Node 20 proved this one), a duplicated copy in
 * node_modules. The consequence is not cosmetic: every timeout branch in this
 * codebase would quietly take the non-timeout path, which is precisely the
 * misclassification the whole deadline effort exists to prevent. The name is
 * set as a class field on every instance, so match on that too.
 */
/**
 * A QBO failure that WILL plausibly succeed on a later attempt: 429, 5xx, a
 * thrown network error, or a dependent lookup that failed for those reasons.
 *
 * Distinct from a business rejection (a 4xx other than 429, or a QBO Fault),
 * which is terminal and must NOT be retried forever.
 */
export class QboRetryableError extends Error {
    name = "QboRetryableError";
    constructor(message: string, readonly status?: number) {
        super(message);
    }
}

/**
 * QuickBooks answered, but the body was not valid JSON.
 *
 * Kept distinct from a transport failure on purpose: garbage JSON is a
 * PROPERTY OF THE RESPONSE (it will look the same on every retry, and it says
 * nothing about the connection), whereas a socket dying mid-body means the
 * next call will fail too. Collapsing them made a single malformed payload
 * look like an outage and abort a whole run.
 */
/**
 * QuickBooks answered with a non-2xx status.
 *
 * The status is the whole point: `new Error("QB query failed: ...")` forced
 * every caller to guess, so a 404 (this thing does not exist — terminal) and a
 * 503 (come back later — retryable) were indistinguishable and got the same
 * treatment. Carry it.
 */
export class QboHttpError extends Error {
    name = "QboHttpError";
    constructor(message: string, readonly status: number, readonly body?: string) {
        super(message);
    }
}

/** Name-based, for the same cross-module-identity reason as isQBTimeoutError. */
export function qboHttpStatus(error: unknown): number | null {
    if (error instanceof QboHttpError) return error.status;
    if (error instanceof Error && error.name === "QboHttpError") {
        const status = (error as { status?: unknown }).status;
        return typeof status === "number" ? status : null;
    }
    return null;
}

export class QboMalformedResponseError extends Error {
    name = "QboMalformedResponseError";
}

export function isQboMalformedResponseError(error: unknown): boolean {
    return (
        error instanceof QboMalformedResponseError ||
        (error instanceof Error && error.name === "QboMalformedResponseError")
    );
}

/** Name-based, for the same cross-module-identity reason as isQBTimeoutError. */
export function isRetryableQboError(error: unknown): boolean {
    return (
        error instanceof QboRetryableError ||
        (error instanceof Error && error.name === "QboRetryableError")
    );
}

/** A QBO HTTP status we should come back to rather than give up on. */
export function isRetryableQboStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

/**
 * The statuses that mean "QuickBooks could not serve this right now" —
 * 408 (its edge timed out), 429 (rate limited), 5xx (broken).
 */
export function isTransientQboStatus(status: number): boolean {
    return status === 408 || isRetryableQboStatus(status);
}

/**
 * Turn a non-2xx QuickBooks response into the right error class, once, at the
 * boundary every caller shares.
 *
 * Each create path used to classify for itself, and none of them knew about
 * transient statuses: a 503 on a vendor, customer or purchase create came back
 * as a bare `Error`, which the receipt route read as an unknown failure (500)
 * instead of the retryable outage it plainly was. Same wall, three different
 * verdicts depending on which call hit it. Now they all get QboRetryableError
 * for 408/429/5xx and a typed QboHttpError (status preserved) for everything
 * else, so downstream classification is identical wherever it happens.
 */
export async function qboResponseError(res: Response, label: string): Promise<Error> {
    // Reading the ERROR body is itself a body read, and it can time out or die
    // on a reset socket. `.catch(() => "")` swallowed exactly that, turning an
    // outage into a tidy "failed (400): " — the status was preserved but the
    // real failure was not. Let those out; only a genuine parse/decode problem
    // degrades to an empty body.
    let body = "";
    try {
        body = await res.text();
    } catch (error) {
        if (isQBTimeoutError(error) || isRetryableQboError(error)) throw error;
    }
    return qboErrorFromStatus(res.status, body, label);
}

/**
 * The same classification as `qboResponseError`, for a caller that has ALREADY
 * consumed the response body.
 *
 * A `Response` body can only be read once, so the create paths that sniff the
 * text for a QBO Fault code (vendor duplicate 6240, purchase business rules)
 * cannot hand the response back to `qboResponseError` afterwards. Without this
 * they fell back to `new Error(...)`, which drops the status: a 401 on a vendor
 * or purchase create then reached the receipt route as an unknown failure (a
 * retried-forever 500) instead of the `qbo-auth` reconnect it is. Same rules,
 * same two classes, one definition.
 */
export function qboErrorFromStatus(status: number, body: string, label: string): Error {
    const detail = `${label} failed (${status}): ${body}`.slice(0, 500);
    if (isTransientQboStatus(status)) {
        return new QboRetryableError(detail, status);
    }
    return new QboHttpError(detail, status, body);
}

/**
 * A status that will repeat identically on the NEXT record.
 *
 * 429/5xx: QBO cannot serve requests. 401/403: the credential is bad, and it is
 * the same credential for every remaining row. 408: the request timed out at
 * QBO's edge, same as our own deadline firing. A caller looping over records
 * must stop on all of these — working through the rest produces identical
 * failures at full cost, which is how a handful of 20s waits consumed the
 * payments cron's entire 120s ceiling.
 */
export function isSharedQboFailureStatus(status: number): boolean {
    return status === 401 || status === 403 || status === 408 || isRetryableQboStatus(status);
}

/**
 * Did QBO fail in a way that means the NEXT call will fail the same way?
 *
 * A caller looping over many records must stop on this: each further attempt
 * burns its own full deadline against the same wall, which is how a handful of
 * 20s timeouts added up to the payments cron's entire 120s ceiling.
 */
/**
 * The HTTP status QuickBooks answered with, from EITHER typed error class.
 *
 * `qboHttpStatus` deliberately reads only `QboHttpError` — a retryable error is
 * not a plain HTTP error, and callers branch on that distinction. But
 * `QboRetryableError` DOES carry a status, and a caller that only wants to know
 * "was this 401/403?" has to see it: a row loop wraps a failed invoice probe as
 * `QboRetryableError(msg, 401)`, so classifying the abort off `qboHttpStatus`
 * alone reported a broken credential as an ordinary outage and the digest's
 * reconnect alert never fired.
 */
export function qboFailureStatus(error: unknown): number | null {
    const plain = qboHttpStatus(error);
    if (plain !== null) return plain;
    if (isRetryableQboError(error)) {
        const status = (error as { status?: unknown }).status;
        return typeof status === "number" ? status : null;
    }
    return null;
}

/**
 * Is this failure one that only a human RECONNECTING QuickBooks can fix?
 *
 * 401/403 is the credential, not an outage: every retry against the same token
 * fails identically, and waiting does not help. It must be reported under its
 * own reason so the digest can say "reconnect QuickBooks" instead of burying it
 * in the generic transient bucket.
 */
export function isQboReconnectRequired(error: unknown): boolean {
    const status = qboFailureStatus(error);
    return status === 401 || status === 403;
}

export function isQboConnectionFailure(error: unknown): boolean {
    if (isQBTimeoutError(error) || isRetryableQboError(error)) return true;
    // A 401/403 is the SAME credential failing, so every remaining record in a
    // sweep will fail identically at full cost. Only the transient statuses
    // were recognised here, so an expired token let a loop grind through
    // hundreds of rows proving the same thing.
    const status = qboHttpStatus(error);
    return status === 401 || status === 403;
}

export function isQBTimeoutError(error: unknown): error is QBTimeoutError {
    return (
        error instanceof QBTimeoutError ||
        (error instanceof Error && error.name === "QBTimeoutError")
    );
}

const QB_DEFAULT_TIMEOUT_MS = 20_000;

/** Path only — never the query string (it can carry the realm/query) or a token. */
function safePath(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return "(unparseable url)";
    }
}

/**
 * A whole-route time budget, so a sequence of individually-legal calls cannot
 * add up past the platform's ceiling.
 *
 * Per-call deadlines bound ONE call. A route that makes six of them serially
 * can still be killed mid-write with nothing recorded, which is how the
 * original outage burned a 60s function and reported nothing. Threading a
 * deadline through means every call gets min(its own timeout, what is left),
 * and work stops cleanly while there is still time to record the outcome.
 */
export interface RouteDeadline {
    startedAt: number;
    budgetMs: number;
}

/** Raised when the route's own budget is gone before a call could start. */
export class QBBudgetExhaustedError extends Error {
    name = "QBBudgetExhaustedError";
}

export function isQBBudgetExhaustedError(error: unknown): boolean {
    return (
        error instanceof QBBudgetExhaustedError ||
        (error instanceof Error && error.name === "QBBudgetExhaustedError")
    );
}

export function createRouteDeadline(budgetMs: number, startedAt: number = Date.now()): RouteDeadline {
    return { startedAt, budgetMs };
}

export function remainingBudgetMs(deadline: RouteDeadline | undefined, now: number = Date.now()): number {
    if (!deadline) return Number.POSITIVE_INFINITY;
    return deadline.startedAt + deadline.budgetMs - now;
}

/** True when there is not enough budget left to be worth starting another call. */
export function isBudgetExhausted(deadline: RouteDeadline | undefined, now: number = Date.now()): boolean {
    return remainingBudgetMs(deadline, now) <= QB_MIN_TIMEOUT_MS;
}

/** Below this a timeout is a self-inflicted outage; above it Vercel kills us first. */
const QB_MIN_TIMEOUT_MS = 1_000;
const QB_MAX_TIMEOUT_MS = 55_000;

/** Clamp a configured timeout into a range AbortSignal.timeout can actually take. */
function normalizeTimeoutMs(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    // AbortSignal.timeout takes an unsigned integer; a fraction or a
    // sub-millisecond value would either be coerced or reject outright.
    const whole = Math.floor(value);
    if (whole < 1) return fallback;
    // A large-but-finite value (QB_FETCH_TIMEOUT_MS=4294967296) exceeds the
    // unsigned-long-long bound and makes AbortSignal.timeout throw
    // SYNCHRONOUSLY — which would break every QuickBooks call in the app over a
    // single mistyped env var. Clamp instead: a too-long deadline is useless
    // anyway, since the route ceiling kills the function first.
    return Math.min(Math.max(whole, QB_MIN_TIMEOUT_MS), QB_MAX_TIMEOUT_MS);
}

interface SignalRace {
    /** The signal to hand to fetch. */
    signal: AbortSignal;
    /** Which input aborted FIRST, or null while none has. */
    winner: () => AbortSignal | null;
}

/**
 * Abort when ANY input signal aborts, and remember which one got there first.
 *
 * Two reasons this is hand-rolled rather than a bare `AbortSignal.any`:
 *
 *  - `AbortSignal.any` does not exist on every runtime we might land on. The
 *    original fallback used the CALLER's signal alone, which silently disabled
 *    the deadline — exactly the hang this module exists to prevent.
 *  - Attribution cannot be reconstructed after the fact. Inspecting
 *    `callerSignal.aborted` in the catch block loses a real race: the deadline
 *    fires, the caller aborts a moment later, and by the time the rejection is
 *    observed BOTH signals read aborted, so a genuine timeout was reported as a
 *    caller cancellation and the receipt route answered 500 instead of 503.
 *    The winner is therefore latched in the handler, at the instant it happens.
 *
 * Listeners are named and all of them are removed as soon as the race is
 * decided, so nothing stays attached to a caller signal that outlives the call.
 */
function raceAbortSignals(signals: AbortSignal[]): SignalRace {
    let winner: AbortSignal | null = null;
    const attached: Array<{ signal: AbortSignal; handler: () => void }> = [];

    const removeAllListeners = () => {
        for (const entry of attached) entry.signal.removeEventListener("abort", entry.handler);
        attached.length = 0;
    };

    const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    const controller = typeof anyOf === "function" ? null : new AbortController();

    const preAborted = signals.find(signal => signal.aborted);
    if (preAborted) {
        winner = preAborted;
        controller?.abort(preAborted.reason);
    } else {
        for (const signal of signals) {
            const handler = () => {
                if (!winner) winner = signal;
                removeAllListeners();
                controller?.abort(signal.reason);
            };
            attached.push({ signal, handler });
            signal.addEventListener("abort", handler, { once: true });
        }
    }

    const signal = controller
        ? controller.signal
        : signals.length === 1
            ? signals[0]
            : (anyOf as (s: AbortSignal[]) => AbortSignal)(signals);

    return { signal, winner: () => winner };
}

/**
 * Body-consuming members of Response — each one can outlive the headers.
 * `bytes()` is newer and absent on some runtimes; it is wrapped only when the
 * runtime actually provides it.
 */
const RESPONSE_BODY_METHODS = ["json", "text", "arrayBuffer", "blob", "formData", "bytes"] as const;

interface TimeoutContext {
    timeoutSignal: AbortSignal;
    race: SignalRace;
    url: string;
    ms: number;
}

/**
 * Translate an abort into QBTimeoutError, but ONLY when our own deadline is
 * what fired. A caller cancelling its own request is not a QBO outage.
 *
 * Attribution comes from the latched race winner, not from reading
 * `aborted` flags here — by the time this runs both signals may be aborted.
 */
function asQbTimeout(error: unknown, context: TimeoutContext): unknown {
    const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    if (aborted && context.race.winner() === context.timeoutSignal) {
        return new QBTimeoutError(
            `QuickBooks request timed out after ${context.ms}ms: ${safePath(context.url)}`,
        );
    }
    return error;
}

/**
 * Normalize every failure that crosses the QBO network boundary.
 *
 * Our own deadline becomes QBTimeoutError; a caller's abort stays exactly as it
 * was; anything else that `fetch` THREW is a transport failure (DNS, TLS,
 * connection reset — Node surfaces these as a bare `TypeError: fetch failed`)
 * and becomes QboRetryableError.
 *
 * That last case is why this exists: an un-normalized TypeError is neither a
 * timeout nor a retryable error, so a looping caller could not recognise it as
 * connection-level and kept dialling a QuickBooks that was clearly unreachable.
 * Classifying it HERE means every QBO call gets it, not just the ones someone
 * remembered to wrap.
 */
function asQboBoundaryError(error: unknown, context: TimeoutContext): unknown {
    const translated = asQbTimeout(error, context);
    if (isQBTimeoutError(translated)) return translated;
    // A caller cancelling its own request is not a QBO failure.
    if (context.race.winner() && context.race.winner() !== context.timeoutSignal) return translated;
    if (translated instanceof Error && translated.name === "AbortError") return translated;
    if (isRetryableQboError(translated)) return translated;
    // A SyntaxError from res.json() is QBO's PAYLOAD being wrong, not the
    // connection. Treating it as a transport failure made one malformed
    // response abort an entire run as though QuickBooks were down.
    if (translated instanceof Error && translated.name === "SyntaxError") {
        return new QboMalformedResponseError(
            `QuickBooks returned an unparseable body (${safePath(context.url)})`,
        );
    }
    // Everything else that threw mid-exchange — a reset socket, a terminated
    // stream — really is the connection, including when it happens AFTER
    // headers arrived, so it must abort a loop exactly like a timeout does.
    return new QboRetryableError(
        `QuickBooks request failed: ${translated instanceof Error ? translated.message : "network error"} (${safePath(context.url)})`,
    );
}

/**
 * The deadline governs the WHOLE exchange, not just the headers.
 *
 * `fetch` resolves as soon as response headers arrive; the body is streamed
 * afterwards, still under the same signal. A QBO outage that dribbles headers
 * and then stalls therefore blew past the wrapper entirely — `res.json()`
 * rejected with a raw AbortError, which the receipt route classified as a
 * generic transient failure (500) instead of the 503 qbo-timeout it is.
 *
 * So the signal stays attached (the deadline must still cut off a stalled
 * body), and the returned Response is proxied so every body-consuming method
 * translates our own abort the same way the header phase does.
 *
 * NOT translated: streamed reads via `res.body` / `getReader()` surface the
 * raw AbortError — no QBO caller currently streams a response.
 */
function wrapResponseBodyTimeouts(response: Response, context: TimeoutContext): Response {
    return new Proxy(response, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target);

            if (
                typeof prop === "string" &&
                (RESPONSE_BODY_METHODS as readonly string[]).includes(prop) &&
                typeof value === "function"
            ) {
                const original = value as (...args: unknown[]) => Promise<unknown>;
                return async (...args: unknown[]) => {
                    try {
                        return await original.apply(target, args);
                    } catch (error) {
                        // Same normalization as the header phase: a body that
                        // dies mid-stream is a transport failure, not a verdict.
                        throw asQboBoundaryError(error, context);
                    }
                };
            }

            // A clone is still a QBO response under the same deadline — wrap it
            // too, or reading the copy would leak the raw abort.
            if (prop === "clone" && typeof value === "function") {
                const clone = value as () => Response;
                return () => wrapResponseBodyTimeouts(clone.apply(target), context);
            }

            // Getters like `ok`/`status`/`headers` must run against the real
            // Response (they throw on a proxy receiver), and any other method
            // must stay bound to it.
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
    });
}

/** RequestInit plus the optional route budget this call must fit inside. */
export type QbRequestInit = RequestInit & { qbDeadline?: RouteDeadline };

/**
 * Every QuickBooks HTTP call goes through here.
 *
 * Bare `fetch()` has NO default timeout, so an Intuit outage (2026-09-01) left
 * each request hanging until Vercel killed the whole function at its
 * maxDuration — a receipt push burned 60s and a cron 120s to learn nothing.
 * A per-request deadline turns that into a fast, classifiable failure.
 *
 * A caller-supplied `signal` still wins on abort; only OUR deadline firing is
 * rethrown as QBTimeoutError, in both the header and the body phase. Every
 * other error passes through untouched.
 */
export async function qbTimedFetch(
    url: string,
    init: QbRequestInit = {},
    timeoutMs: number = Number(process.env.QB_FETCH_TIMEOUT_MS) || QB_DEFAULT_TIMEOUT_MS,
): Promise<Response> {
    // A misconfigured env var must not break every QB call: AbortSignal.timeout
    // wants a positive integer, so a fraction or a non-finite value falls back
    // to the default rather than reaching it.
    const perCallMs = normalizeTimeoutMs(timeoutMs, QB_DEFAULT_TIMEOUT_MS);

    // The route's remaining budget caps this call. Starting a 20s call with 3s
    // left just guarantees the platform kills us instead of us returning.
    const { qbDeadline, ...requestInit } = init;
    const remaining = remainingBudgetMs(qbDeadline);
    if (remaining <= QB_MIN_TIMEOUT_MS) {
        throw new QBBudgetExhaustedError(
            `QuickBooks call skipped: route budget exhausted (${safePath(url)})`,
        );
    }
    const effectiveMs = Number.isFinite(remaining) ? Math.min(perCallMs, Math.floor(remaining)) : perCallMs;
    init = requestInit;
    const timeoutSignal = AbortSignal.timeout(effectiveMs);

    const callerSignal = init.signal;
    const race = raceAbortSignals(callerSignal ? [callerSignal, timeoutSignal] : [timeoutSignal]);

    const context: TimeoutContext = { timeoutSignal, race, url, ms: effectiveMs };
    let response: Response;
    try {
        response = await fetch(url, { ...init, signal: race.signal });
    } catch (error) {
        throw asQboBoundaryError(error, context);
    }
    return wrapResponseBodyTimeouts(response, context);
}

/** Exchange authorization code for tokens */
export async function exchangeQBCode(code: string, redirectUri: string): Promise<QBTokens> {
    const clientId = process.env.QB_CLIENT_ID!;
    const clientSecret = process.env.QB_CLIENT_SECRET!;
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await qbTimedFetch(TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${encoded}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB token exchange failed: ${err}`);
    }

    const data = await res.json();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        realmId: "", // set from callback query param
    };
}

const QB_REFRESH_DEFAULT_TIMEOUT_MS = 45_000;
/** Must stay under the tightest route ceiling that can call this (maxDuration 60). */
const QB_REFRESH_MAX_TIMEOUT_MS = 50_000;

function refreshTimeoutMs(): number {
    const requested = normalizeTimeoutMs(
        Number(process.env.QB_REFRESH_TIMEOUT_MS),
        QB_REFRESH_DEFAULT_TIMEOUT_MS,
    );
    return Math.min(requested, QB_REFRESH_MAX_TIMEOUT_MS);
}

/**
 * Refresh an expired access token.
 *
 * This call is NOT safely retryable the way a read is: Intuit rotates the
 * refresh token as part of the exchange, so a request that timed out may
 * ALREADY have burned the stored refresh token on Intuit's side while we never
 * saw the replacement. That strands the connection until someone reconnects
 * QuickBooks. Two mitigations, both deliberate:
 *
 *  1. A longer deadline than an ordinary API call (QB_REFRESH_TIMEOUT_MS,
 *     default 45s, capped below the route ceiling) — we would much rather wait
 *     out a slow refresh than abandon one mid-rotation.
 *  2. A distinct, diagnosable error when it does fire, so the stranded-token
 *     case is recognisable in logs instead of looking like any other timeout.
 *
 * Both mitigations are BEST EFFORT, not a guarantee. The calling route's own
 * ceiling (maxDuration 60) can preempt a late refresh: if the function is
 * killed first, this deadline never fires, the message below is never logged,
 * and the connection can still be left stranded with no trace beyond the
 * platform timeout. Diagnosing that case means correlating a killed invocation
 * with the next refresh failure.
 *
 * Persistence order is unchanged: the caller still stores what this returns,
 * only after a successful exchange.
 */
export async function refreshQBToken(
    refreshToken: string,
    deadline?: RouteDeadline,
): Promise<{ accessToken: string; refreshToken: string }> {
    const clientId = process.env.QB_CLIENT_ID!;
    const clientSecret = process.env.QB_CLIENT_SECRET!;
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    try {
        const res = await qbTimedFetch(
            TOKEN_URL,
            {
                qbDeadline: deadline,
                method: "POST",
                headers: {
                    Authorization: `Basic ${encoded}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                }),
            },
            refreshTimeoutMs(),
        );

        // The status decides whether falling back to the stored pair is safe,
        // so it must survive: a bare Error made a 500 (Intuit may well have
        // rotated) indistinguishable from a 400 invalid_grant (it definitely
        // did not).
        if (!res.ok) throw await qboResponseError(res, "QB token refresh");
        const data = await res.json();
        return { accessToken: data.access_token, refreshToken: data.refresh_token };
    } catch (error) {
        if (isQBTimeoutError(error)) {
            const message =
                "QBO token refresh timed out; the stored refresh token may be stale, reconnect QuickBooks if the next refresh fails";
            console.error(message, error.message);
            // Still a QBTimeoutError so routes keep classifying it as an
            // outage (503/retry), just with the ambiguity spelled out.
            throw new QBTimeoutError(message);
        }
        throw error;
    }
}

/** Make an authenticated call to the QB API, auto-refreshing if needed */
export async function qbFetch(
    path: string,
    tokens: QBTokens,
    opts: QbRequestInit = {}
): Promise<Response> {
    // Callers that already put their own query string on `path` (e.g.
    // "/purchase?requestid=...") get "&minorversion=73" appended instead of a
    // second "?" — every existing call site passes a bare path, so this is
    // backward compatible.
    const separator = path.includes("?") ? "&" : "?";
    const url = `${QB_API_BASE}/${tokens.realmId}${path}${separator}minorversion=73`;
    return qbTimedFetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            ...opts.headers,
        },
    });
}

/** Run a QBO SQL-ish query (https://developer.intuit.com/.../data-queries) */
export async function qbQuery<T = any>(tokens: QBTokens, query: string, deadline?: RouteDeadline): Promise<T[]> {
    const url = `${QB_API_BASE}/${tokens.realmId}/query?query=${encodeURIComponent(query)}&minorversion=73`;
    const res = await qbTimedFetch(url, {
        qbDeadline: deadline,
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
        },
    });
    if (!res.ok) throw await qboResponseError(res, "QB query");
    const data = await res.json();
    const response = data.QueryResponse || {};
    const key = Object.keys(response).find(k => Array.isArray(response[k]));
    return key ? response[key] : [];
}

/**
 * Read a QBO JSON body, tolerating a malformed/empty one — WITHOUT swallowing
 * a timeout.
 *
 * `res.json().catch(() => null)` is the shape this replaces, and it was a trap:
 * the deadline can fire during the body read, so that catch turned a real
 * QBTimeoutError into "QBO returned no body" and the caller reported a generic
 * failure (500) instead of the retryable outage it was. Worse, on the
 * attachment path it could report a successful "attached" for an upload whose
 * response never arrived.
 *
 * Only genuine parse/decode errors resolve to null. A timeout is rethrown.
 */
export async function parseJsonOrNull<T = any>(res: Response): Promise<T | null> {
    try {
        return (await res.json()) as T;
    } catch (error) {
        // A timeout or a dead connection is not "QBO sent no body" — those must
        // reach the caller so a loop can stop. Only a genuine parse failure
        // (QboMalformedResponseError) degrades to null.
        if (isQBTimeoutError(error) || isRetryableQboError(error)) throw error;
        return null;
    }
}

export function escapeQBString(s: string): string {
    // Backslash MUST be escaped before the apostrophe escape, or an input
    // ending in a literal backslash (e.g. "Smith\\") would have its escaped
    // apostrophe's own backslash re-escaped, breaking out of the quoted string.
    return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export interface QBAttachable {
    Id?: string;
    FileName?: string;
    ContentType?: string;
    Size?: number;
    TempDownloadUri?: string;
    AttachableRef?: Array<{ EntityRef?: { value?: string; type?: string } }>;
}

/** List file attachments linked to a QBO Purchase (receipt images/PDFs). */
export async function getQBPurchaseAttachables(
    tokens: QBTokens,
    purchaseId: string,
    deadline?: RouteDeadline,
): Promise<QBAttachable[]> {
    // QBO transaction ids are numeric; refuse anything else rather than escape it.
    if (!/^\d+$/.test(purchaseId)) return [];
    const rows = await qbQuery<QBAttachable>(
        tokens,
        `SELECT * FROM attachable WHERE AttachableRef.EntityRef.value = '${purchaseId}'`,
        deadline,
    );
    // Entity ids are only unique per entity type, so the value-only query can
    // surface attachments from other transaction types — keep Purchase links.
    return rows.filter(row =>
        row.AttachableRef?.some(
            ref =>
                ref.EntityRef?.value === purchaseId &&
                /^purchase$/i.test(ref.EntityRef?.type ?? ""),
        ),
    );
}

/** Find a QBO customer by display name, creating it if missing. Returns the QBO customer Id. */
export async function ensureQBCustomer(
    tokens: QBTokens,
    client: { name: string; email?: string | null; qbCustomerId?: string | null },
    deadline?: RouteDeadline,
): Promise<string> {
    // Trust a previously stored id if it still exists
    if (client.qbCustomerId) {
        const existing = await qbQuery(tokens, `SELECT Id FROM Customer WHERE Id = '${escapeQBString(client.qbCustomerId)}'`, deadline);
        if (existing.length > 0) return client.qbCustomerId;
    }

    const name = client.name.trim();
    if (!name) throw new Error("Client name is empty — cannot sync customer to QuickBooks.");
    const byName = await qbQuery(tokens, `SELECT Id FROM Customer WHERE DisplayName = '${escapeQBString(name)}'`, deadline);
    if (byName.length > 0) return byName[0].Id;

    // QBO normalizes whitespace when enforcing DisplayName uniqueness, so an
    // exact match can miss while create still rejects as a duplicate (fault 6240).
    // Prefix on the first word only, so internal-whitespace variants still match.
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const prefix = name.split(/\s+/)[0];
    const candidates = await qbQuery<{ Id: string; DisplayName?: string }>(
        tokens,
        `SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '${escapeQBString(prefix)}%' MAXRESULTS 1000`,
        deadline,
    );
    const matches = candidates.filter(c => normalize(c.DisplayName ?? "") === normalize(name));
    if (matches.length > 1) {
        throw new Error(`QB customer lookup for "${name}" matched ${matches.length} customers — resolve the duplicate in QuickBooks.`);
    }
    if (matches.length === 1) return matches[0].Id;

    const res = await qbFetch("/customer", tokens, {
        qbDeadline: deadline,
        method: "POST",
        body: JSON.stringify({
            DisplayName: name,
            ...(client.email ? { PrimaryEmailAddr: { Address: client.email } } : {}),
        }),
    });
    if (!res.ok) throw await qboResponseError(res, "QB customer create");
    const data = await res.json();
    return data.Customer.Id;
}

const QB_SERVICE_ITEM_NAME = "Construction Services";

/** Find or create the Service item used for all ProBuild invoice lines. */
export async function ensureQBServiceItem(tokens: QBTokens, deadline?: RouteDeadline): Promise<string> {
    const items = await qbQuery(tokens, `SELECT Id FROM Item WHERE Name = '${escapeQBString(QB_SERVICE_ITEM_NAME)}'`, deadline);
    if (items.length > 0) return items[0].Id;

    // Need an income account to hang the item on — prefer an existing Income account.
    const accounts = await qbQuery(tokens, `SELECT Id, Name FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`, deadline);
    let incomeAccountId: string;
    if (accounts.length > 0) {
        incomeAccountId = accounts[0].Id;
    } else {
        const created = await qbFetch("/account", tokens, {
            qbDeadline: deadline,
            method: "POST",
            body: JSON.stringify({ Name: "Construction Income", AccountType: "Income", AccountSubType: "ServiceFeeIncome" }),
        });
        if (!created.ok) throw await qboResponseError(created, "QB income account create");
        incomeAccountId = (await created.json()).Account.Id;
    }

    const res = await qbFetch("/item", tokens, {
        qbDeadline: deadline,
        method: "POST",
        body: JSON.stringify({
            Name: QB_SERVICE_ITEM_NAME,
            Type: "Service",
            IncomeAccountRef: { value: incomeAccountId },
        }),
    });
    if (!res.ok) throw await qboResponseError(res, "QB service item create");
    return (await res.json()).Item.Id;
}

/**
 * Create a QBO invoice for ONE payment milestone, with QuickBooks Payments
 * (card + ACH) enabled so the customer gets Intuit's hosted "Review & Pay" page.
 */
export async function createQBMilestoneInvoice(
    tokens: QBTokens,
    input: {
        docNumber: string; // ≤ 21 chars
        customerId: string;
        itemId: string;
        description: string;
        amount: number; // grand total the client pays (tax-inclusive)
        // When set, the QBO invoice carries the sales tax explicitly:
        // a pre-tax taxable line + TxnTaxDetail, so QBO's sales-tax reporting
        // sees the liability and the invoice total still equals `amount`.
        tax?: { preTaxAmount: number; taxAmount: number } | null;
        dueDate?: Date | null;
        billEmail?: string | null;
        privateNote?: string;
    },
    deadline?: RouteDeadline,
): Promise<{ qbId: string; qbUrl: string; total: number }> {
    const withTax = !!input.tax && input.tax.taxAmount > 0;
    const lineAmount = withTax ? input.tax!.preTaxAmount : input.amount;

    const payload: Record<string, unknown> = {
        DocNumber: input.docNumber.slice(0, 21),
        TxnDate: new Date().toISOString().split("T")[0],
        CustomerRef: { value: input.customerId },
        // QuickBooks Payments is the ONLY payment rail (Stripe is disabled until
        // their 180-day hold clears) — the hosted page takes card, debit, AND bank.
        // Note: Intuit can't surcharge, so card fees are merchant-absorbed.
        AllowOnlineCreditCardPayment: true,
        AllowOnlineACHPayment: true,
        ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
        ...(input.dueDate ? { DueDate: input.dueDate.toISOString().split("T")[0] } : {}),
        ...(input.privateNote ? { PrivateNote: input.privateNote.slice(0, 4000) } : {}),
        Line: [
            {
                LineNum: 1,
                Description: input.description.slice(0, 4000),
                Amount: lineAmount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: input.itemId },
                    Qty: 1,
                    UnitPrice: lineAmount,
                    ...(withTax ? { TaxCodeRef: { value: "TAX" } } : {}),
                },
            },
        ],
        ...(withTax ? { TxnTaxDetail: { TotalTax: input.tax!.taxAmount } } : {}),
    };

    const res = await qbFetch("/invoice", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
        qbDeadline: deadline,
    });
    if (!res.ok) throw await qboResponseError(res, "QB milestone invoice create");
    const data = await parseJsonOrNull(res);
    const invoice = data?.Invoice;
    const qbId = invoice?.Id ? String(invoice.Id) : "";
    const total = Number(invoice?.TotalAmt);
    // A 200 with no usable invoice is NOT a success. Returning an empty id and
    // a NaN-coerced 0 let the caller link a milestone to nothing, or "verify" a
    // total against a fabricated zero. We cannot tell whether QBO created
    // something, so this is ambiguous and retryable — the requestid above makes
    // that retry safe.
    if (!qbId || !Number.isFinite(total)) {
        throw new QboRetryableError("QB milestone invoice create returned no usable Invoice");
    }
    return { qbId, qbUrl: `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}`, total };
}

/**
 * Fetch the customer-facing payment link for a QBO invoice (requires QB
 * Payments enabled).
 *
 * `null` means one thing only: QuickBooks answered with an Invoice, and that
 * Invoice has no payment link. Every FAILURE is typed and thrown — 401/403 as a
 * QboHttpError (the credential is bad; a human has to reconnect), 408/429/5xx
 * and our own deadline as retryable (come back later), and a body that is not
 * parseable JSON or carries no Invoice as retryable too: a truncated or
 * proxy-mangled response says nothing about whether a link exists, and the
 * paylink-pending sweep would clear the marker on it.
 *
 * It used to return null for all of those too, which quietly cost real money in
 * two ways. The create paths could not tell "no link exists" from "we never
 * asked", so a 503 left a linked row with no link and no marker and nothing
 * ever retried it. And the paylink-pending sweep would have read a 503 storm —
 * exactly the 2026-09-01 shape — as "none of these invoices has a link" and
 * cleared every pending marker in one pass.
 *
 * Callers that genuinely only want a link if one is going spare catch it
 * explicitly at the call site (search: `getQBInvoicePaymentLink(...).catch`).
 */
export async function getQBInvoicePaymentLink(tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline): Promise<string | null> {
    const url = `${QB_API_BASE}/${tokens.realmId}/invoice/${qbInvoiceId}?include=invoiceLink&minorversion=73`;
    const res = await qbTimedFetch(url, {
        qbDeadline: deadline,
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw await qboResponseError(res, "QB invoice payment link");
    const data = await parseJsonOrNull(res);
    // parseJsonOrNull returns null for a genuine parse failure (it rethrows a
    // timeout). Either that or a 200 with no Invoice in it is an answer we
    // cannot read — retryable, never "there is no link".
    if (!data || typeof data !== "object" || !data.Invoice || typeof data.Invoice !== "object") {
        throw new QboRetryableError("QB invoice payment link returned no usable Invoice");
    }
    const link = (data.Invoice as { InvoiceLink?: unknown }).InvoiceLink;
    return typeof link === "string" && link ? link : null;
}

/** One QuickBooks invoice as the ambiguous-create resolver needs to see it. */
export interface QBInvoiceMatch {
    id: string;
    docNumber: string | null;
    /** ProBuild writes its own marker here on create; this is what proves it is ours. */
    privateNote: string | null;
    total: number;
    balance: number;
}

/** The page size findQBInvoicesByDocNumber queries. Kept as a constant so the
 * truncation check below can never drift from the `maxresults` it is checking
 * for. */
const FIND_INVOICES_BY_DOC_NUMBER_LIMIT = 20;

/**
 * The query hit its page cap, so there may be MORE invoices under this
 * DocNumber than were returned. Distinct from "zero matches" or "one match" —
 * an automated resolver cannot tell whether the real invoice (or a second,
 * duplicate one) is sitting on a page it never saw, so it must refuse rather
 * than silently reasoning from a partial list.
 */
export class QBResultSetTruncatedError extends Error {
    name = "QBResultSetTruncatedError";
    constructor(docNumber: string, limit: number) {
        super(`QuickBooks returned ${limit} invoices for DocNumber "${docNumber}" — that is this query's page cap, so more may exist unseen.`);
    }
}

/** Name-based, for the same cross-module-identity reason as isQBTimeoutError. */
export function isQBResultSetTruncatedError(error: unknown): error is QBResultSetTruncatedError {
    return (
        error instanceof QBResultSetTruncatedError ||
        (error instanceof Error && error.name === "QBResultSetTruncatedError")
    );
}

/**
 * Every invoice QuickBooks holds under this DocNumber.
 *
 * Plural on purpose. DocNumber is not unique in QuickBooks (duplicate document
 * numbers can be allowed, and ours is truncated to 21 characters), so the
 * caller must decide what more than one means rather than being handed a
 * confident single answer. A query failure THROWS — "I could not ask" must
 * never read as "there is none". Hitting the page cap also throws
 * (QBResultSetTruncatedError) for the same reason: a result set that might be
 * incomplete must never be read as "these are all of them".
 */
export async function findQBInvoicesByDocNumber(
    tokens: QBTokens,
    docNumber: string,
    deadline?: RouteDeadline,
): Promise<QBInvoiceMatch[]> {
    const rows = await qbQuery<any>(
        tokens,
        `select * from Invoice where DocNumber = '${escapeQBString(docNumber)}' maxresults ${FIND_INVOICES_BY_DOC_NUMBER_LIMIT}`,
        deadline,
    );
    if (rows.length === FIND_INVOICES_BY_DOC_NUMBER_LIMIT) {
        throw new QBResultSetTruncatedError(docNumber, FIND_INVOICES_BY_DOC_NUMBER_LIMIT);
    }
    return rows
        .filter((inv) => inv?.Id)
        .map((inv) => ({
            id: String(inv.Id),
            docNumber: inv.DocNumber != null ? String(inv.DocNumber) : null,
            privateNote: inv.PrivateNote != null ? String(inv.PrivateNote) : null,
            total: Number(inv.TotalAmt ?? 0),
            balance: Number(inv.Balance ?? 0),
        }));
}

export interface QBInvoiceStatus {
    balance: number;
    total: number;
    paymentTxnIds: string[];
}

/**
 * Read a QBO invoice's balance + linked payment transactions.
 *
 * 404 is the only authoritative "gone" — everything else (a bad credential,
 * a rate limit, QBO itself down) says nothing about THIS invoice. Collapsing
 * every failure into null let a caller looping over many rows (e.g.
 * sendMilestoneInvoicesCore) read a shared connection/credential failure as
 * "this one row's total is unreadable" and keep spending a fresh deadline
 * rediscovering the same wall on every remaining row, instead of stopping
 * (see isSharedQboFailureStatus / isQboConnectionFailure).
 */
export async function getQBInvoiceStatus(tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline): Promise<QBInvoiceStatus | null> {
    const res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET", qbDeadline: deadline });
    if (!res.ok) {
        if (res.status === 404) return null;
        throw await qboResponseError(res, "QB invoice status");
    }
    const data = await res.json();
    const inv = data.Invoice;
    if (!inv) return null;
    const paymentTxnIds: string[] = (inv.LinkedTxn || [])
        .filter((t: any) => t.TxnType === "Payment")
        .map((t: any) => String(t.TxnId));
    return { balance: Number(inv.Balance ?? 0), total: Number(inv.TotalAmt ?? 0), paymentTxnIds };
}

/**
 * Result of probing a QBO invoice's existence + payable state.
 * Unlike getQBInvoiceStatus (which collapses every failure into null), this
 * distinguishes a permanently gone/voided invoice from a transient API error,
 * so the sync poller can flag stuck milestones without acting on a blip.
 */
export type QBInvoiceProbe =
    | { state: "ok"; balance: number; total: number; paymentTxnIds: string[] }
    | { state: "voided" } // HTTP 200, exists, total & balance === 0, no linked payments
    | { state: "notFound" } // HTTP 400 Fault 610 or HTTP 404 (authoritative "gone" only)
    // 401/429/5xx/network/malformed — transient, never act on.
    // `connectionFailed` marks the subset where we never got a usable answer
    // from QBO at all (our deadline fired, or the request threw). A caller
    // looping over many rows must STOP on that: the next row will fail the
    // same way and burn another full deadline, which is how six timeouts still
    // added up to the payments cron's 120s ceiling.
    | { state: "error"; status: number; connectionFailed?: boolean; timedOut?: boolean };

/**
 * Probe a QBO invoice and classify it. QBO's behavior for gone invoices is
 * inconsistent: a *voided* invoice returns 200 with TotalAmt=0; a *deleted* one
 * may return 400 + Fault code 610 ("Object Not Found"), a 404, or even 200 with
 * stale data. This folds all of those into a single discriminated result.
 */
export async function probeQBInvoice(
    tokens: QBTokens,
    qbInvoiceId: string,
    deadline?: RouteDeadline,
): Promise<QBInvoiceProbe> {
    let res: Response;
    try {
        res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET", qbDeadline: deadline });
    } catch (error) {
        // A timeout or a thrown network error means QBO never answered — the
        // connection itself is the problem, not this invoice.
        return { state: "error", status: 0, connectionFailed: true, timedOut: isQBTimeoutError(error) };
    }
    if (res.ok) {
        // A 200 should always carry an Invoice. A parse failure or a missing payload
        // is anomalous — treat it as transient (never as "gone"); only an explicit
        // 404/610 below is authoritative for notFound.
        let data: any;
        try {
            data = await res.json();
        } catch (error) {
            // The body can stall past the deadline, or the socket can die,
            // AFTER headers arrived — both are connection-level. A merely
            // unparseable payload is not.
            if (isQBTimeoutError(error)) {
                return { state: "error", status: res.status, connectionFailed: true, timedOut: true };
            }
            if (isRetryableQboError(error)) {
                return { state: "error", status: res.status, connectionFailed: true };
            }
            return { state: "error", status: res.status };
        }
        const inv = data?.Invoice;
        if (!inv) return { state: "error", status: res.status };
        const total = Number(inv.TotalAmt);
        const balance = Number(inv.Balance);
        // A well-formed invoice always carries numeric TotalAmt/Balance. Missing or
        // non-finite values mean a malformed/partial payload — treat as transient,
        // never as voided (which would false-alarm an otherwise-healthy milestone).
        if (!Number.isFinite(total) || !Number.isFinite(balance)) return { state: "error", status: res.status };
        const paymentTxnIds: string[] = (inv.LinkedTxn || [])
            .filter((t: any) => t.TxnType === "Payment")
            .map((t: any) => String(t.TxnId));
        // Voided invoices come back 200 with TotalAmt=0, Balance=0, and no linked payments.
        if (total === 0 && balance === 0 && paymentTxnIds.length === 0) return { state: "voided" };
        return { state: "ok", balance, total, paymentTxnIds };
    }
    if (res.status === 404) return { state: "notFound" };
    let body = "";
    try {
        body = await res.text();
    } catch (error) {
        if (isQBTimeoutError(error)) {
            return { state: "error", status: res.status, connectionFailed: true, timedOut: true };
        }
        if (isRetryableQboError(error)) {
            return { state: "error", status: res.status, connectionFailed: true };
        }
    }
    if (res.status === 400 && /"code"\s*:\s*"610"|Object Not Found/i.test(body)) {
        return { state: "notFound" };
    }
    if (isSharedQboFailureStatus(res.status)) {
        return { state: "error", status: res.status, connectionFailed: true };
    }
    return { state: "error", status: res.status };
}

/** Read a QBO payment (date / amount / reference) for receipt details. */
export async function getQBPayment(
    tokens: QBTokens,
    paymentId: string,
    deadline?: RouteDeadline,
): Promise<{ txnDate: string | null; amount: number; referenceNumber: string | null } | null> {
    const res = await qbFetch(`/payment/${paymentId}`, tokens, { method: "GET", qbDeadline: deadline });
    if (!res.ok) {
        // Not "this payment does not exist" — QBO is refusing, or the shared
        // credential is bad. Raise so a looping caller aborts instead of
        // burning a deadline per row (and never settles off a missing read).
        if (isSharedQboFailureStatus(res.status)) {
            throw new QboRetryableError(`QB payment read failed with status ${res.status}`, res.status);
        }
        return null;
    }
    const data = await parseJsonOrNull(res);
    const p = data?.Payment;
    if (!p) return null;
    return {
        txnDate: p.TxnDate || null,
        amount: Number(p.TotalAmt ?? 0),
        referenceNumber: p.PaymentRefNum || null,
    };
}

/** Read core invoice fields needed for payments/deletes. */
export async function readQBInvoice(tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline) {
    const res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET", qbDeadline: deadline });
    // 404 stays null ("gone"); a transient status must not read the same way.
    if (res.status === 404) return null;
    if (!res.ok) throw await qboResponseError(res, `QB invoice ${qbInvoiceId} read`);
    const inv = (await res.json()).Invoice;
    if (!inv) return null;
    return {
        syncToken: String(inv.SyncToken),
        customerId: String(inv.CustomerRef?.value ?? ""),
        balance: Number(inv.Balance ?? 0),
        total: Number(inv.TotalAmt ?? 0),
        docNumber: inv.DocNumber ?? null,
    };
}

/** Receive a payment against an invoice (full open balance). TEST/admin tooling. */
export async function createQBPaymentForInvoice(tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline): Promise<{ paymentId: string; amount: number } | null> {
    const inv = await readQBInvoice(tokens, qbInvoiceId, deadline);
    if (!inv || inv.balance <= 0 || !inv.customerId) return null;
    const res = await qbFetch("/payment", tokens, {
        qbDeadline: deadline,
        method: "POST",
        body: JSON.stringify({
            TotalAmt: inv.balance,
            CustomerRef: { value: inv.customerId },
            Line: [{ Amount: inv.balance, LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: "Invoice" }] }],
        }),
    });
    if (!res.ok) throw new Error(`QB payment create failed: ${await res.text()}`);
    const p = (await res.json()).Payment;
    return { paymentId: String(p.Id), amount: Number(p.TotalAmt ?? inv.balance) };
}

export type QBPaymentBuildFailure =
    | { ok: false; reason: "invoice-not-found" }
    | { ok: false; reason: "missing-customer" }
    | { ok: false; reason: "balance-mismatch"; qbBalance: number; expected: number };

/**
 * Build (but do not send) the exact JSON body for a Payment create against a
 * specific amount/date/check-ref — split out from the deposit-ingest send
 * step so a caller can PERSIST the body before the network call fires (the
 * deposit-ingest endpoint's `qbo_unknown` recovery depends on the row already
 * holding the exact bytes it's about to send, in case the process dies
 * mid-request or the response is lost). Guards the QBO invoice's open balance
 * against `opts.amount` to the cent — a deposit must exactly retire the
 * milestone it matched, never partially settle it.
 */
export async function buildQBPaymentRequest(
    tokens: QBTokens,
    qbInvoiceId: string,
    opts: { amount: number; txnDate: string; paymentRefNum: string },
    deadline?: RouteDeadline,
): Promise<{ ok: true; requestBody: string } | QBPaymentBuildFailure> {
    // E2E_QBO_MOCK (deposit-ingest hermeticity, gated in quickbooks-mock.ts):
    // skip the real readQBInvoice() network call entirely — the caller seeds
    // this mock's invoice state via /api/payments/test-only/qbo-mock.
    if (isE2eQboMockEnabled()) {
        recordMockReadInvoiceCall(qbInvoiceId);
        const inv = getMockQboInvoice(qbInvoiceId);
        if (!inv) return { ok: false, reason: "invoice-not-found" };
        if (!inv.customerId) return { ok: false, reason: "missing-customer" };
        if (Math.round(inv.balance * 100) !== Math.round(opts.amount * 100)) {
            return { ok: false, reason: "balance-mismatch", qbBalance: inv.balance, expected: opts.amount };
        }
        const mockPayload = {
            TotalAmt: opts.amount,
            TxnDate: opts.txnDate,
            PaymentRefNum: opts.paymentRefNum,
            CustomerRef: { value: inv.customerId },
            Line: [{ Amount: opts.amount, LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: "Invoice" }] }],
        };
        return { ok: true, requestBody: JSON.stringify(mockPayload) };
    }
    const inv = await readQBInvoice(tokens, qbInvoiceId, deadline);
    if (!inv) return { ok: false, reason: "invoice-not-found" };
    if (!inv.customerId) return { ok: false, reason: "missing-customer" };
    if (Math.round(inv.balance * 100) !== Math.round(opts.amount * 100)) {
        return { ok: false, reason: "balance-mismatch", qbBalance: inv.balance, expected: opts.amount };
    }
    const payload = {
        TotalAmt: opts.amount,
        TxnDate: opts.txnDate,
        PaymentRefNum: opts.paymentRefNum,
        CustomerRef: { value: inv.customerId },
        Line: [{ Amount: opts.amount, LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: "Invoice" }] }],
    };
    return { ok: true, requestBody: JSON.stringify(payload) };
}

/**
 * Send a Payment create request whose body was already built (by
 * `buildQBPaymentRequest`) and possibly already persisted. The SAME function
 * is the replay path: calling it again with the identical `requestBody` +
 * `requestId` after a lost response returns Intuit's ORIGINAL response
 * instead of creating a duplicate Payment (`requestid` is QBO's server-side
 * idempotency key on the create) — see qbo-receipt-push.ts's requestid
 * pattern, `?requestid=...` as a query param.
 */
export async function sendQBPaymentCreateRequest(
    tokens: QBTokens,
    requestBody: string,
    requestId: string,
    deadline?: RouteDeadline,
): Promise<{ paymentId: string; amount: number }> {
    // E2E_QBO_MOCK: no network I/O — see quickbooks-mock.ts's doc comment.
    // mockSendQBPaymentCreate replicates QBO's requestid dedupe (the SAME
    // requestId always returns the SAME payment), which the qbo_unknown
    // replay path below depends on.
    if (isE2eQboMockEnabled()) {
        return mockSendQBPaymentCreate(requestBody, requestId);
    }
    const res = await qbFetch(`/payment?requestid=${encodeURIComponent(requestId)}`, tokens, {
        method: "POST",
        body: requestBody,
        qbDeadline: deadline,
    });
    if (!res.ok) throw await qboResponseError(res, "QB payment create");
    const data = await parseJsonOrNull(res);
    const p = data?.Payment;
    if (!p?.Id) throw new Error("QB payment create returned no Payment body");
    return { paymentId: String(p.Id), amount: Number(p.TotalAmt ?? 0) };
}

/**
 * Convenience wrapper for callers that don't need the persist-before-send
 * seam: build + guard + send in one call. The deposit-ingest endpoint does
 * NOT use this directly — it calls `buildQBPaymentRequest` and
 * `sendQBPaymentCreateRequest` separately so it can commit the request body
 * to the DepositIngest row between the two steps.
 */
export async function createQBPaymentForInvoiceWithDetails(
    tokens: QBTokens,
    qbInvoiceId: string,
    opts: { amount: number; txnDate: string; paymentRefNum: string; requestId: string },
): Promise<{ ok: true; paymentId: string; amount: number; requestBody: string } | QBPaymentBuildFailure> {
    const built = await buildQBPaymentRequest(tokens, qbInvoiceId, opts);
    if (!built.ok) return built;
    const sent = await sendQBPaymentCreateRequest(tokens, built.requestBody, opts.requestId);
    return { ok: true, paymentId: sent.paymentId, amount: sent.amount, requestBody: built.requestBody };
}

/**
 * Hard-delete a payment (test cleanup, and the rebalance loop's invoice
 * replacement in billing-core.ts).
 *
 * 404 is authoritative — the payment is already gone — and stays `false`, same
 * as `readQBInvoice`'s rule. Every OTHER failure (401/403/429/5xx) is the
 * SAME wall the next call in a loop would hit identically; collapsing it into
 * `false` read as an ordinary per-row "couldn't delete" refusal, so a caller
 * looping over rows (see isSharedQboWall) never saw the outage and kept
 * spending its deadline proving the same wall on every remaining row. Thrown
 * instead, via the shared classifier, so it propagates like any other QBO
 * failure.
 */
export async function deleteQBPayment(tokens: QBTokens, paymentId: string, deadline?: RouteDeadline): Promise<boolean> {
    const get = await qbFetch(`/payment/${paymentId}`, tokens, { method: "GET", qbDeadline: deadline });
    if (get.status === 404) return false;
    if (!get.ok) throw await qboResponseError(get, `QB payment ${paymentId} read`);
    const syncToken = String((await get.json()).Payment?.SyncToken ?? "0");
    const res = await qbTimedFetch(
        `${QB_API_BASE}/${tokens.realmId}/payment?operation=delete&minorversion=73`,
        {
            qbDeadline: deadline,
            method: "POST",
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ Id: paymentId, SyncToken: syncToken }),
        }
    );
    if (res.status === 404) return false;
    if (!res.ok) throw await qboResponseError(res, `QB payment ${paymentId} delete`);
    return true;
}

/**
 * Hard-delete an invoice (test cleanup, and the rebalance loop's invoice
 * replacement in billing-core.ts). Fails in QBO if payments are still linked.
 *
 * Same authoritative-vs-shared split as `deleteQBPayment`: `readQBInvoice`
 * already throws for a non-404 read failure, so only the delete POST needed
 * the same treatment here. See its doc comment for why a shared failure must
 * be thrown rather than collapsed into `false`.
 */
export async function deleteQBInvoice(tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline): Promise<boolean> {
    const inv = await readQBInvoice(tokens, qbInvoiceId, deadline);
    if (!inv) return false;
    const res = await qbTimedFetch(
        `${QB_API_BASE}/${tokens.realmId}/invoice?operation=delete&minorversion=73`,
        {
            qbDeadline: deadline,
            method: "POST",
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ Id: qbInvoiceId, SyncToken: inv.syncToken }),
        }
    );
    if (res.status === 404) return false;
    if (!res.ok) throw await qboResponseError(res, `QB invoice ${qbInvoiceId} delete`);
    return true;
}

/** Read an invoice's online-payment toggles + sync token (for sparse updates). */
export async function getQBInvoicePaymentOptions(tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline) {
    const res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET", qbDeadline: deadline });
    // 404 is a real answer — this invoice is gone from QBO — and stays null.
    // Everything else used to collapse into that same null, so a 503 read as
    // "not in QuickBooks" and the sweep cheerfully carried on through an
    // outage. Preserve the status so callers can tell the two apart.
    if (res.status === 404) return null;
    if (!res.ok) throw await qboResponseError(res, `QB invoice ${qbInvoiceId} read`);
    const inv = (await res.json()).Invoice;
    if (!inv) return null;
    return {
        syncToken: String(inv.SyncToken),
        card: inv.AllowOnlineCreditCardPayment === true,
        ach: inv.AllowOnlineACHPayment === true,
        balance: Number(inv.Balance ?? 0),
    };
}

/** Sparse-update an invoice's online-payment toggles (card / bank transfer). */
export async function setQBInvoicePaymentOptions(
    tokens: QBTokens,
    qbInvoiceId: string,
    syncToken: string,
    opts: { card: boolean; ach: boolean },
    deadline?: RouteDeadline,
): Promise<boolean> {
    const res = await qbFetch("/invoice", tokens, {
        qbDeadline: deadline,
        method: "POST",
        body: JSON.stringify({
            Id: qbInvoiceId,
            SyncToken: syncToken,
            sparse: true,
            AllowOnlineCreditCardPayment: opts.card,
            AllowOnlineACHPayment: opts.ach,
        }),
    });
    // `return res.ok` flattened a 503 into the same "update-failed" as a
    // business rejection, so a shared outage looked like 200 individually
    // unlucky invoices. Raise with the status instead.
    if (!res.ok) throw await qboResponseError(res, `QB invoice ${qbInvoiceId} payment-options update`);
    return true;
}

/** Add customer-facing text before QBO sends its invoice email. */
export async function appendQBInvoiceCustomerMemo(
    tokens: QBTokens,
    qbInvoiceId: string,
    line: string,
    deadline?: RouteDeadline,
): Promise<{ ok: true } | { ok: false; error: string }> {
    // Two serial calls (read then sparse update) under one budget.
    const read = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET", qbDeadline: deadline });
    if (!read.ok) return { ok: false, error: `Could not read QuickBooks invoice (${read.status})` };
    const invoice = (await parseJsonOrNull(read))?.Invoice;
    if (!invoice?.SyncToken) return { ok: false, error: "QuickBooks invoice response was incomplete" };

    const current = String(invoice.CustomerMemo?.value ?? "").trim();
    if (current.includes(line)) return { ok: true };
    const update = await qbFetch("/invoice", tokens, {
        qbDeadline: deadline,
        method: "POST",
        body: JSON.stringify({
            Id: qbInvoiceId,
            SyncToken: String(invoice.SyncToken),
            sparse: true,
            CustomerMemo: { value: [current, line].filter(Boolean).join("\n\n").slice(0, 1000) },
        }),
    });
    if (!update.ok) return { ok: false, error: `Could not add the backup link to the QuickBooks invoice (${update.status})` };
    return { ok: true };
}

/** Posted money-out transactions (expenses/checks/card charges) from the books. */
export async function getRecentQBPurchases(tokens: QBTokens, sinceDaysAgo: number, deadline?: RouteDeadline) {
    const since = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString().split("T")[0];
    const rows = await getQBPurchasesSince(tokens, new Date(`${since}T00:00:00.000Z`), undefined, deadline);
    return rows.map(p => ({
        qbId: String(p.Id),
        date: p.TxnDate ?? null,
        amount: Number(p.TotalAmt ?? 0),
        paymentType: p.PaymentType ?? null, // Cash | Check | CreditCard
        docNumber: p.DocNumber ?? null,
        vendor: p.EntityRef?.name ?? null,
        account: p.AccountRef?.name ?? null,
        memo: p.PrivateNote ?? null,
    }));
}

/**
 * Read all posted QBO Purchase rows on or after a transaction date.
 * Pagination matters for the initial historical backfill; a single QBO query
 * page would silently stop after its MAXRESULTS boundary.
 */
export async function getQBPurchasesSince(
    tokens: QBTokens,
    since: Date,
    until?: Date,
    deadline?: RouteDeadline,
): Promise<any[]> {
    if (!Number.isFinite(since.getTime())) {
        throw new Error("QBO purchase query requires a valid since date");
    }
    if (until && !Number.isFinite(until.getTime())) {
        throw new Error("QBO purchase query requires a valid until date");
    }

    const sinceDate = since.toISOString().slice(0, 10);
    // Inclusive upper bound so callers can chunk a long backfill into
    // date windows that each finish within the serverless duration limit.
    const untilClause = until ? ` AND TxnDate <= '${until.toISOString().slice(0, 10)}'` : "";
    const pageSize = 1000;
    const purchases: any[] = [];

    for (let startPosition = 1; ; startPosition += pageSize) {
        const page = await qbQuery<any>(
            tokens,
            `SELECT * FROM Purchase WHERE TxnDate >= '${sinceDate}'${untilClause} ORDERBY TxnDate ASC STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`,
            deadline,
        );
        purchases.push(...page);
        if (page.length < pageSize) break;
    }

    return purchases;
}

/**
 * Read Purchase rows changed since a timestamp using QBO Change Data Capture.
 * Unlike a TxnDate query, CDC catches newly entered backdated purchases,
 * corrections, voids, refunds, and deletion tombstones. QBO caps CDC lookback
 * at 30 days and returns at most 1,000 entities, so truncated responses fail
 * visibly instead of silently leaving local job costs stale.
 */
export async function getQBPurchaseChangesSince(
    tokens: QBTokens,
    since: Date,
    deadline?: RouteDeadline,
): Promise<any[]> {
    if (!Number.isFinite(since.getTime())) {
        throw new Error("QBO Purchase CDC requires a valid since date");
    }

    const params = new URLSearchParams({
        entities: "Purchase",
        changedSince: since.toISOString(),
        minorversion: "73",
    });
    const response = await qbTimedFetch(
        `${QB_API_BASE}/${tokens.realmId}/cdc?${params.toString()}`,
        {
            qbDeadline: deadline,
            headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
                Accept: "application/json",
            },
        },
    );
    if (!response.ok) {
        throw new Error(`QBO Purchase CDC failed with status ${response.status}`);
    }

    const payload = await response.json();
    const cdcResponses = Array.isArray(payload?.CDCResponse)
        ? payload.CDCResponse
        : [];
    const queryResponses = cdcResponses.flatMap((entry: any) =>
        Array.isArray(entry?.QueryResponse) ? entry.QueryResponse : [],
    );
    const purchases: any[] = [];
    for (const queryResponse of queryResponses) {
        const page = Array.isArray(queryResponse?.Purchase)
            ? queryResponse.Purchase
            : [];
        const totalCount = Number(queryResponse?.totalCount ?? page.length);
        if (
            page.length >= 1000 ||
            (Number.isFinite(totalCount) && totalCount > page.length)
        ) {
            throw new Error("QBO Purchase CDC response was truncated");
        }
        purchases.push(...page);
    }

    // Keep the last representation if QBO includes the same id more than once.
    const byId = new Map<string, any>();
    const withoutId: any[] = [];
    for (const purchase of purchases) {
        const id = purchase?.Id === undefined ? "" : String(purchase.Id);
        if (id) byId.set(id, purchase);
        else withoutId.push(purchase);
    }
    return [...byId.values(), ...withoutId];
}

/** Posted customer payments (money in) from the books. */
export async function getRecentQBPaymentsList(tokens: QBTokens, sinceDaysAgo: number, deadline?: RouteDeadline) {
    const since = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString().split("T")[0];
    const rows = await qbQuery<any>(tokens, `SELECT * FROM Payment WHERE TxnDate >= '${since}' ORDERBY TxnDate DESC MAXRESULTS 500`, deadline);
    return rows.map(p => ({
        qbId: String(p.Id),
        date: p.TxnDate ?? null,
        amount: Number(p.TotalAmt ?? 0),
        customer: p.CustomerRef?.name ?? null,
        reference: p.PaymentRefNum ?? null,
    }));
}

/** The estimate-item shape `buildQBEstimateLines` needs: billing figures plus enough
 *  hierarchy (`id`/`parentId`/`type`) to tell section headers from billable leaves. */
export type QBEstimateItem = {
    // Required, not optional: a caller that omits the hierarchy silently loses legacy
    // section detection (a section is only recognizable by its type tag OR its children),
    // which is exactly the bug this function exists to prevent.
    id: string;
    parentId: string | null;
    name: string;
    quantity: number;
    unitCost: number;
    total: number;
    type: string;
};

/**
 * Billable QB estimate lines, one per LEAF row.
 *
 * Section headers are dropped. A section's stored total is a roll-up of its children, so
 * emitting it as a line bills that amount a second time on top of the child rows it
 * summarizes — a nested section double-counts twice over (an outer section holding a $250
 * inner section plus a $25 leaf shipped $800 of lines against a $275 subtotal).
 *
 * The filter lives here rather than in the caller so any future caller inherits it; it uses
 * the same `isEstimateSectionRow` predicate as the editor subtotal and the PDF, so all three
 * readers agree on which rows are headers.
 *
 * The returned amounts sum to the estimate's pre-tax SUBTOTAL, which is not the same as its
 * stored `totalAmount` (that column also carries tax and any processing-fee markup). QBO
 * computes its own sales tax on the lines it receives, so pushing a tax line here would
 * double-charge; the processing-fee gap is a separate open question — see the callers.
 */
export function buildQBEstimateLines(items: readonly QBEstimateItem[], itemId: string) {
    return items
        .filter(item => !isEstimateSectionRow(item, items))
        .map((item, i) => ({
            LineNum: i + 1,
            Description: item.name,
            Amount: item.total,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
                ItemRef: { value: itemId },
                Qty: item.quantity,
                UnitPrice: item.unitCost,
            },
        }));
}

/** Push an estimate to QB. Returns the QB estimate ID. */
export async function syncEstimateToQB(
    tokens: QBTokens,
    estimate: {
        id: string;
        code: string;
        title: string;
        totalAmount: number;
        items: QBEstimateItem[];
        customerId: string;
        itemId: string;
        project: { name: string } | null;
    },
    glMappings: Record<string, string> = {},
    deadline?: RouteDeadline,
): Promise<{ qbId: string; qbUrl: string }> {
    const lines = buildQBEstimateLines(estimate.items, estimate.itemId);

    // QBO rejects a transaction with no lines (error 2020, "Required param missing"). An
    // estimate that is empty, or that is nothing but section headers, reaches this point with
    // everything filtered out — fail with something legible instead of a raw QB API error.
    if (!lines.length) {
        throw new Error("QB estimate sync failed: estimate has no billable line items");
    }

    const payload = {
        TxnDate: new Date().toISOString().split("T")[0],
        DocNumber: estimate.code.slice(0, 21),
        PrivateNote: estimate.title,
        CustomerRef: { value: estimate.customerId },
        Line: lines,
    };

    const res = await qbFetch("/estimate", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
        qbDeadline: deadline,
    });

    // Every non-2xx goes through the shared classifier: a 429 or 5xx here is
    // QuickBooks being unavailable, not a verdict on this estimate, and a bare
    // Error made the two indistinguishable to every caller upstream.
    if (!res.ok) throw await qboResponseError(res, "QB estimate sync");

    const data = await res.json();
    const qbId = data.Estimate?.Id;
    const realmId = tokens.realmId;
    const qbUrl = `https://app.qbo.intuit.com/app/estimate?txnId=${qbId}`;

    return { qbId, qbUrl };
}

/** Push an invoice to QB. Returns the QB invoice ID. */
export async function syncInvoiceToQB(
    tokens: QBTokens,
    invoice: {
        code: string;
        totalAmount: number;
        balanceDue: number;
        customerId: string;
        itemId: string;
        project: { name: string } | null;
        items?: Array<{ description: string; amount: number }>;
    },
    deadline?: RouteDeadline,
): Promise<{ qbId: string; qbUrl: string }> {
    const lines: object[] = (invoice.items || []).map((item, i) => ({
        LineNum: i + 1,
        Description: item.description,
        Amount: item.amount,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: invoice.itemId }, Qty: 1, UnitPrice: item.amount },
    }));

    if (lines.length === 0) {
        lines.push({
            LineNum: 1,
            Description: invoice.project?.name || "Construction Services",
            Amount: invoice.totalAmount,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: { ItemRef: { value: invoice.itemId }, Qty: 1, UnitPrice: invoice.totalAmount },
        });
    }

    const payload = {
        DocNumber: invoice.code.slice(0, 21),
        TxnDate: new Date().toISOString().split("T")[0],
        CustomerRef: { value: invoice.customerId },
        Line: lines,
    };

    const res = await qbFetch("/invoice", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
        qbDeadline: deadline,
    });

    // Same shared classification as the estimate push above.
    if (!res.ok) throw await qboResponseError(res, "QB invoice sync");

    const data = await res.json();
    const qbId = data.Invoice?.Id;
    const qbUrl = `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}`;
    return { qbId, qbUrl };
}

/** Send a QBO invoice email to a client. */
export async function sendQBInvoice(tokens: QBTokens, qbInvoiceId: string, sendTo?: string | null, deadline?: RouteDeadline) {
    const qs = new URLSearchParams({ minorversion: "73" });
    if (sendTo) qs.set("sendTo", sendTo);
    const url = `${QB_API_BASE}/${tokens.realmId}/invoice/${qbInvoiceId}/send?${qs}`;
    const res = await qbTimedFetch(url, {
        qbDeadline: deadline,
        method: "POST",
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/octet-stream",
        },
    });
    if (!res.ok) return { ok: false as const, status: res.status, error: await res.text() };
    const data = (await parseJsonOrNull(res)) ?? {};
    return { ok: true as const, status: res.status, emailStatus: data.Invoice?.EmailStatus ?? null };
}
