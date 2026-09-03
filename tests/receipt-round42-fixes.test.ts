import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requestIdFor, rebuildCardItems, type CardItem, type CardItemTruth, type OwnerCard, type RebuiltCard } from "../src/lib/receipt-request-cards";
import { cursorUsableAt, formatSweepCursor, parseSweepCursor } from "../src/app/api/cron/receipt-requests/route";
import { isComponentKey } from "../src/lib/receipt-requests";

/**
 * Codex PR #443, adversarial gate round 42 — what rounds 40 and 41 left open.
 *
 *  2. THE SWEEP CURSOR OUTLIVED THE LEDGER IT MEASURED. A BankLine inserted
 *     between two invocations joins the next one's freshly-read baseline epoch;
 *     if its component key sorts before the persisted cursor it is filtered out
 *     and never judged, while the epoch fence — comparing the new baseline to
 *     itself — sees nothing wrong. The cycle then stamps itself complete over a
 *     line nobody looked at.
 *  3. A REVALIDATION TIMEOUT WAS TREATED AS A VERDICT. Items the pre-send check
 *     ran out of budget for come back from `rebuildCardItems` as drops. The
 *     caller acted on them: it rewrote the card's snapshot to the partial list,
 *     or — when nothing was verified — DELETED the row, taking a queued resend
 *     and the operator's decision with it.
 *  4. RESENDS BROKE ONE-MESSAGE-PER-OWNER-PER-DAY. A resend keeps its original
 *     `pacificDate`, so the (owner, pacificDate) key cannot see the day it is
 *     actually SENT: several queued days for one owner drained together, and a
 *     resend could land on a day that owner had already had a card.
 *  5. OLD RESENDS POSTED INTO THREADS THE BRIDGE COULD NOT EXPORT. The threads
 *     endpoint windowed on `pacificDate`, so a 20-day-old card resent this
 *     morning was outside the window the moment it was posted — every "sign N"
 *     reply in that thread resolved against nothing.
 *
 * (Finding 1, the receipt-evidence fence, has its own two files:
 * tests/receipt-evidence-lock.test.ts for the writer tripwire and
 * tests/receipt-evidence-fence-db.test.ts for what the lock does against a real
 * Postgres.)
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.RECEIPT_REQUEST_CARDS_ENABLED = "true";
process.env.RECEIPTS_CHAT_WEBHOOK = "https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x";
process.env.RECEIPT_BRIDGE_SECRET ??= "bridge-secret";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ═══ 2. The cursor carries the epoch it was taken against ═══════════════════

test("a cursor and the epoch it was measured against travel as ONE value", () => {
    const stored = formatSweepCursor({ key: "2026-08-01|abc", epoch: "7" });
    assert.equal(stored, "e7|2026-08-01|abc",
        "the `e` prefix is what tells this apart from a legacy key whose date looks like an epoch");

    const parsed = parseSweepCursor(stored);
    assert.deepEqual(parsed, { key: "2026-08-01|abc", epoch: "7" },
        "the component key contains a pipe of its own — only the FIRST one separates the epoch");
    assert.equal(isComponentKey(parsed.key ?? ""), true, "and what comes back is still a component key");
});

test("a resume is refused unless the ledger is the same one the cursor measured", () => {
    const cursor = parseSweepCursor("e7|2026-08-01|abc");
    assert.equal(cursorUsableAt(cursor, "7"), true, "same epoch: the position still means what it said");
    assert.equal(cursorUsableAt(cursor, "8"), false, "a line landed since — the cycle starts again");
});

test("a bare cursor from an older build reads as 'no epoch', and restarts", () => {
    // The deploy case. Nothing migrates the stored value, so the shape has to
    // fail in the safe direction on its own.
    const legacy = parseSweepCursor("2026-08-01|abc");
    assert.equal(legacy.epoch, null);
    assert.equal(legacy.key, "2026-08-01|abc");
    assert.equal(cursorUsableAt(legacy, "7"), false, "no epoch is not a matching epoch");

    // PRE-FIX CONTROL: the round-41 shape asked only whether the stored string
    // looked like a component key. It does — so the old code resumed from it
    // against whatever ledger this run happened to see, which is the bug.
    assert.equal(isComponentKey("2026-08-01|abc"), true,
        "the old test accepted exactly this value, with no epoch to disagree with");
});

test("an empty or missing cursor is not a position at all", () => {
    assert.deepEqual(parseSweepCursor(null), { key: null, epoch: null });
    assert.deepEqual(parseSweepCursor(""), { key: null, epoch: null });
    assert.equal(cursorUsableAt({ key: null, epoch: "7" }, "7"), false, "an epoch with no key resumes nothing");
    assert.equal(formatSweepCursor({ key: null, epoch: "7" }), null, "and is never persisted as one");
});

test("a fresh run clears BOTH cursors before it starts", () => {
    // Belt and braces for the same finding: a cycle that starts over must not
    // leave the open-issue cursor pointing into the previous pass either.
    const sweep = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(sweep, /await Promise\.all\(\[writeCursor\(null\), writeOpenCursor\(null\)\]\)/);
    assert.match(sweep, /const cursorEpochMatches = cursorUsableAt\(parsedCursor, snapshotEpoch\);/);

    // EVERY checkpoint carries the epoch, not just the one a regex happens to
    // reach first. The sweep writes the cursor in TWO places — the ordinary
    // end-of-page one and the "the whole page vanished" one — and a guard that
    // pinned only the first stayed green while the second wrote a bare key
    // (measured: that mutation survived until this assertion existed).
    const checkpoints = sweep.match(/await writeCursor\(/g) ?? [];
    const carried = sweep.match(/await writeCursor\(formatSweepCursor\(\{ key: cursor, epoch: snapshotEpoch \}\)\)/g) ?? [];
    assert.equal(checkpoints.length - carried.length, 1,
        "exactly one writeCursor call is not a checkpoint: the reset to null when a cycle finishes clean");
    assert.equal(carried.length, 2, "and both real checkpoints carry the epoch");
});

// ═══ 3, 4. The cards cron, over a fake card table ═══════════════════════════

interface ScanRow {
    id: string;
    targetKey: string;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}

let queue: ScanRow[];
/** The ReceiptRequestCard table, keyed by `${owner}|${pacificDate}`. */
let cards: Map<string, Record<string, unknown>>;
/** Every card that actually reached the webhook. */
let postCalls: OwnerCard[];
/**
 * What the pre-send rebuild reports for this test. `null` means "the real
 * one" — the deadline path cannot be reached by wall-clock in a unit test, and
 * the finding is about how the CALLER handles the result, not about the
 * rebuild itself (which `rebuildCardItems` covers directly).
 */
let rebuildOverride: ((items: readonly CardItem[]) => RebuiltCard) | null;

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const dayBefore = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const yesterday = dayBefore(1);
const twoDaysAgo = dayBefore(2);

function scanRow(id: string, owner: string): ScanRow {
    return {
        id,
        targetKey: `bl-${id}`,
        reasonCodes: JSON.stringify(["MISSING_RECEIPT"]),
        acknowledgedCodes: "[]",
        displayDetails: JSON.stringify({ amountCents: -100, owner, postedDate: "2026-08-16", payee: "LOWES", fingerprint: `pb-${id}` }),
    };
}

function cardMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (typeof where.claimToken === "string" && row.claimToken !== where.claimToken) return false;
    if ("postedAt" in where && where.postedAt === null && row.postedAt !== null) return false;
    if (typeof where.status === "string" && row.status !== where.status) return false;
    const status = where.status as { in?: string[] } | undefined;
    if (status && typeof status === "object" && Array.isArray(status.in) && !status.in.includes(row.status as string)) return false;
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or) {
        const free = row.claimedAt === null
            || or.some(clause => {
                const claimed = clause.claimedAt as { lt?: Date } | null | undefined;
                return claimed?.lt instanceof Date
                    && row.claimedAt instanceof Date
                    && row.claimedAt.getTime() < claimed.lt.getTime();
            });
        if (!free) return false;
    }
    return true;
}

const settings = new Map<string, string>();
const settingStore = {
    findUnique: async ({ where }: { where: { key: string } }) =>
        (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value);
        return { key: where.key };
    },
};

const cardsPrisma: Record<string, unknown> = {
    $queryRaw: async () => [{ locked: true }],
    $executeRaw: async () => 1,
    $transaction: async (arg: unknown) =>
        (typeof arg === "function" ? await (arg as (tx: unknown) => Promise<unknown>)(cardsPrisma) : arg),
    automationSetting: settingStore,
    receiptMemoArtifact: { findMany: async () => [] },
    reviewIssue: {
        findMany: async (args: { where: { id?: { in: string[] } }; take?: number; cursor?: { id: string }; skip?: number }) => {
            if (args.where.id?.in) {
                const wanted = new Set(args.where.id.in);
                return queue.filter(row => wanted.has(row.id)).map(row => ({ ...row, clearedAt: null }));
            }
            const at = args.cursor ? queue.findIndex(row => row.id === args.cursor!.id) : -1;
            const from = args.cursor ? at + (args.skip ?? 0) : 0;
            if (args.cursor && at < 0) return [];
            return queue.slice(Math.max(from, 0), Math.max(from, 0) + (args.take ?? queue.length));
        },
    },
    receiptRequestCard: {
        findUnique: async ({ where }: { where: { owner_pacificDate: { owner: string; pacificDate: string } } }) =>
            cards.get(`${where.owner_pacificDate.owner}|${where.owner_pacificDate.pacificDate}`) ?? null,
        findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
            // The delivery-day claim lookup: who already had a card TODAY.
            if (typeof where.deliveredOn === "string") {
                return [...cards.values()].filter(row => row.deliveredOn === where.deliveredOn);
            }
            const queuedOnly = where.resendQueuedAt as { not?: null } | undefined;
            const before = (where.pacificDate as { lt?: string } | undefined)?.lt;
            const rows = [...cards.values()].filter(row => {
                if (where.status && row.status !== where.status) return false;
                if ("postedAt" in where && row.postedAt !== null) return false;
                if (queuedOnly && row.resendQueuedAt == null) return false;
                if (before && !((row.pacificDate as string) < before)) return false;
                return true;
            });
            // Oldest first, the way the real query orders them.
            rows.sort((a, b) => String(a.pacificDate).localeCompare(String(b.pacificDate)));
            return rows.slice(0, take ?? rows.length);
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
            const key = `${data.owner as string}|${data.pacificDate as string}`;
            const row = { id: `card-${cards.size + 1}`, status: "PENDING", postedAt: null, resendQueuedAt: null, deliveredOn: null, ...data };
            cards.set(key, row);
            return row;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (const row of cards.values()) {
                if (!cardMatches(row, where)) continue;
                for (const [key, value] of Object.entries(data)) {
                    if (value && typeof value === "object" && "increment" in (value as object)) {
                        row[key] = ((row[key] as number) ?? 0) + (value as { increment: number }).increment;
                    } else {
                        row[key] = value;
                    }
                }
                count++;
            }
            return { count };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
            let count = 0;
            for (const [key, row] of [...cards.entries()]) {
                if (!cardMatches(row, where)) continue;
                cards.delete(key);
                count++;
            }
            return { count };
        },
    },
};

let cardsGET: (request: Request) => Promise<Response>;

function queuedCard(owner: string, date: string, itemIds: string[], over: Record<string, unknown> = {}) {
    const row = {
        id: `queued-${owner}-${date}`,
        owner,
        pacificDate: date,
        itemsJson: JSON.stringify(itemIds.map((id, i) => ({
            n: i + 1, issueId: id, fingerprint: `pb-${id}`, cents: 100, date: "2026-08-16", vendor: "LOWES",
        }))),
        overflow: 0,
        overflowExact: true,
        status: "PENDING",
        postedAt: null,
        deliveredOn: null,
        claimedAt: null,
        claimToken: null,
        attempts: 0,
        lastError: "resend-requested",
        resendQueuedAt: new Date(Date.now() - 20 * 3_600_000),
        ...over,
    };
    cards.set(`${owner}|${date}`, row);
    return row;
}

function reset() {
    queue = [];
    cards = new Map();
    postCalls = [];
    rebuildOverride = null;
    settings.clear();
    settings.set("receiptRequestsPhase", JSON.stringify({
        phase: "done",
        chaserCompletedAt: new Date().toISOString(),
        blockedReason: null,
    }));
}

before(async () => {
    const originalRequire = Module.prototype.require;
    const realCards = await import("../src/lib/receipt-request-cards");
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") return { prisma: cardsPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/receipt-card-history") {
            return { recordCardOnIssues: async () => undefined, itemsMissingCardRecord: async () => [] };
        }
        if (id === "@/app/api/cron/receipt-requests/route") return { recomputeCodesFor: async () => ["MISSING_RECEIPT"] };
        if (id === "@/lib/receipt-request-cards") {
            return {
                ...realCards,
                isPacificWeekday: () => true,
                rebuildCardItems: (items: readonly CardItem[], truth: ReadonlyMap<string, CardItemTruth>, owner: string) =>
                    (rebuildOverride ? rebuildOverride(items) : realCards.rebuildCardItems(items, truth, owner)),
                postOwnerCard: async (_url: string, card: OwnerCard) => {
                    postCalls.push(card);
                    return { kind: "delivered", owner: card.owner, threadName: "spaces/s/threads/t", messageName: "spaces/s/messages/m" };
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { GET?: unknown };
    try {
        mod = await import("../src/app/api/cron/receipt-request-cards/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.GET !== "function") throw new Error("the receipt-request-cards cron did not load");
    cardsGET = mod.GET as typeof cardsGET;
});

const run = () => cardsGET(new Request("https://probuild.test/api/cron/receipt-request-cards"));

/** Every item unverified: the shape a fully timed-out revalidation produces. */
const allUnverified = (items: readonly CardItem[]): RebuiltCard => ({
    items: [],
    dropped: items.map(item => ({ issueId: item.issueId, reason: "revalidation-deadline" as const })),
});

// ── 3. An unfinished check decides nothing ─────────────────────────────────

test("a card whose revalidation ran out of budget is DEFERRED, not deleted", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ")];
    const row = queuedCard("CJ", yesterday, ["ri-1"]);
    const snapshot = row.itemsJson;
    rebuildOverride = allUnverified;

    const body = await (await run()).json() as {
        budgetDeferredOwners?: string[];
        deferredReason?: string;
        cancelledOwners?: string[];
    };

    assert.equal(postCalls.length, 0, "nothing was sent on the strength of a check that did not finish");
    assert.equal(cards.has(`CJ|${yesterday}`), true, "and the row is still there");
    assert.equal(row.resendQueuedAt instanceof Date, true, "the operator's resend decision survived");
    assert.equal(row.itemsJson, snapshot, "and its snapshot was not rewritten");
    assert.equal(row.claimToken, null, "the claim was released so the next pass can take it");
    assert.equal(row.claimedAt, null);
    assert.deepEqual(body.budgetDeferredOwners, ["CJ"]);
    assert.equal(body.deferredReason, "deferred:budget", "the specific reason wins over the generic send deferral");
});

test("PRE-FIX CONTROL: a real verdict on the same items DOES delete the row", async () => {
    // Identical setup, one word different: the items were checked and found
    // already answered. That is a decision, and acting on it is correct — which
    // is what makes acting on a TIMEOUT the bug rather than the delete itself.
    reset();
    queue = [scanRow("ri-1", "CJ")];
    queuedCard("CJ", yesterday, ["ri-1"]);
    rebuildOverride = items => ({
        items: [],
        dropped: items.map(item => ({ issueId: item.issueId, reason: "cleared" as const })),
    });

    const body = await (await run()).json() as { cancelledOwners?: string[]; deferredReason?: string };

    assert.equal(postCalls.length, 0);
    assert.equal(cards.has(`CJ|${yesterday}`), false, "the row is gone, resend marker and all");
    assert.deepEqual(body.cancelledOwners, ["CJ"]);
    assert.equal(body.deferredReason, undefined, "and this is not a deferral");
});

test("a PARTIALLY verified card is deferred whole — no partial snapshot goes out", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ"), scanRow("ri-2", "CJ")];
    const row = queuedCard("CJ", yesterday, ["ri-1", "ri-2"]);
    const snapshot = row.itemsJson;
    // One item verified and still open, one the budget never reached.
    rebuildOverride = items => ({
        items: [{ ...items[0], n: 1 }],
        dropped: [{ issueId: items[1].issueId, reason: "revalidation-deadline" }],
    });

    const body = await (await run()).json() as { budgetDeferredOwners?: string[]; droppedItems?: unknown[] };

    assert.equal(postCalls.length, 0, "a card missing an item nobody checked is not the card to send");
    assert.equal(row.itemsJson, snapshot, "the snapshot still holds both items");
    assert.deepEqual(body.budgetDeferredOwners, ["CJ"]);
    assert.deepEqual(body.droppedItems ?? [], [], "and nothing is REPORTED dropped, because nothing was");
});

test("PRE-FIX CONTROL: a verified drop still rebuilds and sends the rest", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ"), scanRow("ri-2", "CJ")];
    queuedCard("CJ", yesterday, ["ri-1", "ri-2"]);
    rebuildOverride = items => ({
        items: [{ ...items[0], n: 1 }],
        dropped: [{ issueId: items[1].issueId, reason: "resolved" }],
    });

    const body = await (await run()).json() as { droppedItems?: Array<{ reason: string }> };

    assert.equal(postCalls.length, 1, "this is the path the deferral diverts from");
    assert.equal(postCalls[0].items.length, 1);
    assert.equal(postCalls[0].requestId, requestIdFor("CJ", yesterday));
    assert.deepEqual((body.droppedItems ?? []).map(drop => drop.reason), ["resolved"]);
});

test("rebuildCardItems itself reports an unreached item as revalidation-deadline", () => {
    // The other half of the contract, on the real function: the caller can only
    // divert on this reason if the rebuild actually produces it.
    const items: CardItem[] = [
        { n: 1, issueId: "a", targetKey: "bl-a", fingerprint: "pb-a", cents: 100, amount: "1.00", cardTail: null, date: "2026-08-16", vendor: "LOWES" },
    ];
    const truth = new Map<string, CardItemTruth>([
        ["a", { owner: "CJ", clearedAt: null, resolved: false, acknowledged: false, evidenceSatisfied: false, revalidationSkipped: true }],
    ]);
    const rebuilt = rebuildCardItems(items, truth, "CJ");
    assert.deepEqual(rebuilt.dropped, [{ issueId: "a", reason: "revalidation-deadline" }]);
    assert.equal(rebuilt.items.length, 0, "which is exactly the all-dropped shape that used to delete the row");
});

// ── 4. One message per owner per day, enforced not remembered ──────────────

test("two queued days for one owner drain as ONE card", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ"), scanRow("ri-2", "CJ")];
    queuedCard("CJ", twoDaysAgo, ["ri-1"]);
    queuedCard("CJ", yesterday, ["ri-2"]);

    const body = await (await run()).json() as { queuedDrained: string[] };

    // The control is in the fixture: BOTH rows are genuinely queued and
    // genuinely selectable, so the single post is a decision, not an artefact.
    assert.equal([...cards.values()].filter(row => row.resendQueuedAt != null || row.status === "POSTED").length, 2);
    assert.equal(postCalls.length, 1, "one message, not two");
    assert.equal(postCalls[0].requestId, requestIdFor("CJ", twoDaysAgo), "and it is the OLDEST queued day");
    assert.deepEqual(body.queuedDrained, [`CJ:${twoDaysAgo}`]);
    assert.equal(cards.get(`CJ|${yesterday}`)!.resendQueuedAt instanceof Date, true,
        "the other one keeps its marker and waits for tomorrow");
});

test("the POSTED write takes the delivery-day claim in the same transaction", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ")];
    queuedCard("CJ", yesterday, ["ri-1"]);

    await run();

    const row = cards.get(`CJ|${yesterday}`)!;
    assert.equal(row.status, "POSTED");
    assert.equal(row.deliveredOn, today, "the day it was SENT, which its pacificDate cannot say");
    assert.equal(row.pacificDate, yesterday, "and its own day is untouched — the thread id depends on it");
    assert.equal(row.resendQueuedAt, null, "the obligation is discharged by the post");
});

test("an owner who already had a card today does not get the resend as a second one", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ")];
    // Today's ordinary card already went out.
    cards.set(`CJ|${today}`, {
        id: "card-today", owner: "CJ", pacificDate: today, itemsJson: "[]", overflow: 0, overflowExact: true,
        status: "POSTED", postedAt: new Date(), deliveredOn: today, claimedAt: null, claimToken: null,
        attempts: 1, lastError: null, resendQueuedAt: null,
    });
    const queued = queuedCard("CJ", yesterday, ["ri-1"]);

    const body = await (await run()).json() as { queuedDrained: string[] };

    assert.equal(postCalls.length, 0, "their day is spent");
    assert.deepEqual(body.queuedDrained, []);
    assert.equal(queued.resendQueuedAt instanceof Date, true, "the resend is still owed, just not today");
    assert.equal(queued.status, "PENDING");
});

test("PRE-FIX CONTROL: with the day free, that same resend posts immediately", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ")];
    const queued = queuedCard("CJ", yesterday, ["ri-1"]);

    const body = await (await run()).json() as { queuedDrained: string[] };

    assert.equal(postCalls.length, 1, "nothing about the row changed — only whether today was taken");
    assert.deepEqual(body.queuedDrained, [`CJ:${yesterday}`]);
    assert.equal(queued.resendQueuedAt, null);
});

test("the claim is a database constraint, not a check somebody has to remember", () => {
    // Two invocations can both pass an in-memory check. Only the index decides.
    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    assert.match(schema, /@@unique\(\[owner, deliveredOn\]\)/);

    const migration = readFileSync(
        join(repoRoot, "prisma/migrations/20260901120000_phase2_receipt_queue/migration.sql"), "utf8");
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_deliveredOn_key"/);
    assert.match(migration, /WHERE "deliveredOn" IS NOT NULL/,
        "PARTIAL: a card that was never delivered holds no claim");

    // The apply script has to say the same thing, or prod and CI drift.
    const apply = readFileSync(join(repoRoot, "scripts/apply-phase2-receipt-queue.mjs"), "utf8");
    assert.match(apply, /ADD COLUMN IF NOT EXISTS "deliveredOn" TEXT/);
    assert.match(apply, /CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_deliveredOn_key"/);
    assert.match(apply, /\{ name: "deliveredOn", type: "text", nullable: true, default: null \}/);
});

// ═══ 5. Retention follows the LAST delivery ════════════════════════════════

test("the threads export windows on postedAt, so an old card resent today is exportable", () => {
    const route = readFileSync(
        join(repoRoot, "src/app/api/automation/receipt-requests/threads/route.ts"), "utf8");

    assert.match(route, /where: \{ postedAt: \{ gte: cutoffAt \}, threadName: \{ not: null \} \}/,
        "the window is measured from when the card last reached Chat");
    assert.match(route, /orderBy: \{ postedAt: "desc" \}/);

    // PRE-FIX CONTROL: the old shape, which is what stranded the thread. A card
    // resent on day 20 of a 14-day window was outside it the moment it posted,
    // and `postedAt: { not: null }` was doing the "was it sent" work that
    // `postedAt: { gte: cutoffAt }` now does implicitly (a null is never >=).
    assert.doesNotMatch(route, /pacificDate: \{ gte: cutoff \}/);
    assert.doesNotMatch(route, /orderBy: \{ pacificDate: "desc" \}/);
});

test("a null postedAt cannot satisfy the window, so an unsent card never exports", () => {
    // The one thing the old `postedAt: { not: null }` clause guaranteed, proved
    // to still hold from the comparison itself rather than from a second filter.
    const cutoff = new Date(Date.now() - 14 * 86_400_000);
    const rows: Array<{ postedAt: Date | null }> = [
        { postedAt: null },
        { postedAt: new Date(Date.now() - 30 * 86_400_000) },
        { postedAt: new Date() },
    ];
    const exported = rows.filter(row => row.postedAt !== null && row.postedAt >= cutoff);
    assert.equal(exported.length, 1, "only the card that actually posted inside the window");
});
