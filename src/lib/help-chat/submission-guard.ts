// Input hardening for the two help-widget submit routes (review round 5, item 10).
//
// These endpoints became reachable by EVERY activated staff account and by the
// crew app's Bearer token in this phase, and each submission creates a GitHub
// issue. That widened both the input surface and the blast radius of a stuck
// retry loop, so the payload is bounded and the caller is throttled.
//
// Pure except for the throttle's row count, which is injected — so the limits
// are testable without a database.

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

/** True when this submission came from the crew app rather than the web widget. */
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

export type ReserveResult =
    | { ok: true; id: string; existing: boolean; resume: boolean }
    | { ok: false; reason: "throttled" };

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
}): Promise<ReserveResult> {
    if (input.submissionId) {
        // Scoped by userId. A lookup on the key alone would return another
        // user's report the moment two clients picked the same value — and
        // clients pick these, so collisions are a matter of time.
        const existing = await prisma.helpRequest.findUnique({
            where: { userId_submissionId: { userId: input.userId, submissionId: input.submissionId } },
            select: { id: true, status: true, createdAt: true, providerState: true },
        });
        if (existing) {
            const age = Date.now() - (existing.createdAt?.getTime() ?? 0);
            // Resume ANY row whose issue was never created — providerState is
            // the only reliable signal. Keying off status === "submitting"
            // stranded every 'submitted_no_issue' row: GitHub was down, the
            // report was saved, and no retry would ever finish it because the
            // status had already moved on.
            const stale = existing.providerState !== "created" && age > HELP_SUBMITTING_STALE_MS;
            return { ok: true, id: existing.id, existing: true, resume: stale };
        }
    }

    const bucket = hourBucket();
    try {
        const id = await prisma.$transaction(async (tx) => {
            // Insert-on-missing, then the conditional increment. The decision is
            // entirely in the UPDATE: five concurrent callers all read the same
            // count under the old count-then-insert and all passed.
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

            const rows = await tx.$queryRaw<Array<{ id: string }>>`
                INSERT INTO "HelpRequest" ("userId", "type", "question", "response", "currentPage", "status", "conversationId", "submissionId")
                VALUES (${input.userId}, ${input.type}, ${input.question}, ${input.response},
                        ${input.currentPage}, 'submitting', ${input.conversationId}, ${input.submissionId})
                RETURNING "id"
            `;
            return rows[0].id;
        });
        return { ok: true, id, existing: false, resume: false };
    } catch (error) {
        if (error instanceof HelpThrottledError) return { ok: false, reason: "throttled" };
        throw error;
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
