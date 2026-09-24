import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isCrewReceiptRequest } from "../src/lib/receipt-policy";
import type { OwnerCard } from "../src/lib/receipt-request-cards";

/**
 * cards-complete-scan-spec.md, Option A.
 *
 * tests/receipt-round34-fixes.test.ts and tests/receipt-round35-fixes.test.ts
 * cover `scanCandidates` itself and the revised send-headroom case; this file
 * is the GET-level story a unit test on the scan alone cannot tell: that a
 * read the page cap or the clock cut short claims NO owner's day, even for an
 * owner whose row it did see, while a card claimed earlier today and a
 * complete read both still behave exactly as before.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.RECEIPT_REQUEST_CARDS_ENABLED = "true";
process.env.RECEIPTS_CHAT_WEBHOOK = "https://chat.googleapis.com/v1/spaces/TESTSPACE/messages?key=x";
// So the route's policy is receipt-source-v1:off, matching the seeded cycle.
delete process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED;

test("precondition: the fixture payee is a crew receipt request", () => {
    assert.equal(isCrewReceiptRequest({ amountCents: -4000, rawDescriptor: "SUPPLY CO" }), true);
});

// ── Harness (the cards half of tests/receipt-round35-fixes.test.ts) ─────────

/** The AutomationSetting KV table, as a map. */
let settings: Map<string, string>;

const settingStore = {
    findUnique: async ({ where }: { where: { key: string } }) =>
        (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value);
        return { key: where.key };
    },
    update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
        if (!settings.has(where.key)) throw new Error("record not found");
        settings.set(where.key, data.value);
        return { key: where.key };
    },
};

interface ScanRow {
    id: string;
    targetKey: string;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}

/** The `where` shapes the cards route actually uses against ReceiptRequestCard. */
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

// ── Fixture state, cleared by reset() before every test ─────────────────────

/**
 * "queue": a fixed list, sliced by cursor exactly like the real query.
 * "endless": an unbounded feed that always answers a full page — the page-cap
 * tests use it so a real 200-page scan never has to hold 100,000 rows in an
 * array at once.
 */
let mode: "queue" | "endless";
let queue: ScanRow[];
/** endless mode only: page 1's real content, ahead of the office padding. */
let pageOneRows: ScanRow[];
/** endless mode only: how many pages this scan has served so far. */
let endlessPage: number;
/**
 * Every row this test has minted, by id. The send-time recheck
 * (`reviewIssue.findMany({ where: { id: { in: … } } })`) answers from here —
 * never from `queue` — because a resumed card's item was not necessarily
 * served by THIS run's own scan.
 */
let byId: Map<string, ScanRow>;
/** Rows the fake card table holds, keyed by `${owner}|${date}`. */
let cards: Map<string, Record<string, unknown>>;
/** Every postOwnerCard call the route made this test. */
let postCalls: Array<{ owner: string; timeoutMs?: number }>;
/** Every receiptRequestCard.create call this test — the claim insert, only. */
let creates: number;
/** Every $executeRaw statement claimOwnerDay's transaction ran. */
let executed: string[];
/**
 * Fires after `reviewIssue.findMany` serves a SCAN page (never the by-id
 * recheck). T5 and T6 use it to jump the frozen clock mid-scan.
 */
let onScanPage: (() => void) | null;
/** console.error calls this test captured, arguments as given. */
let errorCalls: unknown[][];
let offsetMs: number;

/** Every office row shares this exact string — one parse's worth of JSON,
 *  reused 100,000 times, is what keeps T1/T3 cheap. */
const OFFICE_DETAILS = JSON.stringify({
    amountCents: -4000, owner: "office", postedDate: "2026-01-05", payee: "SUPPLY CO", fingerprint: "pb-office",
});

function officeRow(id: string): ScanRow {
    return { id, targetKey: `bl-${id}`, reasonCodes: '["MISSING_RECEIPT"]', acknowledgedCodes: "[]", displayDetails: OFFICE_DETAILS };
}

/**
 * A crew-owned candidate row. `carded` puts a history entry INSIDE
 * `displayDetails` — `route.ts`'s `toCandidate` reads `details.cards` there
 * (`:236`), not a top-level column, to decide `everCarded` (`:249`).
 */
function row(id: string, owner: string, carded = false): ScanRow {
    const details: Record<string, unknown> = {
        amountCents: -4000, owner, postedDate: "2026-01-05", payee: "SUPPLY CO", fingerprint: `pb-${id}`,
    };
    if (carded) details.cards = [{ requestId: `receipt-req-${owner}-2026-01-02` }];
    const r: ScanRow = {
        id, targetKey: `bl-${id}`, reasonCodes: '["MISSING_RECEIPT"]', acknowledgedCodes: "[]",
        displayDetails: JSON.stringify(details),
    };
    byId.set(id, r);
    return r;
}

function seedCertified(): void {
    const today = new Date().toISOString().slice(0, 10);
    settings.set("receiptRequestsCycle", JSON.stringify({
        id: "cycle-test", epoch: "1", evidenceEpoch: "1",
        recognitionPolicy: "receipt-source-v1:off", plannerDay: today,
    }));
    settings.set("receiptRequestsPhase", JSON.stringify({
        phase: "done", chaserCompletedAt: new Date().toISOString(),
        completedCycleId: "cycle-test", blockedReason: null,
    }));
}

/** A PENDING, unclaimed card for today, shaped like round 35's seedClaimedCard. */
function seedTodayCard(owner: string, issueId: string): void {
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    cards.set(`${owner}|${date}`, {
        id: `card-${owner}`,
        owner,
        pacificDate: date,
        itemsJson: JSON.stringify([{
            n: 1, issueId, fingerprint: `pb-${issueId}`, cents: 4000, amount: "40.00",
            date: "2026-01-05", vendor: "SUPPLY CO", cardTail: null, targetKey: `bl-${issueId}`,
        }]),
        overflow: 0,
        overflowExact: true,
        status: "PENDING",
        postedAt: null,
        claimedAt: null,
        claimToken: null,
        attempts: 0,
    });
    // So the send-time recheck finds it too.
    row(issueId, owner);
}

function reset(): void {
    mode = "queue";
    queue = [];
    pageOneRows = [];
    endlessPage = 0;
    byId = new Map();
    cards = new Map();
    postCalls = [];
    creates = 0;
    executed = [];
    onScanPage = null;
    settings = new Map();
    errorCalls = [];
    offsetMs = 0;
}

/**
 * The `$queryRaw`, both call forms. The run lease passes a `Prisma.sql`
 * object (`route.ts:218-220`; not an array, with a `.strings` array, checked
 * on Prisma 5.22.0). Every other call is a tagged template.
 */
const sqlText = (first: unknown): string => Array.isArray(first)
    ? (first as readonly string[]).join("?")
    : ((first as { strings?: readonly string[] }).strings ?? []).join("?");

const cardsPrisma: Record<string, unknown> = {
    $queryRaw: async (first: unknown) => {
        const text = sqlText(first);
        if (text.includes("pg_try_advisory_xact_lock")) return [{ locked: true }]; // run lease
        if (text.includes("ReceiptRequestCard")) return [];                        // queued-resend drain
        if (text.includes("AutomationSetting")) return [{ value: "1" }];           // evidence, bank, owner epochs
        return [];
    },
    // Only claimOwnerDay runs raw SQL on this path: SET LOCAL lock_timeout
    // (route.ts:600) and the evidence advisory lock (receipt-evidence-lock.ts:66).
    $executeRaw: async (strings: TemplateStringsArray) => { executed.push(strings.join("?")); return 0; },
    receiptRequestCardDelivery: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "del-1", ...data }),
        deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (arg: unknown) =>
        (typeof arg === "function" ? await (arg as (tx: unknown) => Promise<unknown>)(cardsPrisma) : arg),
    automationSetting: settingStore,
    receiptMemoArtifact: { findMany: async () => [] },
    reviewIssue: {
        findMany: async (args: {
            where: { id?: { in: string[] } };
            take?: number;
            cursor?: { id: string };
            skip?: number;
        }) => {
            // The send-time recheck asks by id; everything else is the scan.
            if (args.where.id?.in) {
                const wanted = new Set(args.where.id.in);
                return [...byId.values()].filter(r => wanted.has(r.id)).map(r => ({ ...r, clearedAt: null }));
            }
            if (mode === "endless") {
                endlessPage++;
                const page: ScanRow[] = endlessPage === 1 ? [...pageOneRows] : [];
                const size = args.take ?? 500;
                while (page.length < size) page.push(officeRow(`ri-office-${endlessPage}-${page.length}`));
                onScanPage?.();
                return page;
            }
            const at = args.cursor ? queue.findIndex(r => r.id === args.cursor!.id) : -1;
            const from = args.cursor ? at + (args.skip ?? 0) : 0;
            if (args.cursor && at < 0) return [];
            const page = queue.slice(Math.max(from, 0), Math.max(from, 0) + (args.take ?? queue.length));
            onScanPage?.();
            return page;
        },
    },
    receiptRequestCard: {
        findUnique: async ({ where }: { where: { owner_pacificDate: { owner: string; pacificDate: string } } }) =>
            cards.get(`${where.owner_pacificDate.owner}|${where.owner_pacificDate.pacificDate}`) ?? null,
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => {
            creates++;
            const key = `${data.owner as string}|${data.pacificDate as string}`;
            const row = { id: `card-${cards.size + 1}`, status: "PENDING", postedAt: null, ...data };
            cards.set(key, row);
            return row;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (const r of cards.values()) {
                if (!cardMatches(r, where)) continue;
                for (const [key, value] of Object.entries(data)) {
                    if (value && typeof value === "object" && "increment" in (value as object)) {
                        r[key] = ((r[key] as number) ?? 0) + (value as { increment: number }).increment;
                    } else {
                        r[key] = value;
                    }
                }
                count++;
            }
            return { count };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
            let count = 0;
            for (const [key, r] of [...cards.entries()]) {
                if (!cardMatches(r, where)) continue;
                cards.delete(key);
                count++;
            }
            return { count };
        },
    },
};

let cardsGET: (request: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    const patch = (resolve: (id: string) => unknown) => {
        (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
            this: NodeModule,
            id: string,
        ) {
            const hit = resolve(id);
            if (hit !== undefined) return hit;
            // eslint-disable-next-line prefer-rest-params
            return originalRequire.apply(this, arguments as unknown as [string]);
        } as typeof Module.prototype.require;
    };

    // The real module, loaded BEFORE the patch that shadows it, so the spread
    // below is the genuine implementation rather than a second stub.
    const realCards = await import("../src/lib/receipt-request-cards");
    patch(id => {
        if (id === "@/lib/prisma") return { prisma: cardsPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/receipt-card-history") {
            return { recordCardOnIssues: async () => undefined, itemsMissingCardRecord: async () => [] };
        }
        // The real recompute walks competing components against a database.
        // "still missing" keeps the item on the card, which is what every
        // test here needs from it — none is about the matcher.
        if (id === "@/app/api/cron/receipt-requests/route") return { recomputeCodesFor: async () => ["MISSING_RECEIPT"] };
        if (id === "@/lib/receipt-request-cards") {
            return {
                ...realCards,
                // The cron refuses to run at the weekend and CI runs whenever
                // it runs. Nothing under test here is about the calendar.
                isPacificWeekday: () => true,
                postOwnerCard: async (_url: string, card: OwnerCard, options: { timeoutMs?: number } = {}) => {
                    postCalls.push({ owner: card.owner, timeoutMs: options.timeoutMs });
                    return { kind: "delivered", owner: card.owner, threadName: "spaces/TESTSPACE/threads/t", messageName: "spaces/TESTSPACE/messages/m" };
                },
            };
        }
        return undefined;
    });
    let cardsMod: { GET?: unknown };
    try {
        cardsMod = await import("../src/app/api/cron/receipt-request-cards/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof cardsMod.GET !== "function") throw new Error("the receipt-request-cards cron did not load");
    cardsGET = cardsMod.GET as typeof cardsGET;
});

/** Drive the real cron with a frozen clock, capturing console.error. */
async function runGET(query = ""): Promise<Record<string, unknown>> {
    const realNow = Date.now;
    const frozenAt = realNow();
    offsetMs = 0;
    Date.now = () => frozenAt + offsetMs;
    const realError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    try {
        const res = await cardsGET(new Request(`https://probuild.test/api/cron/receipt-request-cards${query}`));
        return await res.json() as Record<string, unknown>;
    } finally {
        Date.now = realNow;
        console.error = realError;
    }
}

/** The scan-incomplete line, parsed, or null if this run never logged one. */
function scanIncompleteLine(): Record<string, unknown> | null {
    for (const args of errorCalls) {
        if (args[0] === "[cron/receipt-request-cards] scan-incomplete") {
            return JSON.parse(args[1] as string) as Record<string, unknown>;
        }
    }
    return null;
}

const todayPacific = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

// ── Tests ─────────────────────────────────────────────────────────────────

test("a read stopped by the page cap claims no owner's day, even for an owner it saw", async () => {
    reset();
    seedCertified();
    mode = "endless";
    pageOneRows = [row("ri-cj-asked", "CJ", true)];

    const summary = await runGET();

    assert.equal(summary.scanExhausted, false);
    assert.equal(summary.scanPages, 200);
    assert.equal(summary.scanDeadlineHit, false);
    assert.equal(summary.scanIncomplete, true);
    assert.equal(summary.ok, false);
    assert.equal(summary.claimed, 0);
    assert.deepEqual(summary.claimRefused, []);
    assert.deepEqual(summary.posted, []);
    assert.deepEqual(executed, []);
    assert.equal(creates, 0);
    assert.deepEqual(postCalls, []);

    const line = scanIncompleteLine();
    assert.ok(line, "the scan-incomplete line was not logged");
    assert.equal(line!.pages, 200);
    assert.equal(line!.deadlineHit, false);
    assert.equal(line!.candidates, 1);
});

test("a complete read still selects, never-asked first", async () => {
    reset();
    seedCertified();
    mode = "queue";
    queue = [row("ri-office-1", "office"), row("ri-cj-asked", "CJ", true), row("ri-cj-new", "CJ")];

    const summary = await runGET();

    assert.equal(summary.scanExhausted, true);
    assert.equal(summary.scanIncomplete, false);
    assert.equal(summary.ok, true);
    assert.equal(summary.claimed, 1);
    // Two raw statements ran — this is what makes T1's empty `executed`
    // meaningful, and what actually proves the claim certified.
    assert.equal(executed.length, 2);
    assert.match(executed[0], /SET LOCAL lock_timeout/);
    assert.equal(creates, 1);
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].owner, "CJ");

    const cjCard = cards.get(`CJ|${todayPacific()}`);
    assert.ok(cjCard, "CJ's card row was never created");
    assert.equal(cjCard!.status, "POSTED");
    const items = JSON.parse(cjCard!.itemsJson as string) as Array<{ issueId: string; n: number }>;
    assert.deepEqual(items.map(i => i.issueId), ["ri-cj-new", "ri-cj-asked"]);
    assert.deepEqual(items.map(i => i.n), [1, 2]);

    assert.equal(scanIncompleteLine(), null);
});

test("on the retry pass, a page-cap stop still sends a card claimed earlier today, and selects nothing new", async () => {
    reset();
    seedCertified();
    mode = "endless";
    pageOneRows = [row("ri-cj-asked", "CJ", true)];
    seedTodayCard("Richard", "ri-rich-1");

    const summary = await runGET("?retry=1");

    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].owner, "Richard");
    const posted = summary.posted as Array<{ owner: string; resumed: boolean }>;
    assert.equal(posted.length, 1);
    assert.equal(posted[0].owner, "Richard");
    assert.equal(posted[0].resumed, true);
    const richCard = cards.get(`Richard|${todayPacific()}`);
    assert.ok(richCard);
    assert.equal(richCard!.status, "POSTED");
    // creates/executed, not claimed — claimed counts resumed rows too
    // (route.ts:1570 — 1609 here).
    assert.equal(creates, 0);
    assert.deepEqual(executed, []);
    assert.equal(summary.scanIncomplete, true);
    assert.equal(summary.ok, false);
});

test("source pin: selection waits for a complete read", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-request-cards/route.ts"),
        "utf8",
    );
    const selectionAllowedIdx = source.indexOf("if (!selectionAllowed) continue;");
    const scanIncompleteContinueIdx = source.indexOf("if (scanIncomplete) continue;");
    const selectOwnerItemsIdx = source.indexOf("selectOwnerItems(scan.candidates, owner)");
    assert.ok(selectionAllowedIdx >= 0, "if (!selectionAllowed) continue; not found");
    assert.ok(scanIncompleteContinueIdx >= 0, "if (scanIncomplete) continue; not found");
    assert.ok(selectOwnerItemsIdx >= 0, "selectOwnerItems(scan.candidates, owner) not found");
    assert.ok(selectionAllowedIdx < scanIncompleteContinueIdx, "the selectionAllowed check must come first");
    assert.ok(scanIncompleteContinueIdx < selectOwnerItemsIdx, "scanIncomplete must be checked before selection");

    const writeScanCursorIdx = source.indexOf("await writeScanCursor(scan.nextCursor)");
    const scanIncompleteDeclIdx = source.indexOf("const scanIncomplete = selectionAllowed && !scan.exhausted;");
    assert.ok(writeScanCursorIdx >= 0, "await writeScanCursor(scan.nextCursor) not found");
    assert.ok(scanIncompleteDeclIdx >= 0, "const scanIncomplete = … not found");
    assert.ok(writeScanCursorIdx < scanIncompleteDeclIdx, "the cursor must be written before scanIncomplete is computed");

    assert.ok(source.includes("ok: failures.length === 0 && uncertainTransitions.length === 0 && !scanIncomplete,"));
});

test("a read cut by the clock claims nothing, even for an owner it saw, and a card claimed earlier waits intact for the next run", async () => {
    reset();
    seedCertified();
    mode = "queue";
    // 1 + 500 = 501 rows: page 1 (take 500) comes back full, so the scan
    // wants a second page.
    queue = [row("ri-rich-new", "Richard"), ...Array.from({ length: 500 }, (_, i) => officeRow(`ri-office-t5-${i}`))];
    seedTodayCard("CJ", "ri-cj-1");
    onScanPage = () => { offsetMs = 50_000; };

    const summary = await runGET();

    assert.equal(summary.scanPages, 1);
    assert.equal(summary.scanDeadlineHit, true);
    assert.equal(summary.scanExhausted, false);
    assert.equal(summary.scanIncomplete, true);
    assert.equal(summary.ok, false);
    assert.deepEqual(executed, []);
    assert.equal(creates, 0);
    assert.deepEqual(postCalls, []);
    assert.equal(cards.has(`Richard|${todayPacific()}`), false, "no card row for Richard today");

    assert.deepEqual(summary.sendDeferredOwners, ["CJ"]);
    assert.equal(summary.deferredReason, "send-deferred");
    const cjCard = cards.get(`CJ|${todayPacific()}`);
    assert.ok(cjCard);
    assert.equal(cjCard!.status, "PENDING");
    assert.equal(cjCard!.postedAt, null);
    assert.equal(cjCard!.claimedAt, null);
    assert.equal(cjCard!.claimToken, null);
    const items = JSON.parse(cjCard!.itemsJson as string) as Array<{ issueId: string }>;
    assert.deepEqual(items.map(i => i.issueId), ["ri-cj-1"]);

    const line = scanIncompleteLine();
    assert.ok(line, "the scan-incomplete line was not logged");
    assert.equal(line!.pages, 1);
    assert.equal(line!.deadlineHit, true);
    assert.equal(line!.candidates, 1);
});

test("a complete read whose send is deferred for time is still ok", async () => {
    reset();
    seedCertified();
    mode = "queue";
    queue = [row("ri-office-1", "office")];
    seedTodayCard("CJ", "ri-cj-1");
    onScanPage = () => { offsetMs = 50_000; };

    const summary = await runGET();

    assert.equal(summary.scanExhausted, true);
    assert.equal(summary.scanIncomplete, false);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.sendDeferredOwners, ["CJ"]);
    assert.equal(summary.deferredReason, "send-deferred");
    assert.deepEqual(postCalls, []);
    assert.deepEqual(executed, []);
    assert.equal(scanIncompleteLine(), null);
});
