// Input hardening for the two help-widget submit routes (review round 5, item 10).
//
// These endpoints became reachable by EVERY activated staff account and by the
// crew app's Bearer token in this phase, and each submission creates a GitHub
// issue. That widened both the input surface and the blast radius of a stuck
// retry loop, so the payload is bounded and the caller is throttled.
//
// Pure except for the throttle's row count, which is injected — so the limits
// are testable without a database.

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "../prisma";

export const HELP_TITLE_MAX = 200;
export const HELP_DESCRIPTION_MAX = 5_000;
export const HELP_STEPS_MAX = 5_000;
export const HELP_CURRENT_PAGE_MAX = 500;
export const HELP_CONVERSATION_ID_MAX = 64;
export const HELP_SUBMISSION_ID_MAX = 64;

/**
 * `currentPage` has TWO legitimate shapes, and rejecting either loses reports:
 *
 *   - the web widget sends a route, "/projects/abc?tab=1";
 *   - the crew app sends the SCREEN it was on, namespaced so a phone report can
 *     never be mistaken for a web one: "mobile:Time Clock"
 *     (gtr-probuild-mobile apps/mobile/lib/bugReport.ts builds it).
 *
 * A path-only rule 400'd every bug report from the phone — the exact surface
 * this phase opened up.
 */
export const HELP_CURRENT_PAGE_PATTERN =
    /^(\/[^\s]{0,499}|mobile:[^\s]{1,120}( [^\s]{1,120}){0,5})$/;

/**
 * Is this caller the crew app?
 *
 * Derived from HOW THEY AUTHENTICATED — a mobile JWT — not from the body they
 * sent. currentPage was the old signal, and a body field cannot establish
 * anything about the client: anyone could post `currentPage: "mobile:..."` to
 * be labelled a bug, or omit it to dodge the submissionId requirement that
 * makes the app's retries safe.
 */
export function isMobileClient(auth: { via?: string | null } | null | undefined): boolean {
    return auth?.via === "mobile-jwt";
}

/** Kept for the ISSUE LABELLING only — where the report came from, as the app describes it. */
export function isMobileSubmission(currentPage: string | null | undefined): boolean {
    return typeof currentPage === "string" && currentPage.startsWith("mobile:");
}
/** Submissions per user per hour. A human reporting bugs never approaches this; a retry loop does. */
export const HELP_SUBMISSIONS_PER_HOUR = 5;
export const HELP_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

export type HelpSubmissionInput = {
    title?: unknown;
    description?: unknown;
    steps?: unknown;
    currentPage?: unknown;
    conversationId?: unknown;
    submissionId?: unknown;
};

export type HelpSubmissionCheck =
    | {
          ok: true;
          title: string;
          description: string;
          steps: string | null;
          currentPage: string | null;
          conversationId: string | null;
          submissionId: string | null;
      }
    | { ok: false; status: number; error: string };

function readString(value: unknown): string | null {
    return typeof value === "string" ? value.trim() : null;
}

/**
 * Validate a submission body. Length limits are enforced rather than truncated:
 * silently cutting a bug report at 200 characters loses the part that mattered,
 * and the caller cannot tell it happened.
 */
export function checkHelpSubmission(body: HelpSubmissionInput): HelpSubmissionCheck {
    const title = readString(body.title);
    const description = readString(body.description);
    if (!title || !description) {
        return { ok: false, status: 400, error: "Missing required fields" };
    }
    if (title.length > HELP_TITLE_MAX) {
        return { ok: false, status: 400, error: `Title must be ${HELP_TITLE_MAX} characters or fewer.` };
    }
    if (description.length > HELP_DESCRIPTION_MAX) {
        return {
            ok: false,
            status: 400,
            error: `Description must be ${HELP_DESCRIPTION_MAX} characters or fewer.`,
        };
    }
    const steps = readString(body.steps);
    if (steps && steps.length > HELP_STEPS_MAX) {
        return { ok: false, status: 400, error: `Steps must be ${HELP_STEPS_MAX} characters or fewer.` };
    }
    // currentPage is echoed into a GitHub issue, so it is bounded and shape-
    // checked — but it accepts BOTH the web widget's route and the crew app's
    // "mobile:<Screen>" (see HELP_CURRENT_PAGE_PATTERN).
    const currentPage = readString(body.currentPage);
    if (currentPage) {
        if (currentPage.length > HELP_CURRENT_PAGE_MAX) {
            return { ok: false, status: 400, error: `currentPage must be ${HELP_CURRENT_PAGE_MAX} characters or fewer.` };
        }
        if (!HELP_CURRENT_PAGE_PATTERN.test(currentPage)) {
            return {
                ok: false,
                status: 400,
                error: "currentPage must be an app path beginning with / or a mobile:<Screen> marker.",
            };
        }
    }

    // conversationId is an opaque id, never free text.
    const conversationId = readString(body.conversationId);
    if (conversationId) {
        if (conversationId.length > HELP_CONVERSATION_ID_MAX || !/^[A-Za-z0-9_-]+$/.test(conversationId)) {
            return { ok: false, status: 400, error: "conversationId is not a valid id." };
        }
    }

    // Optional idempotency key. The crew app does not send one today
    // (apps/mobile/lib/bugReport.ts posts title/description/currentPage only),
    // so it stays optional — a client that does send it gets retry safety.
    const submissionId = readString(body.submissionId);
    if (submissionId) {
        if (submissionId.length > HELP_SUBMISSION_ID_MAX || !/^[A-Za-z0-9_-]+$/.test(submissionId)) {
            return { ok: false, status: 400, error: "submissionId is not a valid id." };
        }
    }

    return {
        ok: true,
        title,
        description,
        steps: steps || null,
        currentPage: currentPage || null,
        conversationId: conversationId || null,
        submissionId: submissionId || null,
    };
}

/** Instant the throttle window opens. Callers count this user's submissions since then. */
export function throttleWindowStart(now: Date = new Date()): Date {
    return new Date(now.getTime() - HELP_THROTTLE_WINDOW_MS);
}

export function isThrottled(recentCount: number): boolean {
    return recentCount >= HELP_SUBMISSIONS_PER_HOUR;
}

/** The hour window a submission counts against. */
export function hourBucket(now: Date = new Date()): Date {
    const bucket = new Date(now);
    bucket.setUTCMinutes(0, 0, 0);
    return bucket;
}

/**
 * 200 when the report reached GitHub, 202 when it is only saved here.
 *
 * The report row is durable either way, so 5xx would be a lie — but so is 200,
 * which the crew app treats as terminal and uses to discard the local draft. A
 * pending 202 carries the submissionId back so the app can retry the SAME
 * submission later; that retry resumes the existing row (reserveHelpRequest's
 * `resume`) and finishes it rather than filing a second report.
 */
export function helpChatResponse(options: {
  body: Record<string, unknown>;
  filed: boolean;
  submissionId: string | null;
}): NextResponse {
  if (options.filed) return NextResponse.json({ ...options.body, status: "filed" });
  return NextResponse.json(
    { ...options.body, status: "pending", submissionId: options.submissionId },
    { status: 202 }
  );
}

export type ReserveResult =
    | {
          ok: true;
          id: string;
          existing: boolean;
          resume: boolean;
          /**
           * What the stored row says about the GitHub side: "created" once an
           * issue exists, "pending" while it does not. The route answers 202
           * rather than 200 on anything that is not "created", so a client can
           * tell "filed" from "saved, not filed yet".
           */
          providerState: string | null;
      }
    | { ok: false; reason: "throttled" }
    | { ok: false; reason: "in-flight" };

/** How long a provider lease is honoured before another attempt may take it. */
export const HELP_LEASE_MS = 2 * 60 * 1000;

/**
 * Claim the right to call GitHub for this report, atomically.
 *
 * Two attempts can reach the provider step at once — a double-tap, or a retry
 * arriving while the first request is still running. Without a claim they both
 * call GitHub and open two issues for one report; the marker search does not
 * help, because neither issue exists yet when they both look.
 *
 * The claim is a compare-and-set on the row: take it only if nobody holds it or
 * the previous holder's lease has expired. `count === 0` means somebody else is
 * mid-flight, and the caller backs off rather than filing.
 */
export async function claimProviderLease(
    requestId: string,
    client: { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number> } = prisma as never
): Promise<string | null> {
    const token = randomUUID();
    const now = new Date();
    const expiry = new Date(now.getTime() + HELP_LEASE_MS);
    const claimed = await client.$executeRaw`
        UPDATE "HelpRequest"
        SET "providerLeaseToken" = ${token}, "providerLeaseExpiresAt" = ${expiry}
        WHERE "id" = ${requestId}
          AND "providerState" IS DISTINCT FROM 'created'
          AND ("providerLeaseExpiresAt" IS NULL OR "providerLeaseExpiresAt" < ${now})
    `;
    // The token is a FENCE, not a receipt. An attempt whose lease expired while
    // GitHub was slow has already been replaced by a second claimant; every
    // write it makes afterwards must be conditioned on still holding the lease,
    // or it lands on top of the newer attempt's result. Returning the token is
    // what lets the caller do that.
    return claimed === 1 ? token : null;
}

/**
 * The provider call must finish INSIDE the lease, with room to spare — a call
 * that outlives its own lease is exactly the overlap the fence exists to catch,
 * and one that is merely aborted leaves nothing to reconcile.
 */
export const HELP_PROVIDER_TIMEOUT_MS = 90 * 1000;

/**
 * Finish a submission, but only while this attempt still holds the lease.
 *
 * `WHERE providerLeaseToken = $token` is the whole point: a late completion from
 * a superseded attempt updates nothing and returns false, instead of stamping
 * its own issue number over the one the second claimant filed.
 */
export async function completeUnderLease(
    requestId: string,
    leaseToken: string,
    outcome:
        | { filed: true; issueNumber: number; issueUrl: string; status: string }
        | { filed: false; status: string },
    /** Injected so the superseded-attempt branch can be exercised without racing two real requests. */
    client: { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number> } = prisma as never
): Promise<boolean> {
    const updated = outcome.filed
        ? await client.$executeRaw`
            UPDATE "HelpRequest"
            SET "status" = ${outcome.status},
                "changeLocation" = ${outcome.issueUrl},
                "externalIssueRef" = ${`github-issue:${outcome.issueNumber}`},
                "providerIssueRef" = ${String(outcome.issueNumber)},
                "providerState" = 'created'
            WHERE "id" = ${requestId} AND "providerLeaseToken" = ${leaseToken}
        `
        : await client.$executeRaw`
            UPDATE "HelpRequest"
            SET "status" = ${outcome.status}, "providerState" = 'pending'
            WHERE "id" = ${requestId} AND "providerLeaseToken" = ${leaseToken}
        `;
    return updated === 1;
}

/**
 * The marker stamped into every issue body. It is how a resumed submission can
 * ask GitHub "did I already file this?" before filing again — the only source
 * of truth once our own write and the provider's have diverged.
 */
export function submissionMarker(requestId: string): string {
    return `probuild-submission:${requestId}`;
}

/** A mobile caller with no idempotency key cannot be made safe to retry. */
export const MOBILE_SUBMISSION_ID_REQUIRED = "submission-id-required";

/** A `submitting` row older than this was abandoned mid-flight; a retry resumes it. */
export const HELP_SUBMITTING_STALE_MS = 2 * 60 * 1000;

/**
 * Claim a submission slot and create the row, in ONE transaction.
 *
 * Both halves commit together or neither does. They used to be separate
 * statements: a failure between them either consumed a slot with no row to show
 * for it, or created a row the counter never saw.
 *
 * Retry semantics, for the same `submissionId`:
 *  - a row that reached a terminal status is returned as-is (`existing`), so a
 *    retry never opens a second GitHub issue;
 *  - a row still `submitting` and OLDER than HELP_SUBMITTING_STALE_MS is
 *    RESUMED (`resume`): the previous attempt died before it could create the
 *    issue, and returning early would strand the report forever;
 *  - a row still `submitting` and recent is treated as in-flight and returned,
 *    because a double-tap should not file twice.
 *
 * A resume consumes no additional quota — the slot was already paid for.
 */
export async function reserveHelpRequest(input: {
    userId: string;
    type: string;
    question: string;
    response: string;
    currentPage: string | null;
    conversationId: string | null;
    submissionId: string | null;
},
/**
 * The database client. Injected so the CONFLICT branch can be exercised without
 * two live Postgres connections — the losing side of a race is exactly the path
 * that used to 500, and it is the one a single-threaded test can never reach by
 * accident.
 */
client: { $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> } = prisma as never
): Promise<ReserveResult> {
    const bucket = hourBucket();
    try {
        return await client.$transaction(async (tx) => {
            // ONE statement decides "new report" vs "replay". The old shape read
            // first and inserted second, so two requests carrying the same
            // submissionId both found nothing, both inserted, and the loser got
            // a unique-violation 500 — exactly the double-tap the key exists to
            // absorb. DO NOTHING makes the loser's INSERT return no row instead.
            //
            // Scoped by (userId, submissionId): clients pick these values, so a
            // conflict on the key alone would collide across accounts.
            const inserted = await tx.$queryRaw<Array<{ id: string }>>`
                INSERT INTO "HelpRequest" ("userId", "type", "question", "response", "currentPage", "status", "conversationId", "submissionId")
                VALUES (${input.userId}, ${input.type}, ${input.question}, ${input.response},
                        ${input.currentPage}, 'submitting', ${input.conversationId}, ${input.submissionId})
                ON CONFLICT ("userId", "submissionId") DO NOTHING
                RETURNING "id"
            `;

            if (inserted.length === 0) {
                // Lost the race, or a genuine retry. Either way the row the
                // winner committed is the answer. (A null submissionId never
                // conflicts — Postgres treats NULLs as distinct — so this branch
                // only runs for a keyed submission.)
                const existing = input.submissionId
                    ? await tx.helpRequest.findUnique({
                          where: {
                              userId_submissionId: { userId: input.userId, submissionId: input.submissionId },
                          },
                          select: { id: true, status: true, createdAt: true, providerState: true },
                      })
                    : null;
                if (!existing) throw new HelpReserveRaceError();
                const age = Date.now() - (existing.createdAt?.getTime() ?? 0);
                // Resume ANY row whose issue was never created — providerState is
                // the only reliable signal. Keying off status === "submitting"
                // stranded every 'submitted_no_issue' row: GitHub was down, the
                // report was saved, and no retry would ever finish it because the
                // status had already moved on.
                const stale = existing.providerState !== "created" && age > HELP_SUBMITTING_STALE_MS;
                return {
                    ok: true,
                    id: existing.id,
                    existing: true,
                    resume: stale,
                    providerState: existing.providerState ?? null,
                } as ReserveResult;
            }

            // Quota is charged only for a report that is genuinely NEW. A retry
            // takes the branch above and never reaches here, so replaying a
            // submission can never throttle the user out of their own report.
            //
            // The decision is entirely in the UPDATE: five concurrent callers
            // all read the same count under the old count-then-insert and all
            // passed. Throwing rolls the INSERT above back with it.
            await tx.$executeRaw`
                INSERT INTO "HelpSubmissionQuota" ("id", "userId", "hourBucket", "count")
                VALUES (gen_random_uuid()::text, ${input.userId}, ${bucket}, 0)
                ON CONFLICT ("userId", "hourBucket") DO NOTHING
            `;
            const claimed = await tx.$queryRaw<Array<{ count: number }>>`
                UPDATE "HelpSubmissionQuota"
                SET "count" = "count" + 1
                WHERE "userId" = ${input.userId}
                  AND "hourBucket" = ${bucket}
                  AND "count" < ${HELP_SUBMISSIONS_PER_HOUR}
                RETURNING "count"
            `;
            if (claimed.length === 0) throw new HelpThrottledError();

            return { ok: true, id: inserted[0].id, existing: false, resume: false, providerState: null };
        });
    } catch (error) {
        if (error instanceof HelpThrottledError) return { ok: false, reason: "throttled" };
        throw error;
    }
}

/**
 * The conflicting row vanished between the INSERT and the SELECT — only
 * possible if something deleted it in that window. Distinct from a throttle so
 * the route does not report a deletion as "you have filed too many".
 */
class HelpReserveRaceError extends Error {
    constructor() {
        super("help request reservation raced");
        this.name = "HelpReserveRaceError";
    }
}

/** Internal: rolls the reservation transaction back when the hourly slot is gone. */
class HelpThrottledError extends Error {
    constructor() {
        super("throttled");
        this.name = "HelpThrottledError";
    }
}


export const HELP_THROTTLED_MESSAGE = `That's ${HELP_SUBMISSIONS_PER_HOUR} reports in an hour — give it a few minutes before sending another. Nothing was lost.`;

/**
 * Read a JSON body without throwing. A malformed body is a 400, not a 500: the
 * crew app retries on 5xx, so an unparseable payload would become a loop.
 */
export async function readJsonBody(req: { json(): Promise<unknown> }): Promise<{ ok: true; body: any } | { ok: false }> {
    try {
        const body = await req.json();
        if (!body || typeof body !== "object") return { ok: false };
        return { ok: true, body };
    } catch {
        return { ok: false };
    }
}
