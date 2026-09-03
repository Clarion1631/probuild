import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requestIdFor, type OwnerCard } from "../src/lib/receipt-request-cards";
import { evaluatePipelineHealth } from "../src/lib/pipeline-health";

/**
 * Codex PR #443, adversarial gate round 41 — the holes round 40 left in the
 * queued-resend drain.
 *
 *  1. A DRAINED RESEND AND TODAY'S SELECTION ASKED THE SAME PERSON TWICE. The
 *     queued row went into `toPost`, and its issues stayed in `scan.candidates`
 *     — a chase does not leave the queue because a card for it is waiting — so
 *     the per-owner loop built a second card from the same items.
 *  2. A PARTIALLY REBUILT RESEND POSTED UNDER THE WRONG DATE. The rebuild used
 *     the invocation's Pacific day, so the webhook threaded on today's request
 *     id while the row, the threads export and `matchCardAssociation` all still
 *     spoke the old one.
 *  3. A REJECTED RESEND WAS STRANDED. The queue marker lived in `lastError`,
 *     which the rejection path overwrites with `rejected:*` — so the drain
 *     stopped selecting the row and the health probe stopped counting it.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.RECEIPT_REQUEST_CARDS_ENABLED = "true";
process.env.RECEIPTS_CHAT_WEBHOOK = "https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── The cards cron, over a fake card table ─────────────────────────────────

interface ScanRow {
    id: string;
    targetKey: string;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}

/** Open chases the scan will find. */
let queue: ScanRow[];
/** The ReceiptRequestCard table, keyed by `${owner}|${date}`. */
let cards: Map<string, Record<string, unknown>>;
/** Every card that actually reached the webhook. */
let postCalls: OwnerCard[];

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

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
        /** THE DRAIN'S QUERY: queued rows for an earlier date. */
        findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
            const queuedOnly = where.resendQueuedAt as { not?: null } | undefined;
            const before = (where.pacificDate as { lt?: string } | undefined)?.lt;
            const rows = [...cards.values()].filter(row => {
                if (where.status && row.status !== where.status) return false;
                if ("postedAt" in where && row.postedAt !== null) return false;
                if (queuedOnly && row.resendQueuedAt == null) return false;
                if (before && !((row.pacificDate as string) < before)) return false;
                return true;
            });
            return rows.slice(0, take ?? rows.length);
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
            const key = `${data.owner as string}|${data.pacificDate as string}`;
            const row = { id: `card-${cards.size + 1}`, status: "PENDING", postedAt: null, resendQueuedAt: null, ...data };
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
    settings.clear();
    // The cards cron refuses to send until TODAY'S chase has finished a clean
    // cycle — that gate is round 32's, and every test here is about what
    // happens after it.
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

// ── 1. A drained resend IS that owner's card for the day ───────────────────

test("an owner with a queued resend gets exactly ONE post, and it is the queued one", async () => {
    reset();
    // The same chase is both queued (yesterday's card) and still open, so it is
    // still in the scan — which is precisely why the second selection has to be
    // skipped rather than assumed impossible.
    queue = [scanRow("ri-1", "CJ")];
    queuedCard("CJ", yesterday, ["ri-1"]);

    const body = await (await run()).json() as {
        queuedDrained: string[];
        queuedConsumedOwners: string[];
        scanned: number;
    };

    assert.equal(postCalls.length, 1, "one card, not two");
    assert.equal(postCalls[0].requestId, requestIdFor("CJ", yesterday), "and it is the queued card, under its own date");
    assert.deepEqual(body.queuedDrained, [`CJ:${yesterday}`]);
    assert.deepEqual(body.queuedConsumedOwners, ["CJ"], "the run says whose day the resend consumed");
    assert.ok(body.scanned > 0, "the item was still a candidate — the drain does not remove it from the scan");
    assert.equal(cards.has(`CJ|${today}`), false, "and no second card was created for today");
});

test("PRE-FIX CONTROL: without the skip, the same open chase is selected again", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ")];
    // No queued row at all: the ordinary path selects and posts. That is the
    // card the drained owner would ALSO have got before the skip existed.
    const body = await (await run()).json() as { scanned: number };
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].requestId, requestIdFor("CJ", today), "today's card, from the same open chase");
    assert.ok(body.scanned > 0);
});

// ── 2. A rebuilt resend keeps its own date ─────────────────────────────────

test("a resend rebuilt after a dropped item still posts under the OLD date's ids", async () => {
    reset();
    // Two items on yesterday's card; one of them is no longer open, so the card
    // is rebuilt — the path that used to switch to today's date.
    queue = [scanRow("ri-live", "CJ")];
    queuedCard("CJ", yesterday, ["ri-live", "ri-gone"]);

    await run();

    assert.equal(postCalls.length, 1);
    const card = postCalls[0];
    assert.equal(card.items.length, 1, "the answered item was dropped, so this IS the rebuild path");
    assert.equal(card.requestId, requestIdFor("CJ", yesterday), "the request id — and so the thread key — is the old date's");
    assert.equal(card.date, yesterday);
    // PRE-FIX CONTROL: today's id is a different thread, which is what the
    // bridge would have been told to echo back.
    assert.notEqual(requestIdFor("CJ", today), card.requestId);
});

// ── 3. A rejected resend stays visible ─────────────────────────────────────

test("a queued resend Chat rejected is still drained, and still counted", async () => {
    reset();
    queue = [scanRow("ri-1", "CJ")];
    // The rejection path put it back to PENDING and overwrote `lastError`.
    // `resendQueuedAt` is what survives that.
    queuedCard("CJ", yesterday, ["ri-1"], { lastError: "rejected:http-400", attempts: 1 });

    const body = await (await run()).json() as { queuedDrained: string[] };
    assert.deepEqual(body.queuedDrained, [`CJ:${yesterday}`], "the marker outlived the error text");
    assert.equal(postCalls.length, 1);

    // PRE-FIX CONTROL: the round-40 query keyed on the error text, which the
    // PRE-FIX CONTROL: the round-40 query keyed on the error text, which the
    // rejection had already replaced — the row was invisible from then on.
    const row = [...cards.values()][0];
    assert.notEqual(row.lastError, "resend-requested", "the text the old drain looked for is gone");
    assert.equal(row.status, "POSTED", "and this run posted it anyway, because the column is what it queries");
    assert.equal(row.resendQueuedAt, null, "the obligation is discharged by the post, and only by the post");
});

test("the drain and the probes read the column, and only a POST discharges it", () => {
    const cron = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(cron, /resendQueuedAt: \{ not: null \},/, "the drain selects on the column");
    assert.match(cron, /status: "POSTED",[\s\S]{0,900}resendQueuedAt: null,/, "and only a successful post clears it");
    assert.doesNotMatch(cron, /lastError: CARD_RESEND_QUEUED_REASON,\s*\n\s*pacificDate/, "the text is no longer the query");
    assert.match(cron, /if \(drainedOwners\.has\(owner\)\) continue;/);

    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    assert.match(actions, /resendQueuedAt: new Date\(\),\s*\n\s*lastError: CARD_RESEND_QUEUED_REASON,/,
        "the resend records the decision AND the human-readable note");

    const health = readFileSync(join(repoRoot, "src/lib/pipeline-health.ts"), "utf8");
    assert.match(health, /resendQueuedAt: \{ not: null, lt: new Date\(now - CARD_RESEND_STALE_HOURS \* HOUR_MS\) \}/);
    assert.match(health, /"rejectedQueuedCards",[\s\S]{0,300}lastError: \{ startsWith: "rejected:" \}/);

    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    assert.match(schema, /resendQueuedAt DateTime\?/);
    const migration = readFileSync(join(repoRoot, "prisma/migrations/20260901120000_phase2_receipt_queue/migration.sql"), "utf8");
    assert.match(migration, /ADD COLUMN IF NOT EXISTS "resendQueuedAt" TIMESTAMP\(3\)/, "idempotent, like every other statement here");
    const script = readFileSync(join(repoRoot, "scripts/apply-phase2-receipt-queue.mjs"), "utf8");
    assert.match(script, /ADD COLUMN IF NOT EXISTS "resendQueuedAt" TIMESTAMP\(3\)/, "and the apply script matches the migration");
});

test("a rejected queued card is reported, not silently dropped", () => {
    const input = {
        intuit: { status: "ok" as const, indicator: "none" },
        lastPurchaseSync: { status: "ok" as const, at: new Date().toISOString() },
        lastReceiptPush: { status: "ok" as const, at: new Date().toISOString() },
        lastPaymentsSync: { status: "ok" as const, at: new Date().toISOString() },
        receipts24h: { status: "ok" as const, counts: { created: 1 } },
        bank: { status: "ok" as const, at: new Date().toISOString() },
        stuck: { status: "ok" as const, count: 0 },
        intakeStuck: { status: "ok" as const, count: 0 },
        intakeNeedsReview: { status: "ok" as const, count: 0 },
        intakeUnassigned: { status: "ok" as const, count: 0 },
        uncertainCards: { status: "ok" as const, count: 0 },
        queuedCards: { status: "ok" as const, count: 0 },
        driveCredentials: { status: "ok" as const, configured: true, source: "company-settings" },
        chaser: { status: "ok" as const, phase: "done", completedAt: new Date().toISOString() },
        bankPull: { status: "ok" as const, enabled: false, lastSuccessAt: null, ambiguousCount: 0 },
        now: Date.now(),
    } as unknown as Parameters<typeof evaluatePipelineHealth>[0];

    const rejected = evaluatePipelineHealth({ ...input, rejectedQueuedCards: { status: "ok", count: 1 } });
    assert.ok(rejected.reasons.includes("cards-queued-rejected:1"), rejected.reasons.join(","));
    assert.equal(rejected.ok, false);

    const clean = evaluatePipelineHealth({ ...input, rejectedQueuedCards: { status: "ok", count: 0 } });
    assert.equal(clean.reasons.some(r => r.startsWith("cards-queued-rejected")), false);
    // And a probe that could not run is a probe failure, not a zero.
    const broken = evaluatePipelineHealth({ ...input, rejectedQueuedCards: { status: "error", count: 0 } });
    assert.ok(broken.reasons.includes("probe-failed:rejectedQueuedCards"));
});

// ── 4. The sweep's component transaction is serializable ───────────────────

test("the component transaction runs SERIALIZABLE, retried, with the reads and writes inside it", () => {
    const sweep = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(
        sweep,
        /await withTxRetry\(\(\) => prisma\.\$transaction\(async tx => \{/,
        "the whole component transaction is the retry unit — a 40001 rolls it all back",
    );
    assert.match(sweep, /\{ timeout: COMPONENT_TX_TIMEOUT_MS, isolationLevel: "Serializable" \}/);
    // The evidence reads and the ReviewIssue writes are both inside it: the
    // predicate locks only cover what THIS transaction read.
    const txAt = sweep.indexOf("await withTxRetry(() => prisma.$transaction(async tx => {");
    const readsAt = sweep.indexOf("tx.receiptIntake.findMany(", txAt);
    const writeAt = sweep.indexOf("const applied = await applyReceiptRequestPlan(", txAt);
    const closeAt = sweep.indexOf("isolationLevel: \"Serializable\"", txAt);
    assert.ok(readsAt > txAt && writeAt > readsAt && closeAt > writeAt,
        "reads, then writes, then the transaction closes — nothing decided outside it");

    // And the retry is the shared, documented one.
    assert.match(sweep, /import \{ withTxRetry \} from "@\/lib\/tx-retry";/);
    const retry = readFileSync(join(repoRoot, "src/lib/tx-retry.ts"), "utf8");
    assert.match(retry, /pg === "40P01" \|\| pg === "40001"/, "40001 is what SSI raises, and it must be retryable");
});
