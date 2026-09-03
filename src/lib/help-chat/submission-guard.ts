// Input hardening for the two help-widget submit routes (review round 5, item 10).
//
// These endpoints became reachable by EVERY activated staff account and by the
// crew app's Bearer token in this phase, and each submission creates a GitHub
// issue. That widened both the input surface and the blast radius of a stuck
// retry loop, so the payload is bounded and the caller is throttled.
//
// Pure except for the throttle's row count, which is injected — so the limits
// are testable without a database.

import { randomUUID, createHash } from "crypto";
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

/**
 * The content of a submission — everything that ends up in the GitHub issue.
 *
 * Returned by reserveHelpRequest so a route files from THIS rather than from
 * the body it was handed: on a replay the two are not the same thing.
 */
export type HelpRequestPayload = {
    type: string;
    question: string;
    response: string;
    currentPage: string | null;
    conversationId: string | null;
};

/**
 * sha256 of what a submission SAYS, so an idempotency key can be checked
 * against the content it was issued for.
 *
 * A submissionId is chosen by the client and is only a promise that "this is
 * the same report as before". Nothing used to hold it to that promise: a second
 * request could reuse a key with entirely different content, attach itself to
 * the first report's row, and file a GitHub issue describing text that row does
 * not contain — so the saved report and the issue raised from it disagreed, and
 * whichever one you read was the wrong one.
 *
 * Normalised before hashing (trimmed, absent === empty) so a stored NULL and an
 * incoming "" are the same answer rather than a spurious conflict. JSON rather
 * than a joined string: a separator that can appear inside a field is a
 * separator a caller can forge a collision with.
 */
export function helpPayloadFingerprint(payload: HelpRequestPayload): string {
    const norm = (value: string | null | undefined) => (typeof value === "string" ? value.trim() : "");
    return createHash("sha256")
        .update(
            JSON.stringify([
                norm(payload.type),
                norm(payload.question),
                norm(payload.response),
                norm(payload.currentPage),
                norm(payload.conversationId),
            ]),
            "utf8"
        )
        .digest("hex");
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
          /**
           * THE CONTENT TO FILE. The incoming payload on a fresh insert; the
           * STORED row's own content on a replay — which is the whole point,
           * because a resumed attempt is finishing the report that was saved,
           * not the request that happens to be asking.
           */
          payload: HelpRequestPayload;
      }
    | { ok: false; reason: "throttled" }
    | { ok: false; reason: "in-flight" }
    /** The key was reused with DIFFERENT content. Nothing is filed; the route answers 409. */
    | { ok: false; reason: "payload-conflict" };

/** How long a provider lease is honoured before another attempt may take it. */
export const HELP_LEASE_MS = 4 * 60 * 1000;

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
 * Budget for ONE provider call.
 *
 * A resumed submission makes TWO: the marker search, then the create. Giving
 * each its own fresh 90s timeout meant the pair could run for 180s against a
 * 120s lease — the attempt outlived the lease it was fenced by, a second
 * claimant took over, and the first came back to write a result nobody wanted.
 */
export const HELP_PROVIDER_TIMEOUT_MS = 90 * 1000;

/**
 * Budget for the WHOLE provider interaction, as ONE absolute deadline shared by
 * every call in the attempt. 2 x 90s, so a slow search cannot eat the create's
 * time and still leave the pair inside it.
 *
 * Must stay comfortably under HELP_LEASE_MS: the lease is 240s, this is 180s,
 * and the 60s margin covers the DB round-trips around the calls plus the lease
 * renewal between them.
 */
export const HELP_PROVIDER_DEADLINE_MS = 2 * HELP_PROVIDER_TIMEOUT_MS;

/** One deadline for the attempt. Both provider calls share it. */
export function providerDeadlineSignal(): AbortSignal {
    return AbortSignal.timeout(HELP_PROVIDER_DEADLINE_MS);
}

/**
 * Push this attempt's lease out, but only while it still holds it.
 *
 * Called between the two provider calls: the marker search may have used most
 * of the deadline, and the create still has to happen inside the lease. Fenced
 * on the token for the same reason the completion is — a superseded attempt
 * must not be able to extend a lease it no longer owns.
 */
export async function renewProviderLease(
    requestId: string,
    leaseToken: string,
    client: { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number> } = prisma as never
): Promise<boolean> {
    const expiry = new Date(Date.now() + HELP_LEASE_MS);
    const renewed = await client.$executeRaw`
        UPDATE "HelpRequest"
        SET "providerLeaseExpiresAt" = ${expiry}
        WHERE "id" = ${requestId} AND "providerLeaseToken" = ${leaseToken}
    `;
    return renewed === 1;
}

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

/** The idempotency key was reused with different content — see helpPayloadFingerprint. */
export const SUBMISSION_KEY_CONFLICT = "submission-key-conflict";
export const SUBMISSION_KEY_CONFLICT_MESSAGE =
    "That submission id was already used for a different report. Nothing was filed — send this one with a new id.";

/**
 * Deterministic idempotency key for a mobile caller that sends no
 * submissionId — the crew app's bug-report screen does not
 * (apps/mobile/lib/bugReport.ts posts title/description/currentPage only), so
 * requiring one 400'd every phone report. Retry safety still matters: the app
 * retries on network failure, and without SOME key each retry opens a second
 * GitHub issue.
 *
 * WHY THERE IS NO TIME BUCKET IN THE KEY. The first version hashed
 * `floor(now / 60s)` into it. A key that changes on a wall-clock boundary is
 * not an idempotency key: the app's retry is triggered by a LOST RESPONSE, and
 * the gap before it is whatever the network took. Two retries of one report
 * that straddle 12:00:59 → 12:01:00 hash differently and open two GitHub
 * issues — the exact duplicate the key exists to prevent, at the exact moment
 * it is needed. Bucket size does not fix it; every bucket has a boundary.
 *
 * So the key is the CONTENT alone, and the window is applied as a LOOKUP
 * instead (deriveMobileSubmissionId below): any retry inside 24h resolves to
 * the key the first attempt used and replays onto that row; the same content
 * reported again after the window resolves to the next generation and files a
 * genuinely new report. The generation suffix is what lets both be true —
 * `submissionId` is UNIQUE per (userId, submissionId), so a bare content hash
 * would collapse a report and its legitimate recurrence a week later onto one
 * row, forever.
 *
 * The mobile client should send a persisted per-submission UUID; see
 * docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md. Until it does, this is
 * the server-side stand-in — an explicit submissionId always wins.
 */
export const HELP_DERIVED_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Hex characters of the content hash kept in the key. Short enough to leave
 * room for the "-g<N>" generation suffix inside HELP_SUBMISSION_ID_MAX (64);
 * 48 hex is 192 bits, far past any collision concern for one user's reports.
 */
export const HELP_DERIVED_KEY_HASH_CHARS = 48;

/** The content half of a derived key — same user, same words, same value, forever. */
export function mobileSubmissionContentKey(userId: string, title: string, description: string): string {
    const normalizedText = `${title}\n${description}`.trim().toLowerCase().replace(/\s+/g, " ");
    return createHash("sha256")
        .update(`${userId}:${normalizedText}`)
        .digest("hex")
        .slice(0, HELP_DERIVED_KEY_HASH_CHARS);
}

/** SQL LIKE pattern matching every generation of one content key. Hex holds no LIKE wildcard. */
export function derivedKeyLikePattern(contentKey: string): string {
    return `${contentKey}-g%`;
}

/**
 * The whole windowing rule, pure: given the newest key this user already has
 * for this exact content, what key does the submission in hand use?
 *
 *  - nothing prior          → generation 1, a new report;
 *  - prior inside the window → THAT key, so the reservation replays onto the
 *    existing row and the caller gets the original issue back;
 *  - prior older than the window → the next generation, a new report.
 */
export function nextDerivedSubmissionId(
    contentKey: string,
    prior: { submissionId: string; createdAt: Date } | null,
    now: Date = new Date()
): string {
    if (!prior) return `${contentKey}-g1`;
    if (now.getTime() - prior.createdAt.getTime() <= HELP_DERIVED_KEY_WINDOW_MS) {
        return prior.submissionId;
    }
    const generation = Number(/-g(\d+)$/.exec(prior.submissionId)?.[1] ?? 1);
    return `${contentKey}-g${(Number.isFinite(generation) ? generation : 1) + 1}`;
}

/**
 * Resolve the derived key for this submission: hash the content, then ask the
 * database which generation of it is current.
 *
 * The read is ordinary (no lock). Two first-time attempts racing both compute
 * generation 1 and reserveHelpRequest's ON CONFLICT DO NOTHING collapses them
 * onto one row — which is the same protection an explicit submissionId gets.
 */
export async function deriveMobileSubmissionId(
    userId: string,
    title: string,
    description: string,
    now: Date = new Date(),
    client: {
        $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
    } = prisma as never
): Promise<string> {
    const contentKey = mobileSubmissionContentKey(userId, title, description);
    const rows = await client.$queryRaw<Array<{ submissionId: string; createdAt: Date }>>`
        SELECT "submissionId", "createdAt" FROM "HelpRequest"
        WHERE "userId" = ${userId} AND "submissionId" LIKE ${derivedKeyLikePattern(contentKey)}
        ORDER BY "createdAt" DESC
        LIMIT 1
    `;
    return nextDerivedSubmissionId(contentKey, rows[0] ?? null, now);
}

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
    const incoming: HelpRequestPayload = {
        type: input.type,
        question: input.question,
        response: input.response,
        currentPage: input.currentPage,
        conversationId: input.conversationId,
    };
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
                          select: {
                              id: true,
                              status: true,
                              createdAt: true,
                              providerState: true,
                              // The stored CONTENT, so the key can be checked
                              // against what it was issued for — and so a
                              // resume files the report that was saved.
                              type: true,
                              question: true,
                              response: true,
                              currentPage: true,
                              conversationId: true,
                          },
                      })
                    : null;
                if (!existing) throw new HelpReserveRaceError();
                const stored: HelpRequestPayload = {
                    type: existing.type,
                    question: existing.question,
                    response: existing.response,
                    currentPage: existing.currentPage,
                    conversationId: existing.conversationId,
                };
                // The key promised "this is the same report". If it is not, this
                // is not a retry at all — it is a different report wearing an
                // old report's key, and attaching it would file an issue whose
                // text the stored row does not contain. Refuse both: no filing,
                // no attaching, and no quota charged either.
                if (helpPayloadFingerprint(stored) !== helpPayloadFingerprint(incoming)) {
                    return { ok: false, reason: "payload-conflict" } as ReserveResult;
                }
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
                    // The STORED content, never `incoming` — the fingerprints
                    // agree above, and this is the copy that is actually on the
                    // row the issue will be attached to.
                    payload: stored,
                } as ReserveResult;
            }

            // Quota is charged only for a report that is genuinely NEW. A retry
            // takes the branch above and never reaches here, so replaying a
            // submission can never throttle the user out of their own report.
            //
            // ROLLING window, not a UTC clock-hour bucket: the bucket reset at
            // the top of every hour, so 5 filed at 12:59:59 and 5 more at
            // 13:00:00 both passed — 10 reports a few seconds apart, "5 an
            // hour" in name only. throttleWindowStart()/isThrottled() are the
            // real rule; this is the one place that counts against them.
            //
            // An advisory lock scoped to this user, held for the rest of the
            // transaction, is what makes the count-then-decide below safe
            // against two submissions racing in at once: without it, two
            // concurrent transactions could each COUNT the same 4 prior rows,
            // each conclude "room for one more", and both commit a 5th —
            // exactly the double-tap the old UPDATE...WHERE count < N made
            // impossible with a single atomic statement. Serializing here
            // reproduces that guarantee for a plain COUNT.
            const lockKey = `help-submission-quota:${input.userId}`;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
            const windowStart = throttleWindowStart();
            const counted = await tx.$queryRaw<Array<{ count: number }>>`
                SELECT COUNT(*)::int AS count FROM "HelpRequest"
                WHERE "userId" = ${input.userId}
                  AND "createdAt" >= ${windowStart}
                  AND "id" != ${inserted[0].id}
            `;
            if (isThrottled(counted[0]?.count ?? 0)) throw new HelpThrottledError();

            // A fresh insert stored EXACTLY `incoming`, so it is both the
            // incoming payload and the stored one — the route takes the same
            // field on both branches and cannot pick the wrong copy.
            return { ok: true, id: inserted[0].id, existing: false, resume: false, providerState: null, payload: incoming };
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
