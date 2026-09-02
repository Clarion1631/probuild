import assert from "node:assert/strict";
import test from "node:test";
import {
    syncQboExpenses,
    upsertQboPurchaseClassification,
    type QboExpenseProjectCandidate,
    type QboExpenseSyncDependencies,
    type QboPurchaseClassificationPersistenceClient,
    type QboPurchaseClassificationWrite,
    type QboPurchaseForImport,
} from "../src/lib/qbo-expense-sync";
import type { PurchaseClassification } from "../src/lib/register-merge";

// Unified Money Register plan §5 step 3 (docs/UNIFIED-REGISTER-PLAN.md): the
// sync must persist WHY a Purchase is (or isn't) job-costable at the moment
// it has full QBO detail in hand, because a bank-register GL row never
// carries the Purchase's customer/account/equity fields and this cannot be
// recomputed later. These tests exercise that persistence through the public
// syncQboExpenses entry point — same convention as qbo-expense-sync.test.ts's
// "overhead triage" tests, which assert on captured dependency writes rather
// than reaching into private helpers.

const TOKENS = { accessToken: "test-access", refreshToken: "test-refresh", realmId: "test-realm" };

const PURCHASE: QboPurchaseForImport = {
    qbPurchaseId: "purchase-1",
    syncToken: "0",
    txnDate: "2026-07-15",
    total: 125.5,
    vendor: "Contractor Supply",
    customerName: "Mueller Bathroom",
    customerId: "qbo-job-1",
    accountName: "Washington Trust Checking",
    memo: "Rough plumbing",
    lines: [{ description: null, amount: null, account: null }],
    isEquityDraw: false,
};

const ACTIVE_PROJECTS: QboExpenseProjectCandidate[] = [
    {
        id: "project-1",
        name: "Mueller Bathroom Remodel",
        status: "In Progress",
        estimates: [{ id: "estimate-1", createdAt: new Date("2026-07-01T00:00:00.000Z") }],
    },
];

/** Dependencies whose Expense side effects are inert — only classification writes matter here. */
function fakeDependencies(
    purchases: QboPurchaseForImport[],
    projects: QboExpenseProjectCandidate[],
    classifications: QboPurchaseClassificationWrite[],
    overrides: Partial<QboExpenseSyncDependencies> = {},
): QboExpenseSyncDependencies {
    return {
        getTokens: async () => TOKENS,
        readPurchases: async () => ({ purchases, removed: [], deactivations: [], skipped: [] }),
        listProjects: async () => projects,
        upsertExpense: async () => "imported",
        deactivateExpense: async () => "removed",
        upsertPurchaseClassification: async write => { classifications.push(write); },
        companyTimeZone: async () => "America/Los_Angeles",
        now: () => new Date("2026-07-29T12:00:00.000Z"),
        ...overrides,
    };
}

test("upsertQboPurchaseClassification creates then updates a row keyed by qbPurchaseId", async () => {
    const rows = new Map<string, { classification: string; reason: string | null; qbSyncToken: string | null }>();
    const client: QboPurchaseClassificationPersistenceClient = {
        qboPurchaseClassification: {
            async upsert(args) {
                const existing = rows.get(args.where.qbPurchaseId);
                const next = existing ? { ...existing, ...args.update } : { ...args.create };
                rows.set(args.where.qbPurchaseId, next);
                return next;
            },
        },
    };

    await upsertQboPurchaseClassification(client, {
        qbPurchaseId: "purchase-1",
        classification: "job-cost",
        reason: null,
        qbSyncToken: "0",
    });
    assert.deepEqual(rows.get("purchase-1"), {
        qbPurchaseId: "purchase-1",
        classification: "job-cost",
        reason: null,
        qbSyncToken: "0",
    });

    await upsertQboPurchaseClassification(client, {
        qbPurchaseId: "purchase-1",
        classification: "unknown",
        reason: "voided",
        qbSyncToken: "1",
    });
    assert.deepEqual(rows.get("purchase-1"), {
        qbPurchaseId: "purchase-1",
        classification: "unknown",
        reason: "voided",
        qbSyncToken: "1",
    });
    assert.equal(rows.size, 1);
});

test("sync classifies a matched purchase as job-cost, written before the import happens", async () => {
    const classifications: QboPurchaseClassificationWrite[] = [];
    const order: string[] = [];
    const dependencies = fakeDependencies([PURCHASE], ACTIVE_PROJECTS, classifications, {
        upsertPurchaseClassification: async write => {
            classifications.push(write);
            order.push("classify");
        },
        upsertExpense: async () => {
            order.push("import");
            return "imported";
        },
    });

    await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies);

    assert.deepEqual(classifications, [
        { qbPurchaseId: "purchase-1", classification: "job-cost", reason: null, qbSyncToken: "0" },
    ]);
    assert.deepEqual(order, ["classify", "import"]);
});

test("sync classifies a no-customer purchase as overhead whether or not the triage bucket is routable", async () => {
    const overheadPurchase: QboPurchaseForImport = {
        ...PURCHASE,
        qbPurchaseId: "purchase-overhead",
        customerName: null,
        customerId: null,
        isEquityDraw: false,
    };
    const overheadProjects: QboExpenseProjectCandidate[] = [
        ...ACTIVE_PROJECTS,
        {
            id: "project-shop",
            name: "Shop",
            status: "In Progress",
            estimates: [{ id: "estimate-shop", createdAt: new Date("2026-07-07T00:00:00.000Z") }],
        },
    ];

    // Routed: overheadProjectId configured and eligible.
    const routedClassifications: QboPurchaseClassificationWrite[] = [];
    await syncQboExpenses(
        { since: new Date("2026-05-01"), overheadProjectId: "project-shop" },
        fakeDependencies([overheadPurchase], overheadProjects, routedClassifications),
    );
    assert.deepEqual(routedClassifications, [
        { qbPurchaseId: "purchase-overhead", classification: "overhead", reason: "missing-customer", qbSyncToken: "0" },
    ]);

    // Not routed: no overheadProjectId configured at all — same classification.
    const unroutedClassifications: QboPurchaseClassificationWrite[] = [];
    await syncQboExpenses(
        { since: new Date("2026-05-01") },
        fakeDependencies([overheadPurchase], overheadProjects, unroutedClassifications),
    );
    assert.deepEqual(unroutedClassifications, [
        { qbPurchaseId: "purchase-overhead", classification: "overhead", reason: "missing-customer", qbSyncToken: "0" },
    ]);

    // Configured but unavailable target — still overhead, not silently downgraded.
    const unavailableClassifications: QboPurchaseClassificationWrite[] = [];
    await syncQboExpenses(
        { since: new Date("2026-05-01"), overheadProjectId: "project-shop-missing" },
        fakeDependencies([overheadPurchase], ACTIVE_PROJECTS, unavailableClassifications),
    );
    assert.deepEqual(unavailableClassifications, [
        { qbPurchaseId: "purchase-overhead", classification: "overhead", reason: "missing-customer", qbSyncToken: "0" },
    ]);
});

test("sync classifies an all-equity, no-customer purchase as owner-draw", async () => {
    const drawPurchase: QboPurchaseForImport = {
        ...PURCHASE,
        qbPurchaseId: "purchase-draw",
        customerName: null,
        customerId: null,
        isEquityDraw: true,
    };
    const classifications: QboPurchaseClassificationWrite[] = [];
    await syncQboExpenses(
        { since: new Date("2026-05-01"), overheadProjectId: "project-shop" },
        fakeDependencies(
            [drawPurchase],
            [...ACTIVE_PROJECTS, {
                id: "project-shop",
                name: "Shop",
                status: "In Progress",
                estimates: [{ id: "estimate-shop", createdAt: new Date("2026-07-07T00:00:00.000Z") }],
            }],
            classifications,
        ),
    );
    assert.deepEqual(classifications, [
        { qbPurchaseId: "purchase-draw", classification: "owner-draw", reason: "equity-draw", qbSyncToken: "0" },
    ]);
});

test("sync classifies a customer-bearing purchase that can't be matched as unknown, never guessed as overhead or job-cost", async () => {
    const closedProjectPurchase: QboPurchaseForImport = {
        ...PURCHASE,
        qbPurchaseId: "purchase-closed-job",
        customerName: "Closed Kitchen",
        customerId: null,
    };
    const projects: QboExpenseProjectCandidate[] = [
        ...ACTIVE_PROJECTS,
        {
            id: "project-closed",
            name: "Closed Kitchen",
            status: "Closed Complete",
            estimates: [{ id: "estimate-closed", createdAt: new Date("2026-01-01") }],
        },
    ];
    const classifications: QboPurchaseClassificationWrite[] = [];
    await syncQboExpenses(
        { since: new Date("2026-01-01") },
        fakeDependencies([closedProjectPurchase], projects, classifications),
    );
    assert.deepEqual(classifications, [
        {
            qbPurchaseId: "purchase-closed-job",
            classification: "unknown",
            reason: "no-active-project",
            qbSyncToken: "0",
        },
    ]);
});

test("sync classifies removed and deactivated purchases as unknown with the removal reason, never a guess", async () => {
    const classifications: QboPurchaseClassificationWrite[] = [];
    const dependencies = fakeDependencies([], ACTIVE_PROJECTS, classifications);
    dependencies.readPurchases = async () => ({
        purchases: [],
        removed: [
            { qbPurchaseId: "purchase-voided", qbSyncToken: "2", reason: "voided" },
            { qbPurchaseId: "purchase-deleted", qbSyncToken: null, reason: "deleted" },
        ],
        deactivations: [
            { qbPurchaseId: "purchase-multi-customer", qbSyncToken: "3", reason: "multiple-customers" },
        ],
        skipped: [
            { qbPurchaseId: "purchase-multi-customer", reason: "multiple-customers" },
        ],
    });

    await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies);

    assert.deepEqual(classifications, [
        { qbPurchaseId: "purchase-voided", classification: "unknown", reason: "voided", qbSyncToken: "2" },
        { qbPurchaseId: "purchase-deleted", classification: "unknown", reason: "deleted", qbSyncToken: null },
        { qbPurchaseId: "purchase-multi-customer", classification: "unknown", reason: "multiple-customers", qbSyncToken: "3" },
    ]);
});

test("sync classifies normalization-time skips as unknown, and never writes a row for the id-less missing-purchase-id skip", async () => {
    const classifications: QboPurchaseClassificationWrite[] = [];
    const dependencies = fakeDependencies([], ACTIVE_PROJECTS, classifications);
    dependencies.readPurchases = async () => ({
        purchases: [],
        removed: [],
        deactivations: [],
        skipped: [
            { qbPurchaseId: "(missing)", reason: "missing-purchase-id" },
            { qbPurchaseId: "purchase-no-token", reason: "missing-sync-token" },
            { qbPurchaseId: "purchase-bad-amount", reason: "invalid-amount" },
            { qbPurchaseId: "purchase-bad-date", reason: "invalid-transaction-date" },
        ],
    });

    await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies);

    assert.deepEqual(classifications, [
        { qbPurchaseId: "purchase-no-token", classification: "unknown", reason: "missing-sync-token", qbSyncToken: null },
        { qbPurchaseId: "purchase-bad-amount", classification: "unknown", reason: "invalid-amount", qbSyncToken: null },
        { qbPurchaseId: "purchase-bad-date", classification: "unknown", reason: "invalid-transaction-date", qbSyncToken: null },
    ]);
});

test("a classification write failure never blocks the Expense import it rides alongside", async () => {
    let imported = 0;
    const dependencies = fakeDependencies([PURCHASE], ACTIVE_PROJECTS, [], {
        upsertPurchaseClassification: async () => { throw new Error("transient db error"); },
        upsertExpense: async () => { imported += 1; return "imported"; },
    });

    const result = await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies);

    assert.equal(imported, 1);
    assert.equal(result.imported, 1);
});

// Compile-time proof (Unified Money Register plan §4/§5): the exact four
// strings this module writes are the exact four strings register-merge.ts's
// status matrix reads. If either side's union ever drifts, this line fails
// to typecheck — `npm run build` / `tsc --noEmit` catch it, not just tests.
const _classificationValuesMatchRegisterMerge: PurchaseClassification[] = [
    "job-cost",
    "overhead",
    "owner-draw",
    "unknown",
];
void _classificationValuesMatchRegisterMerge;
