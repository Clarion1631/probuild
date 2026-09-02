import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    POSSIBLE_ORPHAN_REASON,
    isPossibleOrphanReason,
    planParkWrites,
    type ParkPlan,
} from "../src/lib/receipt-intake/park";

/**
 * A manual park (VOID / mark-duplicate) may only hand the strong dedup key back
 * when the QuickBooks send had NOT started. Getting this wrong books the same
 * receipt twice: the row is voided, the key is released, somebody re-sends the
 * corrected document, and QuickBooks — which may already hold a Purchase from
 * the first attempt whose response we never saw — takes a second one.
 *
 * The row here stands in for the database: `matches` applies a Prisma-shaped
 * `where` to it, so these are tests of the CAS itself and not of a paraphrase
 * of it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEASE_MS = 10 * 60_000;
const NOW = new Date("2026-09-02T18:00:00Z");

interface Row {
    id: string;
    state: string;
    sendAttempted: boolean;
    dedupStrongKey: string | null;
    stateReason: string | null;
    claimedAt: Date | null;
    duplicateOfId?: string | null;
}

function row(over: Partial<Row> = {}): Row {
    return {
        id: "intake-1",
        state: "NEEDS_REVIEW",
        sendAttempted: false,
        dedupStrongKey: "strong:lowes:4600:2026-08-30",
        stateReason: null,
        claimedAt: null,
        ...over,
    };
}

/** The worker-claim fence the actions build (actions.ts `notClaimedByWorker`). */
function claimFence(now: Date) {
    return { OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - LEASE_MS) } }] };
}

/** Apply one Prisma-shaped `where` to a row. Supports exactly what these plans use. */
function matches(where: Record<string, unknown>, target: Row): boolean {
    for (const [field, condition] of Object.entries(where)) {
        if (field === "OR") {
            const branches = condition as Array<Record<string, unknown>>;
            if (!branches.some(branch => matches(branch, target))) return false;
            continue;
        }
        const value = (target as unknown as Record<string, unknown>)[field];
        if (condition !== null && typeof condition === "object") {
            const lt = (condition as { lt?: Date }).lt;
            if (lt !== undefined) {
                if (!(value instanceof Date) || !(value.getTime() < lt.getTime())) return false;
                continue;
            }
            return false;
        }
        if (value !== condition) return false;
    }
    return true;
}

/** What the action does: release first, then keep, then refuse. */
function applyPlan(plan: ParkPlan, target: Row): { applied: "release" | "keep" | null; after: Row } {
    for (const [label, write] of [["release", plan.release], ["keep", plan.keep]] as const) {
        if (!matches(write.where, target)) continue;
        return { applied: label, after: { ...target, ...(write.data as Partial<Row>) } };
    }
    return { applied: null, after: target };
}

function voidPlan(over: { expectedState?: string } = {}): ParkPlan {
    return planParkWrites({
        id: "intake-1",
        expectedState: over.expectedState ?? "NEEDS_REVIEW",
        targetState: "VOID",
        stateReason: "voided-by-user",
        claimFence: claimFence(NOW),
    });
}

test("a park BEFORE the send hands the strong key back", () => {
    const result = applyPlan(voidPlan(), row({ sendAttempted: false }));
    assert.equal(result.applied, "release");
    assert.equal(result.after.state, "VOID");
    assert.equal(result.after.dedupStrongKey, null, "nothing was sent, so nothing is quarantined");
    assert.equal(result.after.stateReason, "voided-by-user");
    assert.equal(isPossibleOrphanReason(result.after.stateReason), false);
});

test("a park AFTER the send keeps the key and flags a possible orphan", () => {
    // The send went out; QuickBooks may hold a Purchase whose response we never
    // saw. Releasing the key here is how the same receipt books twice.
    const before = row({ sendAttempted: true });
    const result = applyPlan(voidPlan(), before);
    assert.equal(result.applied, "keep");
    assert.equal(result.after.state, "VOID", "the human's decision still applies");
    assert.equal(result.after.dedupStrongKey, before.dedupStrongKey, "the key is KEPT");
    assert.equal(result.after.stateReason, `voided-by-user:${POSSIBLE_ORPHAN_REASON}`);
    assert.equal(isPossibleOrphanReason(result.after.stateReason), true);
});

test("the release branch CASes on sendAttempted — it never reads it first", () => {
    // A read-then-write loses the race it exists to guard: the worker can set
    // `sendAttempted` in the gap, and the update would clear the key having
    // decided from a value that was already stale.
    const plan = voidPlan();
    assert.equal(plan.release.where.sendAttempted, false);
    assert.equal(plan.keep.where.sendAttempted, true);
    assert.equal(plan.release.data.dedupStrongKey, null);
    assert.ok(!("dedupStrongKey" in plan.keep.data), "the keep branch must not mention the key at all");
    // Both branches are CASes on the exact state the human saw, and both carry
    // the worker-claim fence.
    assert.equal(plan.release.where.state, "NEEDS_REVIEW");
    assert.equal(plan.keep.where.state, "NEEDS_REVIEW");
    assert.ok(plan.release.where.OR, "claim fence on the release branch");
    assert.ok(plan.keep.where.OR, "claim fence on the keep branch");
});

test("a row the worker is holding is refused by BOTH branches", () => {
    // The stale-claim case. Neither branch may apply: the worker owns the row,
    // it may be mid-send, and the human's view is by definition out of date.
    const claimed = row({ claimedAt: new Date(NOW.getTime() - 60_000) });
    const result = applyPlan(voidPlan(), claimed);
    assert.equal(result.applied, null, "a live claim wins over both writes");
    assert.deepEqual(result.after, claimed, "and nothing at all is written");

    // An EXPIRED claim is not a claim: that row is fair game again.
    const expired = row({ claimedAt: new Date(NOW.getTime() - LEASE_MS - 1_000) });
    assert.equal(applyPlan(voidPlan(), expired).applied, "release");
});

test("a row that moved states is refused by both branches", () => {
    // The exact-state CAS: the page said NEEDS_REVIEW, the row is BOOKING now.
    const moved = row({ state: "BOOKING" });
    assert.equal(applyPlan(voidPlan(), moved).applied, null);
    // ...and the same row IS parkable from the view that actually saw BOOKING.
    assert.equal(applyPlan(voidPlan({ expectedState: "BOOKING" }), moved).applied, "release");
});

test("mark-duplicate follows the identical rule, and still links the original", () => {
    const plan = planParkWrites({
        id: "intake-1",
        expectedState: "NEEDS_REVIEW",
        targetState: "DUPLICATE",
        stateReason: "manual-dup:intake-9",
        extraData: { duplicateOfId: "intake-9" },
        claimFence: claimFence(NOW),
    });
    const clean = applyPlan(plan, row({ sendAttempted: false }));
    assert.equal(clean.applied, "release");
    assert.equal(clean.after.duplicateOfId, "intake-9");
    assert.equal(clean.after.dedupStrongKey, null);

    const sent = applyPlan(plan, row({ sendAttempted: true }));
    assert.equal(sent.applied, "keep");
    assert.equal(sent.after.duplicateOfId, "intake-9", "the link is written either way");
    assert.notEqual(sent.after.dedupStrongKey, null);
    assert.equal(sent.after.stateReason, `manual-dup:intake-9:${POSSIBLE_ORPHAN_REASON}`);
});

test("isPossibleOrphanReason only matches the suffix it owns", () => {
    assert.equal(isPossibleOrphanReason(`voided-by-user:${POSSIBLE_ORPHAN_REASON}`), true);
    assert.equal(isPossibleOrphanReason("voided-by-user"), false);
    assert.equal(isPossibleOrphanReason("booked-after-void"), false);
    assert.equal(isPossibleOrphanReason(POSSIBLE_ORPHAN_REASON), false, "it is a SUFFIX on a reason");
    assert.equal(isPossibleOrphanReason(null), false);
});

test("the queue actions go through the plan, and the tab surfaces the result", () => {
    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    // No unconditional key release survives anywhere in the queue actions.
    assert.doesNotMatch(actions, /dedupStrongKey: null,\s*\n\s*\},\s*\n\s*\}\);\s*\n\s*if \(result\.count === 0\) await receiptIntakeWriteFailure/);
    for (const call of [
        /targetState: "VOID",/,
        /targetState: "DUPLICATE",/,
        /const released = await prisma\.receiptIntake\.updateMany\(plan\.release\);/,
        /const kept = await prisma\.receiptIntake\.updateMany\(plan\.keep\);/,
    ]) {
        assert.match(actions, call);
    }
    // And a kept key is visible: the Exceptions group is where a human finds it.
    const data = readFileSync(join(repoRoot, "src/app/automation/receipts-data.ts"), "utf8");
    assert.match(data, /stateReason: \{ endsWith: `:\$\{POSSIBLE_ORPHAN_REASON\}` \}/);
});
