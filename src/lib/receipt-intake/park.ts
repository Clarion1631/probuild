/**
 * The rule for parking a receipt by hand (VOID / DUPLICATE), and the one thing
 * that rule must never get wrong: WHO KEEPS THE STRONG DEDUP KEY.
 *
 * `sendAttempted` is written the instant before the QuickBooks create. A park
 * BEFORE it provably created no Purchase, so the key goes back and a corrected
 * re-send of the same document books normally. A park AFTER it must KEEP the
 * key: QuickBooks may hold a Purchase whose response we never saw, and
 * releasing the key would let the same receipt book a second time — real money,
 * twice, with nothing on either row to say so.
 *
 * That is why the release branch CASes on `sendAttempted: false` rather than
 * reading the flag first and choosing. A read-then-write loses the race it
 * exists to guard: the worker can set `sendAttempted` in the gap, and the
 * update would then clear the key having decided from a value that was already
 * stale. The state transition itself must still succeed either way — the human
 * voided it, and that decision stands — so a lost release CASes again, keeps
 * the key, and marks the row so the Receipts tab shows it under Exceptions.
 *
 * PURE. No Prisma, no clock: it returns the two writes, in order, and the
 * caller runs them. That is what makes the branch testable without a database.
 */

/** Marks a parked row whose send had already started. Read by the Receipts tab. */
export const POSSIBLE_ORPHAN_REASON = "possible-orphan-purchase";

export interface ParkWrite {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
}

export interface ParkPlan {
    /** Tried first: parks the row AND hands the strong key back. */
    release: ParkWrite;
    /** Tried only if `release` matched nothing: parks the row, KEEPS the key. */
    keep: ParkWrite;
}

export interface ParkInput {
    id: string;
    /** The exact state the human's view was showing. */
    expectedState: string;
    /** VOID or DUPLICATE. */
    targetState: string;
    /** The reason recorded on a clean park. */
    stateReason: string;
    /** Anything else the transition writes (e.g. `duplicateOfId`). */
    extraData?: Record<string, unknown>;
    /** The worker-claim fence, built by the caller (it owns the clock). */
    claimFence: Record<string, unknown>;
}

export function planParkWrites(input: ParkInput): ParkPlan {
    const base = {
        state: input.targetState,
        nextRetryAt: null,
        // AN EXPIRED CLAIM IS RELEASED BY THE PARK ITSELF, in the same write.
        //
        // The claim fence lets a park through when the worker's lease has run
        // out — the row is nobody's — but it used to leave the dead token and
        // timestamp sitting on the row. Everything downstream that asks "is
        // anyone holding this?" then reads a claim that will never be released:
        // most visibly `resolveUnknownOrphan`, whose predicate requires
        // `claimToken: null`, so the orphan it just created could never be
        // resolved. Parking IS finishing with the row, so ownership goes back
        // here exactly as it does on the worker's own terminal transitions.
        claimToken: null,
        claimedAt: null,
        ...(input.extraData ?? {}),
    };
    const where = { id: input.id, state: input.expectedState, ...input.claimFence };
    return {
        release: {
            // `sendAttempted: false` is part of the CAS, not a precondition read
            // beforehand — see the module comment.
            where: { ...where, sendAttempted: false },
            data: { ...base, stateReason: input.stateReason, dedupStrongKey: null },
        },
        keep: {
            where: { ...where, sendAttempted: true },
            // NO `dedupStrongKey: null` here. That absence is the whole point of
            // this file.
            data: { ...base, stateReason: `${input.stateReason}:${POSSIBLE_ORPHAN_REASON}` },
        },
    };
}

/** True when a row's `stateReason` marks it as a possible orphaned Purchase. */
export function isPossibleOrphanReason(stateReason: string | null | undefined): boolean {
    return typeof stateReason === "string" && stateReason.endsWith(`:${POSSIBLE_ORPHAN_REASON}`);
}

/**
 * The states an UNKNOWN-ID orphan can legitimately be sitting in.
 *
 * The `:possible-orphan-purchase` suffix is written by exactly one place — the
 * keep branch above — and that branch only ever targets VOID or DUPLICATE. So
 * these two are the whole permitted set, and a BOOKED or ARCHIVED row is not an
 * orphan under any circumstances: it booked, it has its Purchase id, and
 * touching it from the orphan path would rewrite money history.
 */
export const UNKNOWN_ORPHAN_STATES: readonly string[] = ["VOID", "DUPLICATE"];
