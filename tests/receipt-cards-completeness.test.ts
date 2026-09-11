import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { ComponentTooLargeError } from "../src/lib/receipt-requests";
import type { ReasonCode } from "../src/lib/review-alert-reasons";
import type { CardItem, CardItemTruth } from "../src/lib/receipt-request-cards";

/**
 * Card eligibility is a STRICT question.
 *
 * `recomputeCodesFor` has two modes. The sweep's default is lenient: a
 * competing component that overflows the walk's line cap answers
 * MISSING_RECEIPT so the issue stays OPEN, which preserves the existing
 * reconciliation review hold. Read by the scheduled
 * card cron, that same answer used to become a send approval: `length === 0`
 * was false, the item read as genuinely unanswered, and a person was chased
 * on evidence nobody had actually examined. Overflow is incomplete evidence,
 * not a verdict.
 *
 * So the scheduled default adapter asks strictly (fourth argument `true`) and
 * lets `ComponentTooLargeError` reach the scheduled send loop, which defers
 * that card and releases its claim. The handler regression separately verifies
 * snapshot preservation and an independent owner proceeding. These tests prove that through the REAL adapter with an
 * ACTUAL oversized component (the same seam
 * tests/receipt-on-demand-completeness.test.ts overflows), and prove the fix
 * does not over-block: a genuinely missing receipt on a small component is
 * still sendable, an item already answered is dropped without a walk, and a
 * spent budget is still checked before the walk begins.
 *
 * SYNTHETIC ONLY. Every row is fictional. `@/lib/prisma` is replaced through
 * the same scoped CJS require() patch the neighbouring tests use
 * (`mock.module` corrupts the require chain on the Node 20 CI pins), all
 * network is denied, and the database URL points at a discard port.
 */

process.env.DATABASE_URL = "postgresql://fiction:fiction@127.0.0.1:9/fiction?pgbouncer=true";
process.env.NEXTAUTH_SECRET = "fictional-test-only";
process.env.RECEIPT_REQUEST_CARDS_ENABLED = "false";
delete process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED;
delete process.env.RECEIPT_REVIEWED_SOURCE_FACTS_JSON;
delete process.env.RECEIPT_REVIEWED_SOURCE_FACTS_SHA256;
delete process.env.RECEIPTS_CHAT_WEBHOOK;

/** Every network call is a failure of the thing under test. Counted AND denied. */
let fetchCalls = 0;
globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("NETWORK DENIED");
}) as unknown as typeof fetch;

// -- Fixtures ----------------------------------------------------------------

/**
 * One more line than the component walk accepts: the same count
 * tests/receipt-on-demand-completeness.test.ts proves overflows.
 */
const OVERFLOW_LINES = 201;

const line = {
    id: "fictional-target",
    postedDate: new Date("2026-01-12T00:00:00Z"),
    amountCents: -12_345,
    rawDescriptor: "FICTIONAL STORE",
    checkNumber: null,
    updatedAt: new Date("2026-01-12T00:00:00Z"),
    account: "WTB-0723",
    sourceOfRecord: "STATEMENT",
};

/** A component too large to walk: the walk sees these however it asks. */
const oversizedComponent = () => Array.from({ length: OVERFLOW_LINES }, (_, i) => ({ ...line, id: `${line.id}-${i}` }));
/** A component of one: the charge competes with nothing. */
const singletonComponent = () => [line];
/** Any read of the component is itself the failure. */
const untouchableComponent = (why: string) => () => { throw new Error(`bankLine.findMany was called: ${why}`); };

interface FakeIssueRow {
    id: string;
    targetKey: string;
    clearedAt: Date | null;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}

function issueRow(id: string, targetKey: string, displayDetails: string | null = null): FakeIssueRow {
    return { id, targetKey, clearedAt: null, reasonCodes: "[]", acknowledgedCodes: "[]", displayDetails };
}

function cardItem(issueId: string, targetKey: string): CardItem {
    return { n: 1, fingerprint: `pb-${targetKey}`, date: "2026-01-12", vendor: "FICTIONAL STORE", cents: 12_345, amount: "123.45", cardTail: null, issueId, targetKey };
}

let issues: FakeIssueRow[] = [];
let memoBindings: Array<{ targetKey: string; pdfId: string }> = [];
let componentLines: () => Array<typeof line> = singletonComponent;

// -- The fake database -------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * A table this file does not describe answers "nothing here". The real
 * recompute's evidence load reaches for whichever tables carry receipts,
 * intakes and memos; for a synthetic charge that has none of them, an empty
 * answer from every one of those IS the truth.
 */
function emptyModel(): Row {
    return new Proxy({} as Row, {
        get(_target, method) {
            if (typeof method !== "string" || method === "then") return undefined;
            return async (): Promise<unknown> => {
                switch (method) {
                    case "findMany":
                    case "groupBy":
                        return [];
                    case "count":
                        return 0;
                    case "createMany":
                    case "updateMany":
                    case "deleteMany":
                        throw new Error("Unexpected database mutation: " + method);
                    case "aggregate":
                        return {};
                    default:
                        return null;
                }
            };
        },
    });
}

/** A described table: the listed methods, and "nothing here" for the rest. */
function model(described: Row): Row {
    const rest = emptyModel();
    return new Proxy(described, {
        get(target, method) {
            if (typeof method !== "string" || method === "then") return undefined;
            return target[method] ?? rest[method];
        },
    });
}

const tables: Record<string, Row> = {
    bankLine: model({
        findUnique: async () => line,
        findMany: async () => componentLines(),
        count: async () => componentLines().length,
    }),
    reviewIssue: model({
        findMany: async ({ where }: { where?: { id?: { in?: unknown } } } = {}) => {
            const ids = where?.id?.in;
            return Array.isArray(ids) ? issues.filter(row => ids.includes(row.id)) : [];
        },
        findUnique: async ({ where }: { where?: { id?: unknown } } = {}) => issues.find(row => row.id === where?.id) ?? null,
    }),
    receiptMemoArtifact: model({
        findMany: async () => memoBindings,
        findUnique: async () => null,
    }),
};

const fakePrisma: Row = new Proxy(tables, {
    get(target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$transaction") {
            return async (work: unknown) => typeof work === "function"
                ? (work as (tx: Row) => Promise<unknown>)(fakePrisma)
                : Promise.all(work as Array<Promise<unknown>>);
        }
        if (prop === "$queryRaw" || prop === "$queryRawUnsafe") return async () => [];
        if (prop === "$executeRaw" || prop === "$executeRawUnsafe") return async () => { throw new Error("Unexpected raw mutation"); };
        if (prop.startsWith("$")) return async () => undefined;
        return target[prop] ?? (target[prop] = emptyModel());
    },
});

// -- Loading the real modules against the fake -------------------------------

type Recompute = (
    targetKey: string,
    cache?: Map<string, ReasonCode[]>,
    deadlineExceeded?: () => boolean,
    strict?: boolean,
) => Promise<ReasonCode[]>;

type LoadCardItemTruth = (
    issueIds: string[],
    deps?: { cache?: Map<string, ReasonCode[]>; recompute?: Recompute; deadlineExceeded?: () => boolean },
) => Promise<Map<string, CardItemTruth>>;

let loadCardItemTruth: LoadCardItemTruth;
let recomputeCodesFor: Recompute;
let rebuildCardItems: typeof import("../src/lib/receipt-request-cards").rebuildCardItems;

before(async () => {
    const originalRequire = Module.prototype.require;
    let prismaPatched = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma" || /(?:^|\/)prisma$/.test(id)) {
            prismaPatched = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    try {
        const cards: { loadCardItemTruth?: unknown } = await import("../src/app/api/cron/receipt-request-cards/route");
        const requests: { recomputeCodesFor?: unknown } = await import("../src/app/api/cron/receipt-requests/route");
        const lib = await import("../src/lib/receipt-request-cards");
        loadCardItemTruth = cards.loadCardItemTruth as LoadCardItemTruth;
        recomputeCodesFor = requests.recomputeCodesFor as Recompute;
        rebuildCardItems = lib.rebuildCardItems;
    } finally {
        Module.prototype.require = originalRequire;
    }
    assert.equal(prismaPatched, true, "the require patch never saw @/lib/prisma; these tests would be talking to a real client");
    assert.equal(typeof loadCardItemTruth, "function");
    assert.equal(typeof recomputeCodesFor, "function");
});

after(() => {
    assert.equal(fetchCalls, 0, "no card, no webhook, nothing on the network at any point");
});

// -- The seam: the scheduled default asks strictly ---------------------------

test("the scheduled default asks the STRICT question: recompute is called with strict=true, sharing this card's cache and deadline", async () => {
    componentLines = untouchableComponent("an injected recompute must be the only thing consulted");
    issues = [issueRow("ri-strict", "bl-strict")];
    const calls: unknown[][] = [];
    const cache = new Map<string, ReasonCode[]>();
    const deadlineExceeded = () => false;
    const recompute = async (...args: unknown[]): Promise<ReasonCode[]> => {
        calls.push(args);
        return [];
    };

    const truth = await loadCardItemTruth(["ri-strict"], { cache, recompute, deadlineExceeded });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "bl-strict");
    assert.equal(calls[0][1], cache, "the per-card cache is handed down unchanged");
    assert.equal(calls[0][2], deadlineExceeded, "the run's clock is handed down unchanged");
    assert.equal(calls[0][3], true, "the card adapter asks strictly; the lenient default belongs to the sweep, not to a chase");
    // Answered evidence through the seam: an empty code set reads as evidence
    // found, and the rebuild drops the item rather than asking again.
    const verdict = truth.get("ri-strict")!;
    assert.equal(verdict.evidenceSatisfied, true);
    assert.deepEqual(
        rebuildCardItems([cardItem("ri-strict", "bl-strict")], truth, verdict.owner).dropped,
        [{ issueId: "ri-strict", reason: "evidence-found" }],
    );
});

// -- The real adapter against an ACTUAL overflow -----------------------------

test("REAL adapter, ACTUAL overflow: revalidation rejects with ComponentTooLargeError, so the send loop never reaches a post", async () => {
    componentLines = oversizedComponent;
    issues = [issueRow("ri-overflow", line.id)];

    await assert.rejects(
        loadCardItemTruth(["ri-overflow"], { deadlineExceeded: () => false }),
        (error: unknown) => {
            assert.ok(error instanceof ComponentTooLargeError);
            assert.equal(error.count, 201);
            assert.equal(error.cap, 200);
            return true;
        },
        "overflow is incomplete evidence: it must surface as an error, never as a MISSING_RECEIPT verdict the card would send",
    );
    assert.equal(fetchCalls, 0, "nothing was posted");
});

test("the ordinary reconciliation default stays lenient: the sweep still keeps an overflowed issue OPEN rather than throwing", async () => {
    componentLines = oversizedComponent;
    assert.deepEqual(await recomputeCodesFor(line.id), ["MISSING_RECEIPT"]);
});

// -- Strictness must not over-block ------------------------------------------

test("a genuinely missing receipt on a small component is still sendable through the REAL adapter", async () => {
    componentLines = singletonComponent;
    issues = [issueRow("ri-missing", line.id)];

    const truth = await loadCardItemTruth(["ri-missing"], { deadlineExceeded: () => false });

    const verdict = truth.get("ri-missing")!;
    assert.equal(verdict.revalidationSkipped, undefined, "the walk ran to completion");
    assert.equal(verdict.evidenceSatisfied, false, "no receipt, no booked intake, no signed memo: legitimately still missing");
    assert.equal(verdict.resolved, false);
    assert.equal(verdict.clearedAt, null);
    const rebuilt = rebuildCardItems([cardItem("ri-missing", line.id)], truth, verdict.owner);
    assert.deepEqual(rebuilt.dropped, []);
    assert.equal(rebuilt.items.length, 1, "a completed, genuinely missing item is exactly what a card is for");
});

test("an item already answered by a bound signed memo is dropped as resolved without opening its component, even one that would overflow", async () => {
    componentLines = untouchableComponent("a cheaper check already answered this item");
    issues = [issueRow("ri-memo", line.id, JSON.stringify({ resolution: "memo-signed", pdfId: "pdf-fictional-1" }))];
    memoBindings = [{ targetKey: line.id, pdfId: "pdf-fictional-1" }];
    try {
        const truth = await loadCardItemTruth(["ri-memo"], { deadlineExceeded: () => false });
        const verdict = truth.get("ri-memo")!;
        assert.equal(verdict.resolved, true);
        assert.deepEqual(
            rebuildCardItems([cardItem("ri-memo", line.id)], truth, verdict.owner).dropped,
            [{ issueId: "ri-memo", reason: "resolved" }],
        );
    } finally {
        memoBindings = [];
    }
});

test("a spent revalidation budget is checked BEFORE the strict walk: the component is never opened and the item is skipped, not chased", async () => {
    componentLines = untouchableComponent("the budget was already gone");
    issues = [issueRow("ri-late", line.id)];

    const truth = await loadCardItemTruth(["ri-late"], { deadlineExceeded: () => true });

    const verdict = truth.get("ri-late")!;
    assert.equal(verdict.revalidationSkipped, true);
    assert.equal(verdict.evidenceSatisfied, false, "an unverified item must not read as answered");
    assert.deepEqual(
        rebuildCardItems([cardItem("ri-late", line.id)], truth, verdict.owner).dropped,
        [{ issueId: "ri-late", reason: "revalidation-deadline" }],
    );
});
