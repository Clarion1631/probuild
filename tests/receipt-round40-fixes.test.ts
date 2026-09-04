import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    duplicateChainReason,
    duplicateChainRefusal,
    withEvidenceAndChainLocks,
} from "../src/lib/receipt-intake/duplicate-guard";
import {
    CARD_RESEND_QUEUED_REASON,
    CARD_RESEND_STALE_HOURS,
} from "../src/lib/receipt-request-cards";
import { evaluatePipelineHealth, formatPipelineDigest, type PipelineHealth } from "../src/lib/pipeline-health";
import { MEMO_SIGNED_RESOLUTION, hasBackedResolution, hasResolution } from "../src/lib/receipt-requests";

/**
 * Codex PR #443, adversarial gate round 40.
 *
 *  1. THE WORKER COULD STILL BUILD A DUPLICATE CHAIN. Round 39 gave it a
 *     locked-looking check and an unlocked one: it READ the inbound references
 *     and then transitioned in a separate statement, so an admin committing
 *     A→B in between got exactly the chain the guard exists to prevent — from
 *     the one caller that runs unattended every five minutes.
 *  2. "RESEND" COULD STRAND A CARD FOR EVER. It puts an UNCERTAIN row back to
 *     PENDING, and the cron only ever looked up TODAY's (owner, pacificDate) —
 *     so a resend requested after the day's last retry slot was never claimed
 *     again, and tomorrow built a different date's card while the operator's
 *     decision sat unexecuted.
 *  3. AN UNBACKED `memo-signed` STILL SUPPRESSED CARD DELIVERY. The cards cron
 *     asked `hasResolution`, which is true for a memo with no artifact row, and
 *     that skipped the artifact-backed recompute the comment above it claimed
 *     would catch exactly this — so the item left the card and the charge was
 *     never chased again.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. Check and transition are ONE transaction, for every caller ───────────

interface FakeRow { id: string; duplicateOfId: string | null; state: string }

/**
 * An in-memory ReceiptIntake with the two properties the guard leans on: the
 * lock statement it expects, and transactions that take turns.
 */
function fakeIntake(rows: FakeRow[]) {
    let held: Promise<void> = Promise.resolve();
    /** What each transaction locked, in the order it asked for it. */
    let lockOrder: string[] = [];
    const client = {
        // The evidence advisory lock (round-43 gate, finding 3). Recorded rather
        // than ignored, because the ORDER is the whole fix: this lock has to be
        // taken before any row lock, in every caller, or it deadlocks against
        // the sweep, which takes it first and then locks rows.
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            assert.match(sql, /pg_advisory_xact_lock\(hashtext\(/, "the only raw command here is the evidence lock");
            lockOrder.push(`advisory:${values.join(",")}`);
            return 1;
        },
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            // The evidence-epoch bump also runs raw (round-43 gate, finding 4).
            // It is a WRITE, not a lock, so it is recorded and returned before
            // the FOR UPDATE assertion below, which is about the ROW lock.
            if (/AutomationSetting/.test(sql)) {
                lockOrder.push("evidence-epoch");
                return [{ value: "1" }];
            }
            assert.match(sql, /FOR UPDATE/, "the guard must LOCK");
            lockOrder.push("rows");
            const ids = values.map(String);
            return rows
                .filter(row => ids.includes(row.id) || (row.duplicateOfId !== null && ids.includes(row.duplicateOfId)))
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .map(row => ({ id: row.id, duplicateOfId: row.duplicateOfId }));
        },
        receiptIntake: {
            updateMany: async ({ where, data }: { where: { id: string; state?: string }; data: Record<string, unknown> }) => {
                const row = rows.find(r => r.id === where.id && (where.state === undefined || r.state === where.state));
                if (!row) return { count: 0 };
                if (typeof data.state === "string") row.state = data.state;
                if (data.duplicateOfId !== undefined) row.duplicateOfId = (data.duplicateOfId as string | null);
                return { count: 1 };
            },
        },
    };
    return {
        rows,
        get lockOrder() { return lockOrder; },
        resetLockOrder() { lockOrder = []; },
        /** One transaction at a time — what FOR UPDATE buys the caller. */
        transaction: async <T>(fn: (tx: typeof client) => Promise<T>): Promise<T> => {
            const previous = held;
            let release!: () => void;
            held = new Promise<void>(resolve => { release = resolve; });
            await previous;
            try {
                return await fn(client);
            } finally {
                release();
            }
        },
    };
}

/** The worker's transition, exactly as the cron implements it. */
async function workerTransition(table: ReturnType<typeof fakeIntake>, rowId: string, duplicateOfId: string) {
    return withEvidenceAndChainLocks(
        fn => table.transaction(fn as never) as never,
        [rowId],
        async (tx, inboundById) => {
            const inbound = inboundById.get(rowId) ?? [];
            const state = inbound.length === 0 ? "DUPLICATE" : "NEEDS_REVIEW";
            const { count } = await tx.receiptIntake.updateMany({
                where: { id: rowId, state: "RECEIVED" },
                data: { state, stateReason: inbound.length === 0 ? null : duplicateChainReason(inbound), duplicateOfId },
            });
            return { owned: count > 0, state };
        },
    );
}

/** The admin action's mark, through the same shared lock. */
async function adminMark(table: ReturnType<typeof fakeIntake>, id: string, duplicateOfId: string) {
    return withEvidenceAndChainLocks(
        fn => table.transaction(fn as never) as never,
        [id, duplicateOfId],
        async (tx, inbound) => {
            const blocking = inbound.get(id) ?? [];
            if (blocking.length > 0) throw duplicateChainRefusal("duplicate", blocking);
            await tx.receiptIntake.updateMany({ where: { id }, data: { state: "DUPLICATE", duplicateOfId } });
            return "marked";
        },
    );
}

test("WORKER vs ADMIN: the admin marks A→B while the worker routes B→C — no chain, either order", async () => {
    for (const order of ["admin-first", "worker-first"] as const) {
        const table = fakeIntake([
            { id: "a", duplicateOfId: null, state: "READ" },
            { id: "b", duplicateOfId: null, state: "RECEIVED" },
            { id: "c", duplicateOfId: null, state: "READ" },
        ]);
        const refusals: string[] = [];

        const admin = (async () => {
            try {
                await adminMark(table, "a", "b");
            } catch (error) {
                refusals.push((error as Error).message);
            }
        })();
        const worker = workerTransition(table, "b", "c");
        let workerOutcome: { owned: boolean; state: string };
        if (order === "admin-first") {
            await admin;
            workerOutcome = await worker;
        } else {
            workerOutcome = await worker;
            await admin;
        }

        const a = table.rows.find(r => r.id === "a")!;
        const b = table.rows.find(r => r.id === "b")!;
        // Whichever went first, the loser must SEE the winner's write: either
        // the worker parks NEEDS_REVIEW because A is filed behind B, or the
        // admin is refused because B has become a duplicate itself.
        const chained = a.duplicateOfId === "b" && b.duplicateOfId !== null && b.state === "DUPLICATE";
        assert.equal(chained, false, `${order}: A→B→C is the chain this guard exists to prevent`);
        if (a.duplicateOfId === "b") {
            assert.equal(
                workerOutcome.state, "NEEDS_REVIEW",
                `${order}: the worker saw the admin's reference and asked a human`,
            );
        }
    }
});

test("PRE-FIX CONTROL: an unlocked read then a separate write builds the chain", async () => {
    // Round 39's worker shape: ask, then act. The admin's write lands in the
    // window between, and nothing notices.
    const table = fakeIntake([
        { id: "a", duplicateOfId: null, state: "READ" },
        { id: "b", duplicateOfId: null, state: "RECEIVED" },
        { id: "c", duplicateOfId: null, state: "READ" },
    ]);
    const inboundAtCheck = table.rows.filter(r => r.duplicateOfId === "b").map(r => r.id);
    // ...admin commits A→B here...
    table.rows.find(r => r.id === "a")!.duplicateOfId = "b";
    // ...and the worker acts on what it read a moment ago.
    if (inboundAtCheck.length === 0) {
        const b = table.rows.find(r => r.id === "b")!;
        b.state = "DUPLICATE";
        b.duplicateOfId = "c";
    }
    assert.equal(table.rows.find(r => r.id === "b")!.duplicateOfId, "c");
    assert.equal(table.rows.find(r => r.id === "a")!.duplicateOfId, "b", "A→B→C — exactly the bug");
});

test("EVERY caller takes the evidence lock BEFORE any row lock", async () => {
    /**
     * The order, measured rather than read (Codex PR #443 gate round 43,
     * finding 3). Before the wrapper existed, two of the three callers took the
     * evidence lock inside the body — so the FOR UPDATE came first, the exact
     * inversion of the sweep, which takes the evidence lock and then locks
     * rows. Two transactions, opposite orders, a real deadlock.
     */
    const table = fakeIntake([
        { id: "a", duplicateOfId: null, state: "RECEIVED" },
        { id: "b", duplicateOfId: null, state: "RECEIVED" },
    ]);

    table.resetLockOrder();
    await workerTransition(table, "a", "b");
    assert.deepEqual(table.lockOrder, ["advisory:receipt-evidence", "evidence-epoch", "rows"],
        "the worker: evidence lock, then rows");

    // A FRESH table: the transition above made "b" somebody's original, which
    // the admin path would (correctly) refuse.
    const other = fakeIntake([
        { id: "c", duplicateOfId: null, state: "RECEIVED" },
        { id: "d", duplicateOfId: null, state: "RECEIVED" },
    ]);
    await adminMark(other, "c", "d");
    assert.deepEqual(other.lockOrder, ["advisory:receipt-evidence", "evidence-epoch", "rows"],
        "and the admin action, in the same order — there is only one wrapper");
});

test("both callers take the SAME function, so they cannot diverge", () => {
    const guard = readFileSync(join(repoRoot, "src/lib/receipt-intake/duplicate-guard.ts"), "utf8");
    assert.match(guard, /export async function withEvidenceAndChainLocks<T>\(/);
    assert.match(
        guard,
        /await lockReceiptEvidence\(tx\);[\s\S]{0,400}?await bumpReceiptEvidenceEpoch\(tx\);\s+return body\(tx, await lockWithInboundDuplicates\(tx, ids\)\);/,
        "evidence lock first, then the epoch bump, then the row locks — one order, owned by the wrapper",
    );
    // And there is no way in that skips it: the chain-lock-only entry point is
    // gone, so a caller cannot take row locks without the evidence lock.
    assert.doesNotMatch(guard, /export async function withDuplicateChainLock/);

    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.equal((actions.match(/withEvidenceAndChainLocks\(fn => prisma\.\$transaction\(fn\)/g) ?? []).length, 2,
        "mark and void both go through it");
    assert.doesNotMatch(actions, /lockWithInboundDuplicates\(tx,/, "and neither hand-rolls the lock any more");
    // Nor takes the evidence lock inside the body, which is what put the row
    // locks first and inverted the order against the sweep.
    assert.doesNotMatch(actions, /withEvidenceAndChainLocks\([\s\S]{0,400}?await lockReceiptEvidence\(tx\)/);

    const cron = readFileSync(join(repoRoot, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    assert.match(cron, /applyDuplicateTransition: async \(rowId, decision, patch, ownership\) => withEvidenceAndChainLocks\(/);
    assert.match(cron, /where: \{ id: rowId, state: ownership\.state, claimToken: ownership\.claimToken \}/,
        "the CAS runs inside the transaction that took the lock");
    assert.doesNotMatch(cron, /findInboundDuplicates/, "the unlocked read is gone");

    const worker = readFileSync(join(repoRoot, "src/lib/receipt-intake/worker.ts"), "utf8");
    assert.match(worker, /async function applyRoutedState\(/);
    assert.equal((worker.match(/await applyRoutedState\(/g) ?? []).length, 3, "all three routing outcomes");
    assert.doesNotMatch(worker, /guardDuplicateChain/, "the two-step version is gone");
});

// ── 2. A queued resend is drained whatever date it is for ──────────────────

test("the cron drains queued resends by their own date, oldest first and bounded", () => {
    const cron = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    // The query: PENDING, unposted, carrying the marker, for a date BEFORE
    // today — the rows today's (owner, pacificDate) lookup can never reach.
    // Raw SQL since round 44 (finding 3): the per-owner reduction is DISTINCT
    // ON, which Prisma cannot express, so the same predicate is written out.
    assert.match(
        cron,
        /SELECT DISTINCT ON \("owner"\)[\s\S]{0,900}?"status" = 'PENDING'[\s\S]{0,400}?"resendQueuedAt" IS NOT NULL[\s\S]{0,300}?"pacificDate" < \$\{date}/,
    );
    assert.match(cron, /ORDER BY "resendQueuedAt" ASC, "pacificDate" ASC, "owner" ASC[\s\S]{0,80}LIMIT \$\{QUEUED_RESEND_DRAIN_LIMIT}/,
        "oldest first, and bounded so a backlog cannot crowd out today");
    // AND the cap comes AFTER the per-owner reduction (round-44 gate, finding
    // 3) — capping first is what starved the fourth owner.
    const distinctAt = cron.indexOf('SELECT DISTINCT ON ("owner")');
    const capAt = cron.indexOf("LIMIT ${QUEUED_RESEND_DRAIN_LIMIT}", distinctAt);
    assert.ok(distinctAt > 0 && capAt > distinctAt, "one row per owner first, then the global cap");
    // Posted under ITS OWN date, so the request id — and the Chat thread —
    // stay the ones the operator was looking at.
    assert.match(cron, /buildCardFromItems\(row\.owner, row\.pacificDate, items, row\.overflow, row\.overflowExact\)/);
    assert.match(cron, /queuedDrained\.push\(/, "and the run reports what it picked up");

    // The claim is the same CAS every other path uses: unposted, unclaimed or
    // lease-expired.
    assert.match(cron, /id: row\.id,\s*postedAt: null,\s*status: "PENDING",\s*OR: \[\{ claimedAt: null \}/);

    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(actions, /lastError: CARD_RESEND_QUEUED_REASON,/, "and resend writes the marker the drain looks for");
    assert.equal(CARD_RESEND_QUEUED_REASON, "resend-requested");
});

test("PRE-FIX CONTROL: a resend after the last slot is unreachable by date alone", () => {
    // The old cron only ever asked for today's (owner, pacificDate). A row
    // queued for yesterday matches no lookup it makes — which is why the drain
    // has to key on the marker instead.
    const today = "2026-09-03";
    const queuedRow = { owner: "CJ", pacificDate: "2026-09-02", status: "PENDING", lastError: CARD_RESEND_QUEUED_REASON };
    const todaysLookupMatches = queuedRow.pacificDate === today;
    assert.equal(todaysLookupMatches, false, "never claimed again, for ever");
    const drainMatches = queuedRow.status === "PENDING"
        && queuedRow.lastError === CARD_RESEND_QUEUED_REASON
        && queuedRow.pacificDate < today;
    assert.equal(drainMatches, true, "the marker is what makes it reachable");
});

test("a stale queued card is reported, a fresh one is not", () => {
    // The reason string, straight from the evaluator.
    const now = Date.parse("2026-09-03T14:00:00.000Z");
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const input = {
        intuit: { status: "ok" as const, indicator: "none" },
        lastPurchaseSync: { status: "ok" as const, at: iso(2 * 3_600_000) },
        purchaseSyncRun: { status: "ok" as const, at: iso(2 * 3_600_000), runStatus: "ok" as const },
        lastReceiptPush: { status: "ok" as const, at: iso(3 * 3_600_000) },
        lastPaymentsSync: { status: "ok" as const, at: iso(3_600_000) },
        receipts24h: { status: "ok" as const, counts: { created: 4 } },
        bank: { status: "ok" as const, at: iso(48 * 3_600_000) },
        stuck: { status: "ok" as const, count: 0 },
        intakeStuck: { status: "ok" as const, count: 0 },
        intakeNeedsReview: { status: "ok" as const, count: 0 },
        intakeUnassigned: { status: "ok" as const, count: 0 },
        uncertainCards: { status: "ok" as const, count: 0 },
        driveCredentials: { status: "ok" as const, configured: true, source: "company-settings" },
        chaser: { status: "ok" as const, phase: "done", completedAt: iso(3_600_000) },
        bankPull: { status: "ok" as const, enabled: false, lastSuccessAt: null, ambiguousCount: 0 },
        // Required since the Phase 0/5 probes landed on main.
        payLinksPending: { status: "ok" as const, count: 0 },
        now,
    } as unknown as Parameters<typeof evaluatePipelineHealth>[0];

    const quiet = evaluatePipelineHealth({ ...input, queuedCards: { status: "ok", count: 0 } });
    assert.equal(quiet.reasons.includes("cards-queued-stale:0"), false);

    const stale = evaluatePipelineHealth({ ...input, queuedCards: { status: "ok", count: 2 } });
    assert.ok(stale.reasons.includes("cards-queued-stale:2"), `expected the stale count, saw ${stale.reasons.join(",")}`);
    assert.equal(stale.ok, false);

    // A probe that could not run is reported as a probe failure, not as zero.
    const broken = evaluatePipelineHealth({ ...input, queuedCards: { status: "error", count: 0 } });
    assert.ok(broken.reasons.includes("probe-failed:queuedCards"));

    // And callers written before the probe existed still evaluate.
    assert.equal(evaluatePipelineHealth(input).reasons.includes("probe-failed:queuedCards"), false);

    const health = readFileSync(join(repoRoot, "src/lib/pipeline-health.ts"), "utf8");
    assert.match(
        health,
        /resendQueuedAt: \{ not: null, lt: new Date\(now - CARD_RESEND_STALE_HOURS \* HOUR_MS\) \}/,
        "the probe counts only the ones that have waited too long");
    assert.equal(CARD_RESEND_STALE_HOURS, 6);
});

test("the digest prints the queued-resend line", () => {
    const health = {
        ok: false,
        reasons: ["cards-queued-stale:2"],
        checkedAt: "2026-09-03T14:00:00.000Z",
        intuit: { status: "ok", indicator: "none", description: "All Systems Operational" },
        qbo: {
            lastPurchaseSync: { status: "ok", at: "2026-09-03T10:00:00.000Z" },
            purchaseSyncRun: { status: "ok", at: "2026-09-03T10:05:00.000Z", runStatus: "ok" },
            lastReceiptPush: { status: "ok", at: "2026-09-03T12:00:00.000Z" },
            lastPaymentsSync: { status: "ok", at: "2026-09-03T13:00:00.000Z" },
        },
        receipts24h: { status: "ok", counts: { created: 4 } },
        bank: { status: "ok", at: "2026-08-29T00:00:00.000Z" },
        stuck: { status: "ok", count: 0 },
        intake: {
            stuck: { status: "ok", count: 0 },
            needsReview: { status: "ok", count: 0 },
            unassigned: { status: "ok", count: 0 },
        },
        uncertainCards: { status: "ok", count: 0 },
        queuedCards: { status: "ok", count: 2 },
    } as unknown as PipelineHealth;
    const { text } = formatPipelineDigest(health);
    assert.match(text, /Cards queued for resend >6h: 2/);
});

// ── 3. An unbacked memo cannot silence a card ──────────────────────────────

test("the card cron's resolved check is artifact-backed, and the bindings are loaded for it", () => {
    const cron = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(cron, /const resolved = hasBackedResolution\(details, boundPdfIds\.get\(row\.targetKey\) \?\? null\);/);
    assert.match(
        cron,
        /const boundPdfIds = new Map\([\s\S]{0,400}prisma\.receiptMemoArtifact\.findMany\(\{[\s\S]{0,300}targetKey: \{ in: rows\.map\(row => row\.targetKey\) \}/,
        "one binding read per card, for exactly the items on it",
    );

    // The behaviour, in the two shapes that matter: an unbacked memo must NOT
    // read as resolved (so the recompute runs and the item stays on the card),
    // and a backed one must.
    const unbacked = { resolution: MEMO_SIGNED_RESOLUTION, pdfId: "pdf-1" };
    assert.equal(hasBackedResolution(unbacked, null), false, "nothing vouches for it");
    assert.equal(hasBackedResolution(unbacked, "pdf-1"), true);

    // PRE-FIX CONTROL: the check that used to sit there.
    assert.equal(hasResolution(unbacked), true, "which is exactly why the item was dropped from the card");
});

test("TRIPWIRE: no bare hasResolution() in the cards cron or the answers route", () => {
    /**
     * Both files decide whether somebody is asked for a receipt, or whether a
     * memo closes a chase. A bare blob check there is the fail-open this gate
     * has now closed twice (round 36 in the matcher, round 40 in the cards
     * cron), so every remaining call has to carry its reason on the line above.
     */
    for (const file of [
        "src/app/api/cron/receipt-request-cards/route.ts",
        "src/app/api/automation/receipt-requests/answers/route.ts",
    ]) {
        const lines = readFileSync(join(repoRoot, file), "utf8").replace(/\r\n/g, "\n").split("\n");
        lines.forEach((line, index) => {
            if (!/\bhasResolution\(/.test(line)) return;
            const preceding = lines.slice(Math.max(0, index - 6), index).join("\n");
            assert.match(
                preceding,
                /hasResolution-justified:/,
                `${file}:${index + 1} calls hasResolution() with no justification — use hasBackedResolution, or say why the blob alone is the right question`,
            );
        });
    }
});
