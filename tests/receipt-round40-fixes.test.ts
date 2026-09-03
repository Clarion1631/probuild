import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    duplicateChainReason,
    duplicateChainRefusal,
    withDuplicateChainLock,
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
    const client = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            assert.match(sql, /FOR UPDATE/, "the guard must LOCK");
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
    return withDuplicateChainLock(
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
    return withDuplicateChainLock(
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

test("both callers take the SAME function, so they cannot diverge", () => {
    const guard = readFileSync(join(repoRoot, "src/lib/receipt-intake/duplicate-guard.ts"), "utf8");
    assert.match(guard, /export async function withDuplicateChainLock<T>\(/);
    assert.match(guard, /return transaction\(async tx => body\(tx, await lockWithInboundDuplicates\(tx, ids\)\)\);/);

    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.equal((actions.match(/withDuplicateChainLock\(fn => prisma\.\$transaction\(fn\)/g) ?? []).length, 2,
        "mark and void both go through it");
    assert.doesNotMatch(actions, /lockWithInboundDuplicates\(tx,/, "and neither hand-rolls the lock any more");

    const cron = readFileSync(join(repoRoot, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    assert.match(cron, /applyDuplicateTransition: async \(rowId, decision, patch, ownership\) => withDuplicateChainLock\(/);
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
    assert.match(
        cron,
        /const queued = await prisma\.receiptRequestCard\.findMany\(\{[\s\S]{0,400}status: "PENDING",[\s\S]{0,300}resendQueuedAt: \{ not: null \},[\s\S]{0,200}pacificDate: \{ lt: date \}/,
    );
    assert.match(cron, /orderBy: \[\{ resendQueuedAt: "asc" \}, \{ pacificDate: "asc" \}, \{ owner: "asc" \}\],[\s\S]{0,80}take: QUEUED_RESEND_DRAIN_LIMIT/,
        "oldest first, and bounded so a backlog cannot crowd out today");
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
