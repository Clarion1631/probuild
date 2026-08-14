import { prisma } from "./prisma";
import {
    canonicalizeReasonCodes,
    decodeReasonCodes,
    encodeReasonCodes,
    hashReasonCodes,
    type ReasonCode,
} from "./review-alert-reasons";

/**
 * Review-issue lifecycle — the ORDERED decision tree from Unified Money
 * Register plan §4 "Lifecycle". Codex blocked twice on an earlier unordered
 * condition table because it was neither total (some states matched no row)
 * nor race-safe (concurrent evaluations could interleave). This is a single
 * total function: exactly one of the six steps below always matches, in
 * order, and the caller short-circuits on the first match.
 *
 *   1. reason set empty              → clear (cancel open episodes)
 *   2. no issue exists                → create, generation 1, new episode
 *   3. issue cleared, set non-empty   → un-clear ("reopen"), generation+1, new episode
 *   4. acknowledged codes ⊇ current   → suppress, no new episode
 *   5. same reasonHash as stored      → touch only, no new episode
 *   6. changed reasonHash             → supersede the open episode, generation+1, new episode
 *
 * `decideLifecycle` is PURE (no I/O) so the ordered tree — including the
 * clear→regression cycle and per-code acknowledgement — is exhaustively unit
 * testable without a database. `evaluateReviewIssue` is the Prisma-backed
 * wrapper: it re-reads the current row, asks the pure function what to do,
 * and applies it inside ONE SHORT transaction guarded by `{id, version}`
 * (optimistic concurrency) — a version conflict retries the WHOLE evaluation
 * (re-read + re-decide), never just the write, so a decision is never applied
 * against a row it didn't actually see.
 */

// ── Pure decision tree ───────────────────────────────────────────────────────

export interface ReviewIssueState {
    id: string;
    version: number;
    reasonHash: string;
    acknowledgedCodes: ReasonCode[];
    clearedAt: Date | null;
    currentGeneration: number;
    /** JSON-encoded display details as currently stored — NOT part of the
     * hash (see the module header). Compared byte-for-byte in the "touch"
     * step so a corrected amount/vendor/date can still reach the row even
     * when reasonCodes/reasonHash are unchanged (finding 9). */
    displayDetails: string | null;
}

export type LifecycleAction = "noop" | "clear" | "create" | "reopen" | "suppress" | "touch" | "supersede";

export interface LifecycleDecision {
    step: 1 | 2 | 3 | 4 | 5 | 6;
    action: LifecycleAction;
    /** Canonical (sorted, deduped) current reason codes. */
    canonicalCodes: ReasonCode[];
    reasonHash: string;
    /** The generation a new episode should open at — only set for create/reopen/supersede. */
    openGeneration?: number;
}

/**
 * Pure — takes the current stored state (or `null` if no issue exists yet)
 * and the freshly-computed reason codes, and returns which of the six
 * ordered steps applies. No Prisma, no Date.now() (the caller stamps
 * timestamps), no side effects.
 */
export function decideLifecycle(
    existing: ReviewIssueState | null,
    currentCodes: ReasonCode[],
): LifecycleDecision {
    const canonicalCodes = canonicalizeReasonCodes(currentCodes);
    const reasonHash = hashReasonCodes(canonicalCodes);

    // Step 1: reason set empty.
    if (canonicalCodes.length === 0) {
        if (existing && existing.clearedAt === null) {
            return { step: 1, action: "clear", canonicalCodes, reasonHash };
        }
        // No issue at all, or already cleared — nothing to do.
        return { step: 1, action: "noop", canonicalCodes, reasonHash };
    }

    // Step 2: no issue exists.
    if (!existing) {
        return { step: 2, action: "create", canonicalCodes, reasonHash, openGeneration: 1 };
    }

    // Step 3: issue cleared, set non-empty — un-clear.
    if (existing.clearedAt !== null) {
        return {
            step: 3,
            action: "reopen",
            canonicalCodes,
            reasonHash,
            openGeneration: existing.currentGeneration + 1,
        };
    }

    // Step 4: acknowledged codes are a superset of the current codes.
    // Per-code, not whole-set (plan punch 9): removing one acknowledged
    // reason while others remain must NOT re-alert; a genuinely new code
    // (not in the acknowledged set) must fall through to step 5/6.
    const acked = new Set(existing.acknowledgedCodes);
    if (canonicalCodes.every(code => acked.has(code))) {
        return { step: 4, action: "suppress", canonicalCodes, reasonHash };
    }

    // Step 5: same reasonHash as currently stored — touch only.
    if (reasonHash === existing.reasonHash) {
        return { step: 5, action: "touch", canonicalCodes, reasonHash };
    }

    // Step 6: changed hash — supersede the open episode, open a new generation.
    return {
        step: 6,
        action: "supersede",
        canonicalCodes,
        reasonHash,
        openGeneration: existing.currentGeneration + 1,
    };
}

// ── Prisma-backed evaluator ──────────────────────────────────────────────────

/** Minimal Prisma-shaped client — same "typed subset, not the real generated
 * client type" convention as QboPurchaseClassificationPersistenceClient in
 * qbo-expense-sync.ts, so tests can pass an in-memory fake instead of a live
 * database. `prisma as unknown as ReviewIssueLifecycleClient` satisfies this
 * at the real call site. */
export interface ReviewIssueRow {
    id: string;
    targetType: string;
    targetKey: string;
    version: number;
    reasonCodes: string;
    reasonHash: string;
    displayDetails: string | null;
    acknowledgedCodes: string;
    acknowledgedAt: Date | null;
    firstObservedAt: Date;
    clearedAt: Date | null;
    currentGeneration: number;
}

export interface ReviewIssueLifecycleClient {
    reviewIssue: {
        findUnique(args: {
            where: { targetType_targetKey: { targetType: string; targetKey: string } } | { id: string };
        }): Promise<ReviewIssueRow | null>;
        create(args: { data: Record<string, unknown> }): Promise<ReviewIssueRow>;
        updateMany(args: {
            where: { id: string; version: number } & Record<string, unknown>;
            data: Record<string, unknown>;
        }): Promise<{ count: number }>;
    };
    reviewAlertEpisode: {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
        updateMany(args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }): Promise<{ count: number }>;
    };
    $transaction<T>(fn: (tx: ReviewIssueLifecycleClient) => Promise<T>): Promise<T>;
}

function toState(row: ReviewIssueRow): ReviewIssueState {
    return {
        id: row.id,
        version: row.version,
        reasonHash: row.reasonHash,
        acknowledgedCodes: decodeReasonCodes(row.acknowledgedCodes),
        clearedAt: row.clearedAt,
        currentGeneration: row.currentGeneration,
        displayDetails: row.displayDetails,
    };
}

/** Episode statuses still eligible to send — cancelled (issue cleared) or
 * superseded (a newer generation opened) out from under any of these. */
const OPEN_EPISODE_STATUSES = ["PENDING", "CLAIMED", "BATCHED", "FAILED"];

class VersionConflict extends Error {}

/** Prisma's unique-constraint violation code (P2002). Duck-typed rather than
 * importing `Prisma.PrismaClientKnownRequestError` — this module's client
 * type is a hand-typed subset (same convention as everywhere else here) so
 * tests can throw a plain `{code:"P2002"}` object without pulling in the
 * real Prisma error class. */
function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

const MAX_VERSION_RETRIES = 5;

export interface EvaluateReviewIssueOptions {
    /** Episode status a NEW episode opens at. Default "PENDING" (real alert).
     * The rollout baseline sweep passes "SUPPRESSED" so the existing backlog
     * never actually sends (plan §4 "Rollout"). */
    episodeStatus?: "PENDING" | "SUPPRESSED";
    now?(): Date;
    client?: ReviewIssueLifecycleClient;
    /** Called instead of reusing the caller's original `currentCodes` on
     * every RETRY attempt after the first (finding 6): a version conflict
     * means another evaluator committed a change to this exact row between
     * our read and our write, so blindly reapplying the STALE snapshot risks
     * overwriting a NEWER clear/change with older data. Optional — a caller
     * with no cheap way to recompute (or that intentionally wants to apply a
     * fixed snapshot regardless of races) can omit it and every retry reuses
     * `currentCodes` as before. */
    recomputeCodes?(): Promise<ReasonCode[]>;
}

export interface EvaluateReviewIssueResult {
    decision: LifecycleDecision;
    /** True when a write happened. False for "noop" (always a no-op) and for
     * "touch" when displayDetails was ALSO unchanged (genuinely nothing to
     * write) — true for "touch" when displayDetails drifted and got a
     * display-only update (finding 9; no new generation/episode either way). */
    applied: boolean;
}

/**
 * Evaluate one target against its current reason codes and apply whichever
 * of the six lifecycle steps matches, inside one short transaction guarded by
 * optimistic concurrency. On a version conflict (another evaluator committed
 * between our read and our write) the WHOLE evaluation retries — re-read,
 * re-decide, re-apply — up to `MAX_VERSION_RETRIES` times.
 */
export async function evaluateReviewIssue(
    targetType: string,
    targetKey: string,
    currentCodes: ReasonCode[],
    displayDetails: Record<string, unknown> | null,
    options: EvaluateReviewIssueOptions = {},
): Promise<EvaluateReviewIssueResult> {
    const client = options.client ?? (prisma as unknown as ReviewIssueLifecycleClient);
    const now = options.now ?? (() => new Date());
    const episodeStatus = options.episodeStatus ?? "PENDING";
    const displayDetailsJson = displayDetails ? JSON.stringify(displayDetails) : null;

    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
        // Finding 6: every retry past the first re-derives the reason codes
        // from fresh source data (when the caller supplied a way to) instead
        // of blindly reapplying the ORIGINAL snapshot — a version conflict
        // means someone else just committed a change to this exact row, and
        // that change may itself be a newer clear that a stale snapshot
        // would otherwise overwrite.
        const codesForAttempt = attempt === 0 || !options.recomputeCodes ? currentCodes : await options.recomputeCodes();
        const existingRow = await client.reviewIssue.findUnique({
            where: { targetType_targetKey: { targetType, targetKey } },
        });
        const existing = existingRow ? toState(existingRow) : null;
        const decision = decideLifecycle(existing, codesForAttempt);

        let displayOnlyWrite = false;
        try {
            await client.$transaction(async tx => {
                switch (decision.action) {
                    case "noop":
                        return;

                    case "touch": {
                        // Reason codes are unchanged, so no new
                        // generation/episode opens (step 5) — but
                        // displayDetails (amounts/vendor/date) is deliberately
                        // NOT part of the hash and can still legitimately
                        // drift (a corrected receipt total, a renamed
                        // vendor). Finding 9: doing nothing here meant a
                        // corrected number never reached the dashboard for an
                        // issue whose reason never changes. Update ONLY
                        // displayDetails, still version-guarded, WITHOUT
                        // opening a new generation or touching any episode —
                        // episode snapshots stay immutable.
                        if (existing!.displayDetails === displayDetailsJson) return; // genuinely nothing changed — no write at all
                        const updated = await tx.reviewIssue.updateMany({
                            where: { id: existing!.id, version: existing!.version },
                            data: { displayDetails: displayDetailsJson, version: { increment: 1 } },
                        });
                        if (updated.count === 0) throw new VersionConflict();
                        displayOnlyWrite = true;
                        return;
                    }

                    case "clear": {
                        const updated = await tx.reviewIssue.updateMany({
                            where: { id: existing!.id, version: existing!.version },
                            data: {
                                clearedAt: now(),
                                acknowledgedCodes: "[]",
                                acknowledgedAt: null,
                                version: { increment: 1 },
                            },
                        });
                        if (updated.count === 0) throw new VersionConflict();
                        await tx.reviewAlertEpisode.updateMany({
                            where: { issueId: existing!.id, status: { in: OPEN_EPISODE_STATUSES } },
                            data: { status: "CANCELLED" },
                        });
                        return;
                    }

                    case "create": {
                        let issue: ReviewIssueRow;
                        try {
                            issue = await tx.reviewIssue.create({
                                data: {
                                    targetType,
                                    targetKey,
                                    reasonCodes: encodeReasonCodes(decision.canonicalCodes),
                                    reasonHash: decision.reasonHash,
                                    displayDetails: displayDetailsJson,
                                    acknowledgedCodes: "[]",
                                    firstObservedAt: now(),
                                    currentGeneration: decision.openGeneration!,
                                    version: 1,
                                },
                            });
                        } catch (error) {
                            // Finding 6: two concurrent evaluators can both
                            // read "no issue exists" and both decide
                            // "create" — the loser hits the
                            // @@unique([targetType, targetKey]) constraint
                            // (P2002), not a version conflict, because there
                            // was no row to version-guard against yet.
                            // Treat it exactly like one: retry the WHOLE
                            // evaluation, which will find the winner's row on
                            // re-read and route through steps 4/5/6 instead.
                            if (isUniqueConstraintError(error)) throw new VersionConflict();
                            throw error;
                        }
                        await tx.reviewAlertEpisode.create({
                            data: {
                                issueId: issue.id,
                                generation: decision.openGeneration!,
                                reasonCodes: encodeReasonCodes(decision.canonicalCodes),
                                reasonHash: decision.reasonHash,
                                displayDetails: displayDetailsJson,
                                status: episodeStatus,
                            },
                        });
                        return;
                    }

                    case "reopen": {
                        const updated = await tx.reviewIssue.updateMany({
                            where: { id: existing!.id, version: existing!.version },
                            data: {
                                clearedAt: null,
                                reasonCodes: encodeReasonCodes(decision.canonicalCodes),
                                reasonHash: decision.reasonHash,
                                displayDetails: displayDetailsJson,
                                firstObservedAt: now(),
                                currentGeneration: decision.openGeneration!,
                                version: { increment: 1 },
                            },
                        });
                        if (updated.count === 0) throw new VersionConflict();
                        await tx.reviewAlertEpisode.create({
                            data: {
                                issueId: existing!.id,
                                generation: decision.openGeneration!,
                                reasonCodes: encodeReasonCodes(decision.canonicalCodes),
                                reasonHash: decision.reasonHash,
                                displayDetails: displayDetailsJson,
                                status: episodeStatus,
                            },
                        });
                        return;
                    }

                    case "suppress": {
                        const updated = await tx.reviewIssue.updateMany({
                            where: { id: existing!.id, version: existing!.version },
                            data: {
                                reasonCodes: encodeReasonCodes(decision.canonicalCodes),
                                reasonHash: decision.reasonHash,
                                displayDetails: displayDetailsJson,
                                version: { increment: 1 },
                            },
                        });
                        if (updated.count === 0) throw new VersionConflict();
                        return;
                    }

                    case "supersede": {
                        const updated = await tx.reviewIssue.updateMany({
                            where: { id: existing!.id, version: existing!.version },
                            data: {
                                reasonCodes: encodeReasonCodes(decision.canonicalCodes),
                                reasonHash: decision.reasonHash,
                                displayDetails: displayDetailsJson,
                                currentGeneration: decision.openGeneration!,
                                version: { increment: 1 },
                            },
                        });
                        if (updated.count === 0) throw new VersionConflict();
                        // Best-effort: mark the previously-open episode superseded
                        // ONLY if it hasn't already sent. Punch 2 (CLAIMED
                        // semantics): a claim already crossing the network to
                        // Chat cannot be cancelled — this can race with the
                        // drainer's own claimToken-fenced completion write and
                        // lose (the completion write doesn't check status, only
                        // claimToken). That's accepted: the new generation below
                        // is enqueued regardless, so the correct alert always
                        // goes out even if a stale one also lands.
                        await tx.reviewAlertEpisode.updateMany({
                            where: {
                                issueId: existing!.id,
                                generation: existing!.currentGeneration,
                                status: { in: OPEN_EPISODE_STATUSES },
                            },
                            data: { status: "SUPERSEDED" },
                        });
                        await tx.reviewAlertEpisode.create({
                            data: {
                                issueId: existing!.id,
                                generation: decision.openGeneration!,
                                reasonCodes: encodeReasonCodes(decision.canonicalCodes),
                                reasonHash: decision.reasonHash,
                                displayDetails: displayDetailsJson,
                                status: episodeStatus,
                            },
                        });
                        return;
                    }
                }
            });
            return {
                decision,
                applied: (decision.action !== "noop" && decision.action !== "touch") || displayOnlyWrite,
            };
        } catch (error) {
            if (error instanceof VersionConflict) continue;
            throw error;
        }
    }
    throw new Error(
        `evaluateReviewIssue: exceeded ${MAX_VERSION_RETRIES} version-conflict retries for ${targetType}:${targetKey}`,
    );
}

// ── Mark reviewed ─────────────────────────────────────────────────────────────

export class StaleMarkReviewedError extends Error {
    constructor() {
        super("Review issue changed since it was loaded — refetch and try again.");
        this.name = "StaleMarkReviewedError";
    }
}

/**
 * Acknowledge the CURRENT reason codes on an issue. Conditionally updates by
 * `{id, version, reasonHash, clearedAt: null}` (plan §4 B) so a stale request
 * — one built from a reason set the server has since cleared or changed —
 * cannot repopulate `acknowledgedCodes`/`acknowledgedAt` after the issue
 * moved on. `reasonHash`/`clearedAt` are redundant with `version` alone
 * winning that race in practice (every lifecycle write bumps version), but
 * are included explicitly (finding 7) so the predicate is correct on its own
 * terms rather than relying on that invariant holding forever. Ack is
 * additive/monotonic within one open "episode of failure": acknowledging
 * again after a code was already acknowledged is a no-op union, and the
 * lifecycle clears the whole ack set the moment the issue clears (step 1).
 *
 * Finding 7: also fences the currently-open episode. Without this, an issue
 * could be acknowledged here while its already-created PENDING/CLAIMED/
 * BATCHED/FAILED episode for the current generation sat untouched — the next
 * drain run would still deliver a Chat card for a card the user just marked
 * reviewed. Suppressing it is transactional with the ack write. A CLAIMED
 * episode already crossing the network cannot be recalled (same accepted
 * race as evaluateReviewIssue's supersede branch, punch 2) — but its
 * DATABASE completion is separately fenced by `status: "CLAIMED"` in the
 * outbox's own completion predicate (finding 2), so flipping it to
 * SUPPRESSED here cannot be resurrected by a late failure completion either.
 */
export async function markReviewed(
    input: { id: string; version: number; reasonHash: string },
    client: ReviewIssueLifecycleClient = prisma as unknown as ReviewIssueLifecycleClient,
    now: () => Date = () => new Date(),
): Promise<{ ok: true } | { ok: false; reason: "conflict" | "not-found" }> {
    const row = await client.reviewIssue.findUnique({ where: { id: input.id } });
    if (!row) return { ok: false, reason: "not-found" };
    if (row.version !== input.version || row.reasonHash !== input.reasonHash || row.clearedAt !== null) {
        return { ok: false, reason: "conflict" };
    }

    const currentCodes = decodeReasonCodes(row.reasonCodes);
    const existingAck = decodeReasonCodes(row.acknowledgedCodes);
    const nextAck = canonicalizeReasonCodes([...existingAck, ...currentCodes]);

    const updated = await client.$transaction(async tx => {
        const result = await tx.reviewIssue.updateMany({
            where: { id: input.id, version: input.version, reasonHash: input.reasonHash, clearedAt: null },
            data: {
                acknowledgedCodes: encodeReasonCodes(nextAck),
                acknowledgedAt: now(),
                version: { increment: 1 },
            },
        });
        if (result.count === 0) return result;
        await tx.reviewAlertEpisode.updateMany({
            where: { issueId: input.id, generation: row.currentGeneration, status: { in: OPEN_EPISODE_STATUSES } },
            data: { status: "SUPPRESSED" },
        });
        return result;
    });
    if (updated.count === 0) return { ok: false, reason: "conflict" };
    return { ok: true };
}
