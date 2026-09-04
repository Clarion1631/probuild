import assert from "node:assert/strict";
import test from "node:test";
import {
    deactivateQboExpense,
    findActiveProjectForQboPurchase,
    normalizeQboPurchase,
    syncQboExpenses,
    upsertQboExpense,
    applyQboExpenseCostCodeSuggestion,
    planQboExpenseUpdate,
    type QboExpenseProjectCandidate,
    type QboExpenseSyncDependencies,
    type QboExpenseWrite,
    type QboPurchaseNormalizationSkipReason,
    type QboPurchaseForImport,
} from "../src/lib/qbo-expense-sync";
import { OVERHEAD_PROJECT_ID } from "../src/lib/overhead-project";

const TOKENS = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    realmId: "test-realm",
};

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

test("normalizes a posted QBO purchase into stable import fields", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-1",
        SyncToken: "3",
        TxnDate: "2026-07-15",
        TotalAmt: 125.5,
        PaymentType: "Check",
        EntityRef: { value: "vendor-1", name: "Contractor Supply" },
        AccountRef: { value: "account-1", name: "Washington Trust Checking" },
        PrivateNote: "Rough plumbing",
        Line: [
            {
                DetailType: "AccountBasedExpenseLineDetail",
                AccountBasedExpenseLineDetail: {
                    CustomerRef: { value: "qbo-job-1", name: "Mueller Bathroom" },
                },
            },
        ],
    });

    assert.deepEqual(result, {
        kind: "purchase",
        purchase: { ...PURCHASE, syncToken: "3" },
    });
});

test("normalizes a valid purchase with no customer for an explicit eligibility skip later", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-no-customer",
        SyncToken: "0",
        TxnDate: "2026-07-15",
        TotalAmt: "45.20",
        EntityRef: { name: "Hardware Store" },
    });

    assert.equal(result.kind, "purchase");
    if (result.kind === "purchase") {
        assert.equal(result.purchase.customerId, null);
        assert.equal(result.purchase.customerName, null);
        assert.equal(result.purchase.total, 45.2);
    }
});

test("captures line detail and flags an all-equity purchase as an owner draw", () => {
    const equityDraw = normalizeQboPurchase({
        Id: "purchase-draw",
        SyncToken: "0",
        TxnDate: "2026-06-14",
        TotalAmt: 20,
        Line: [{
            Amount: 20,
            Description: "haircut",
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
                AccountRef: { value: "eq-1", name: "Shareholders' equity:Distributions" },
            },
        }],
    });
    assert.equal(equityDraw.kind, "purchase");
    if (equityDraw.kind === "purchase") {
        assert.equal(equityDraw.purchase.isEquityDraw, true);
        assert.deepEqual(equityDraw.purchase.lines, [
            { description: "haircut", amount: 20, account: "Shareholders' equity:Distributions" },
        ]);
    }

    const mixed = normalizeQboPurchase({
        Id: "purchase-mixed-accounts",
        SyncToken: "0",
        TxnDate: "2026-06-14",
        TotalAmt: 120,
        Line: [
            {
                Amount: 20,
                DetailType: "AccountBasedExpenseLineDetail",
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "eq-1", name: "Shareholders' equity:Distributions" },
                },
            },
            {
                Amount: 100,
                Description: "Spray foam gun",
                DetailType: "AccountBasedExpenseLineDetail",
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "cogs-1", name: "Cost of goods sold:Supplies & materials - COGS" },
                },
            },
        ],
    });
    assert.equal(mixed.kind, "purchase");
    if (mixed.kind === "purchase") {
        assert.equal(mixed.purchase.isEquityDraw, false);
    }
});

test("rejects a malformed non-numeric amount instead of silently importing it", () => {
    for (const total of ["not-money", null]) {
        assert.deepEqual(
            normalizeQboPurchase({
                Id: "purchase-bad-amount",
                SyncToken: "0",
                TxnDate: "2026-07-15",
                TotalAmt: total,
            }),
            {
                kind: "skipped",
                qbPurchaseId: "purchase-bad-amount",
                reason: "invalid-amount",
            },
        );
    }
});

test("treats a credit-card refund as a removed money-out transaction", () => {
    assert.deepEqual(
        normalizeQboPurchase({
            Id: "purchase-refund",
            SyncToken: "2",
            Credit: true,
            TxnDate: "2026-07-15",
            TotalAmt: 45,
            PaymentType: "CreditCard",
        }),
        {
            kind: "removed",
            qbPurchaseId: "purchase-refund",
            qbSyncToken: "2",
            reason: "credit-card-refund",
        },
    );
});

test("rejects a malformed or missing transaction date", () => {
    for (const txnDate of [undefined, "07/15/2026", "2026-02-30"]) {
        assert.deepEqual(
            normalizeQboPurchase({
                Id: "purchase-bad-date",
                SyncToken: "0",
                TxnDate: txnDate,
                TotalAmt: 45,
            }),
            {
                kind: "skipped",
                qbPurchaseId: "purchase-bad-date",
                reason: "invalid-transaction-date",
            },
        );
    }
});

test("rejects a purchase split across multiple QBO customers rather than guessing a job", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-split",
        SyncToken: "0",
        TxnDate: "2026-07-15",
        TotalAmt: 90,
        Line: [
            {
                AccountBasedExpenseLineDetail: {
                    CustomerRef: { value: "job-1", name: "Mueller Bathroom" },
                },
            },
            {
                ItemBasedExpenseLineDetail: {
                    CustomerRef: { value: "job-2", name: "Mueller Kitchen" },
                },
            },
        ],
    });

    assert.deepEqual(result, {
        kind: "ineligible",
        qbPurchaseId: "purchase-split",
        qbSyncToken: "0",
        reason: "multiple-customers",
    });
});

test("rejects a purchase that mixes job-assigned and unassigned expense lines", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-partial-job",
        SyncToken: "0",
        TxnDate: "2026-07-15",
        TotalAmt: 150,
        Line: [
            {
                Amount: 100,
                AccountBasedExpenseLineDetail: {
                    CustomerRef: { value: "job-1", name: "Mueller Bathroom" },
                },
            },
            {
                Amount: 50,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "supplies" },
                },
            },
        ],
    });

    assert.deepEqual(result, {
        kind: "ineligible",
        qbPurchaseId: "purchase-partial-job",
        qbSyncToken: "0",
        reason: "mixed-customer-allocation",
    });
});

test("tolerates an uncoded Reimbursable Sales Tax line when every other line is one job", () => {
    // QBO's receipt-inbox categorize flow doesn't carry the customer onto the
    // tax split line — that must not exclude the whole purchase from job costs.
    const result = normalizeQboPurchase({
        Id: "purchase-uncoded-tax",
        SyncToken: "0",
        TxnDate: "2026-07-20",
        TotalAmt: 15.51,
        Line: [
            {
                Amount: 14.24,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "98", name: "Cost of goods sold:Supplies & materials - COGS" },
                    CustomerRef: { value: "213", name: "Mesplay Kitchen" },
                },
            },
            {
                Amount: 1.27,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "1150040032", name: "Reimbursable Sales Tax Paid" },
                },
            },
        ],
    });

    assert.equal(result.kind, "purchase");
    if (result.kind === "purchase") {
        assert.equal(result.purchase.customerId, "213");
        assert.equal(result.purchase.customerName, "Mesplay Kitchen");
        assert.equal(result.purchase.total, 15.51);
    }
});

test("a configured tax-account id mismatch keeps the mixed-allocation guard", () => {
    // With QBO_RECEIPT_TAX_ACCOUNT_ID set, the id DECIDES — a lookalike name
    // on a different account id must NOT get the tax exception.
    const prev = process.env.QBO_RECEIPT_TAX_ACCOUNT_ID;
    process.env.QBO_RECEIPT_TAX_ACCOUNT_ID = "1150040032";
    try {
        const result = normalizeQboPurchase({
            Id: "purchase-tax-id-mismatch",
            SyncToken: "0",
            TxnDate: "2026-07-20",
            TotalAmt: 15.51,
            Line: [
                {
                    Amount: 14.24,
                    AccountBasedExpenseLineDetail: {
                        AccountRef: { value: "98", name: "Cost of goods sold:Supplies & materials - COGS" },
                        CustomerRef: { value: "213", name: "Mesplay Kitchen" },
                    },
                },
                {
                    Amount: 1.27,
                    AccountBasedExpenseLineDetail: {
                        AccountRef: { value: "999", name: "Reimbursable Sales Tax Paid" },
                    },
                },
            ],
        });
        assert.equal(result.kind, "ineligible");
        if (result.kind === "ineligible") assert.equal(result.reason, "mixed-customer-allocation");
    } finally {
        if (prev === undefined) delete process.env.QBO_RECEIPT_TAX_ACCOUNT_ID;
        else process.env.QBO_RECEIPT_TAX_ACCOUNT_ID = prev;
    }
});

test("an uncoded NON-tax line alongside an uncoded tax line still rejects", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-tax-plus-uncoded",
        SyncToken: "0",
        TxnDate: "2026-07-20",
        TotalAmt: 65.51,
        Line: [
            {
                Amount: 14.24,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "98", name: "Cost of goods sold:Supplies & materials - COGS" },
                    CustomerRef: { value: "213", name: "Mesplay Kitchen" },
                },
            },
            {
                Amount: 1.27,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { name: "Reimbursable Sales Tax Paid" },
                },
            },
            {
                Amount: 50,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "supplies" },
                },
            },
        ],
    });
    assert.equal(result.kind, "ineligible");
    if (result.kind === "ineligible") assert.equal(result.reason, "mixed-customer-allocation");
});

test("a tax line with a malformed amount stays conservative and rejects", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-tax-bad-amount",
        SyncToken: "0",
        TxnDate: "2026-07-20",
        TotalAmt: 15.51,
        Line: [
            {
                Amount: 14.24,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "98", name: "Cost of goods sold:Supplies & materials - COGS" },
                    CustomerRef: { value: "213", name: "Mesplay Kitchen" },
                },
            },
            {
                Amount: "not-a-number",
                AccountBasedExpenseLineDetail: {
                    AccountRef: { name: "Reimbursable Sales Tax Paid" },
                },
            },
        ],
    });
    assert.equal(result.kind, "ineligible");
    if (result.kind === "ineligible") assert.equal(result.reason, "mixed-customer-allocation");
});

test("a tax line whose amount is a coercible non-number stays conservative", () => {
    // Number(true) === 1 and Number("1.27") === 1.27 — neither may earn the
    // exception; only an actual positive number does.
    for (const badAmount of [true, "1.27"]) {
        const result = normalizeQboPurchase({
            Id: "purchase-tax-coerced-amount",
            SyncToken: "0",
            TxnDate: "2026-07-20",
            TotalAmt: 15.51,
            Line: [
                {
                    Amount: 14.24,
                    AccountBasedExpenseLineDetail: {
                        AccountRef: { value: "98", name: "Cost of goods sold:Supplies & materials - COGS" },
                        CustomerRef: { value: "213", name: "Mesplay Kitchen" },
                    },
                },
                {
                    Amount: badAmount,
                    AccountBasedExpenseLineDetail: {
                        AccountRef: { name: "Reimbursable Sales Tax Paid" },
                    },
                },
            ],
        });
        assert.equal(result.kind, "ineligible", `amount ${JSON.stringify(badAmount)}`);
        if (result.kind === "ineligible") assert.equal(result.reason, "mixed-customer-allocation");
    }
});

test("a lookalike tax-account NAME does not get the exception", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-tax-lookalike",
        SyncToken: "0",
        TxnDate: "2026-07-20",
        TotalAmt: 15.51,
        Line: [
            {
                Amount: 14.24,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: "98", name: "Cost of goods sold:Supplies & materials - COGS" },
                    CustomerRef: { value: "213", name: "Mesplay Kitchen" },
                },
            },
            {
                Amount: 1.27,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { name: "Non-Reimbursable Sales Tax Paid" },
                },
            },
        ],
    });
    assert.equal(result.kind, "ineligible");
    if (result.kind === "ineligible") assert.equal(result.reason, "mixed-customer-allocation");
});

test("an uncoded tax line with NO job-coded lines still has no customer", () => {
    const result = normalizeQboPurchase({
        Id: "purchase-tax-only",
        SyncToken: "0",
        TxnDate: "2026-07-20",
        TotalAmt: 1.27,
        Line: [
            {
                Amount: 1.27,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { name: "Reimbursable Sales Tax Paid" },
                },
            },
        ],
    });

    assert.equal(result.kind, "purchase");
    if (result.kind === "purchase") {
        assert.equal(result.purchase.customerId, null);
        assert.equal(result.purchase.customerName, null);
    }
});

test("matches a QBO customer label to exactly one in-progress job and its latest estimate", () => {
    const result = findActiveProjectForQboPurchase(PURCHASE, [
        {
            ...ACTIVE_PROJECTS[0],
            estimates: [
                { id: "estimate-old", createdAt: new Date("2026-06-01T00:00:00.000Z") },
                { id: "estimate-new", createdAt: new Date("2026-07-01T00:00:00.000Z") },
            ],
        },
    ]);

    assert.deepEqual(result, {
        kind: "matched",
        projectId: "project-1",
        estimateId: "estimate-new",
    });
});

test("excludes a closed job even when its name is an exact match", () => {
    const result = findActiveProjectForQboPurchase(PURCHASE, [
        {
            id: "project-closed",
            name: "Mueller Bathroom",
            status: "Closed Complete",
            estimates: [{ id: "estimate-closed", createdAt: new Date("2026-07-01T00:00:00.000Z") }],
        },
    ]);

    assert.deepEqual(result, { kind: "skipped", reason: "no-active-project" });
});

test("exact project name wins a prefix-collision tie (Shop vs Shop Shed, shared client)", () => {
    const projects: QboExpenseProjectCandidate[] = [
        {
            id: "project-shop",
            name: "Shop",
            status: "In Progress",
            qbCustomerId: "182",
            estimates: [{ id: "estimate-shop", createdAt: new Date("2026-07-07T00:00:00.000Z") }],
        },
        {
            id: "project-shop-shed",
            name: "Shop Shed",
            status: "In Progress",
            qbCustomerId: "182", // same client, so id matching returns both
            estimates: [{ id: "estimate-shed", createdAt: new Date("2026-07-01T00:00:00.000Z") }],
        },
    ];

    // Tie via shared qbCustomerId, broken by exact name equality.
    const byId = findActiveProjectForQboPurchase(
        { customerId: "182", customerName: "Shop" },
        projects,
    );
    assert.deepEqual(byId, { kind: "matched", projectId: "project-shop", estimateId: "estimate-shop" });

    // Same tie via pure name matching (no customer id).
    const byName = findActiveProjectForQboPurchase(
        { customerId: null, customerName: "Shop" },
        projects,
    );
    assert.deepEqual(byName, { kind: "matched", projectId: "project-shop", estimateId: "estimate-shop" });

    // No exact-name candidate → still ambiguous, never guesses.
    const stillAmbiguous = findActiveProjectForQboPurchase(
        { customerId: "182", customerName: "Sho" },
        projects,
    );
    assert.deepEqual(stillAmbiguous, { kind: "skipped", reason: "ambiguous-project" });
});

test("excludes an ambiguous best-name match", () => {
    const result = findActiveProjectForQboPurchase(PURCHASE, [
        {
            id: "project-a",
            name: "Mueller Bathroom Remodel",
            status: "In Progress",
            estimates: [{ id: "estimate-a", createdAt: new Date("2026-07-01T00:00:00.000Z") }],
        },
        {
            id: "project-b",
            name: "Mueller Bathroom Addition",
            status: "In Progress",
            estimates: [{ id: "estimate-b", createdAt: new Date("2026-07-02T00:00:00.000Z") }],
        },
    ]);

    assert.deepEqual(result, { kind: "skipped", reason: "ambiguous-project" });
});

test("excludes an in-progress job that has no estimate", () => {
    const result = findActiveProjectForQboPurchase(PURCHASE, [
        {
            id: "project-no-estimate",
            name: "Mueller Bathroom Remodel",
            status: "In Progress",
            estimates: [],
        },
    ]);

    assert.deepEqual(result, { kind: "skipped", reason: "no-estimate" });
});

type StoredExpense = Omit<QboExpenseWrite, "status"> & {
    id: string;
    receiptUrl: string | null;
    status: "Pending" | "Reviewed";
    // Phase 3 attribution columns, so a test can seed a human-coded row.
    costCodeId?: string | null;
    costCodeSource?: string | null;
    costCodeConfidence?: number | null;
};

/**
 * The estimate table, because the upsert now re-reads the attribution PAIR
 * under a lock rather than trusting the matcher's pre-transaction answer
 * (Codex round 21, item 1). `estimateProjects` scripts the interleaving: seed
 * an entry to move an estimate to another job, or `null` to un-project it.
 * Anything unseeded is on `project-1`, which is where every WRITE points.
 *
 * `deletedEstimates` is the third state, and the one that used to CRASH (round
 * 32): the estimate row is gone entirely, so the locked re-read comes back with
 * no row at all. This fake enforces the foreign key the real database enforces,
 * so a write that still carries the vanished `estimateId` fails here exactly as
 * it fails in production — a P2003 that aborts the transaction and takes the
 * rest of the sync run with it.
 */
function createFakePrisma(
    initial: StoredExpense[] = [],
    estimateProjects: Map<string, string | null> = new Map(),
    deletedEstimates: Set<string> = new Set(),
) {
    const rows = new Map(initial.map((row) => [row.qbPurchaseId, { ...row }]));
    const estimateProjectOf = (estimateId: string) =>
        estimateProjects.has(estimateId) ? estimateProjects.get(estimateId)! : "project-1";
    const enforceEstimateFk = (estimateId: string | undefined) => {
        if (estimateId !== undefined && deletedEstimates.has(estimateId)) {
            const error: Error & { code?: string } = new Error(
                "Foreign key constraint failed on the field: `Expense_estimateId_fkey`",
            );
            error.code = "P2003";
            throw error;
        }
    };
    const expense = {
        async findUnique(args: { where: { qbPurchaseId: string } }) {
            return rows.get(args.where.qbPurchaseId) ?? null;
        },
        async create(args: { data: QboExpenseWrite }) {
            enforceEstimateFk(args.data.estimateId);
            const next: StoredExpense = {
                ...args.data,
                id: `expense-${rows.size + 1}`,
                receiptUrl: null,
            };
            rows.set(args.data.qbPurchaseId, next);
            return next;
        },
        async update(args: {
            where: { id: string };
            data: Partial<QboExpenseWrite>;
        }) {
            const current = [...rows.values()].find(row => row.id === args.where.id);
            if (!current) throw new Error("missing fake expense");
            const next = { ...current, ...args.data };
            rows.set(current.qbPurchaseId, next);
            return next;
        },
        // Models the PREDICATE, not just the write: `projectId: null` in the
        // where clause has to be able to match zero rows, because that is the
        // whole guarantee the split-out project fill is buying.
        // Models the PREDICATE, not just the write — both the attribution fill
        // (`projectId: null`) and the tax COMPARE-AND-SET have to be able to
        // match ZERO rows, because that is the whole guarantee they buy.
        async updateMany(args: { where: Record<string, any>; data: Record<string, any> }) {
            const current = [...rows.values()].find(row => row.id === args.where.id);
            if (!current) return { count: 0 };
            enforceEstimateFk(args.data.estimateId as string | undefined);
            const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
            for (const key of ["projectId", "taxAmount", "taxDeductibleBase"]) {
                if (key in args.where && !eq((current as any)[key], args.where[key])) {
                    return { count: 0 };
                }
            }
            rows.set(current.qbPurchaseId, { ...current, ...args.data });
            return { count: 1 };
        },
    };
    let lockTail: Promise<void> = Promise.resolve();

    return {
        rows,
        // Exposed so a test can model a concurrent writer landing between
        // the read and the write.
        expense,
        client: {
            async $transaction<T>(callback: (tx: {
                expense: typeof expense;
                $queryRawUnsafe: (query: string, qbPurchaseId: string) => Promise<unknown>;
            }) => Promise<T>) {
                let releaseLock: (() => void) | undefined;
                // RE-ENTRANT, like the real thing. `pg_advisory_xact_lock` is
                // held for the whole transaction and taking it again inside the
                // same one returns immediately — the sync now takes two (per
                // purchase, then per expense). A fake that serialised every
                // call made the second wait on a lock the same transaction
                // already held, which is a deadlock the database would never
                // have.
                let heldByThisTransaction = false;
                const transactionLock = {
                    async $queryRawUnsafe(query: string, ...args: unknown[]) {
                        // The estimate reads `lockEstimateAttribution` makes.
                        // The FOR SHARE row lock returns nothing; the read
                        // after it answers.
                        if (/FROM "Estimate" WHERE id/.test(query)) {
                            // A deleted estimate is not "a row with a null
                            // project" — it is NO ROW. Both reach the caller as
                            // a null pair, which is the point.
                            if (deletedEstimates.has(args[0] as string)) return [];
                            if (/FOR SHARE/.test(query)) return [];
                            return [{ projectId: estimateProjectOf(args[0] as string) }];
                        }
                        if (heldByThisTransaction) return [{ pg_advisory_xact_lock: null }];
                        heldByThisTransaction = true;
                        const previous = lockTail;
                        lockTail = new Promise<void>(resolve => {
                            releaseLock = resolve;
                        });
                        await previous;
                        return [{ pg_advisory_xact_lock: null }];
                    },
                };
                try {
                    return await callback({ expense, ...transactionLock });
                } finally {
                    releaseLock?.();
                }
            },
        },
    };
}

const WRITE: QboExpenseWrite = {
    qbPurchaseId: "purchase-1",
    qbSyncToken: "0",
    qbSyncedAt: new Date("2026-07-29T12:00:00.000Z"),
    estimateId: "estimate-1",
    projectId: "project-1",
    amount: 125.5,
    vendor: "Contractor Supply",
    date: new Date("2026-07-15T00:00:00.000Z"),
    description: "[QuickBooks import] Rough plumbing",
    status: "Reviewed",
};

test("upsert is idempotent, restores same-token drift, and ignores stale tokens", async () => {
    const fake = createFakePrisma();

    assert.equal(await upsertQboExpense(fake.client, WRITE), "imported");
    assert.equal(await upsertQboExpense(fake.client, WRITE), "unchanged");
    assert.equal(fake.rows.size, 1);

    const drifted = fake.rows.get("purchase-1")!;
    fake.rows.set("purchase-1", { ...drifted, amount: 999 });
    assert.equal(await upsertQboExpense(fake.client, WRITE), "updated");
    assert.equal(fake.rows.get("purchase-1")?.amount, 125.5);

    assert.equal(
        await upsertQboExpense(fake.client, {
            ...WRITE,
            qbSyncToken: "1",
            amount: 140,
            qbSyncedAt: new Date("2026-07-29T13:00:00.000Z"),
        }),
        "updated",
    );
    assert.equal(fake.rows.get("purchase-1")?.amount, 140);
    assert.equal(fake.rows.size, 1);

    assert.equal(
        await upsertQboExpense(fake.client, {
            ...WRITE,
            qbSyncToken: "0",
            amount: 10,
            qbSyncedAt: new Date("2026-07-29T11:00:00.000Z"),
        }),
        "unchanged",
    );
    assert.equal(fake.rows.get("purchase-1")?.amount, 140);
    assert.equal(fake.rows.get("purchase-1")?.qbSyncToken, "1");
});

test("upsert serializes overlapping writes so a stale token cannot win", async () => {
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "expense-1",
            qbSyncToken: "0",
            receiptUrl: null,
        },
    ]);

    const [newer, stale] = await Promise.all([
        upsertQboExpense(fake.client, {
            ...WRITE,
            qbSyncToken: "2",
            amount: 200,
        }),
        upsertQboExpense(fake.client, {
            ...WRITE,
            qbSyncToken: "1",
            amount: 100,
        }),
    ]);

    assert.equal(newer, "updated");
    assert.equal(stale, "unchanged");
    assert.equal(fake.rows.get("purchase-1")?.qbSyncToken, "2");
    assert.equal(fake.rows.get("purchase-1")?.amount, 200);
});

test("upsert preserves an existing Drive receipt URL linked to the QBO purchase", async () => {
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "pending-expense",
            qbSyncToken: "0",
            status: "Pending",
            receiptUrl: "https://drive.google.com/file/d/receipt-1/view",
        },
    ]);

    assert.equal(
        await upsertQboExpense(fake.client, {
            ...WRITE,
            qbSyncToken: "1",
            status: "Reviewed",
        }),
        "updated",
    );
    assert.equal(
        fake.rows.get("purchase-1")?.receiptUrl,
        "https://drive.google.com/file/d/receipt-1/view",
    );
    assert.equal(fake.rows.get("purchase-1")?.status, "Reviewed");
});

test("a QBO deletion deactivates local job cost without losing the receipt audit link", async () => {
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "expense-1",
            receiptUrl: "https://drive.google.com/file/d/receipt-1/view",
        },
    ]);
    const removal = {
        qbPurchaseId: "purchase-1",
        qbSyncToken: "1",
        qbSyncedAt: new Date("2026-07-29T14:00:00.000Z"),
        reason: "deleted" as const,
    };

    assert.equal(await deactivateQboExpense(fake.client, removal), "removed");
    assert.equal(await deactivateQboExpense(fake.client, removal), "unchanged");
    assert.equal(fake.rows.get("purchase-1")?.amount, 0);
    assert.equal(
        fake.rows.get("purchase-1")?.receiptUrl,
        "https://drive.google.com/file/d/receipt-1/view",
    );
    assert.match(fake.rows.get("purchase-1")?.description ?? "", /Removed in QBO/);
});

function createSyncDependencies(
    purchases: QboPurchaseForImport[],
    projects: QboExpenseProjectCandidate[],
    upsert: QboExpenseSyncDependencies["upsertExpense"],
    skipped: Array<{
        qbPurchaseId: string;
        reason: QboPurchaseNormalizationSkipReason;
    }> = [],
): QboExpenseSyncDependencies {
    return {
        getTokens: async () => TOKENS,
        readPurchases: async () => ({
            purchases,
            removed: [],
            deactivations: [],
            skipped,
        }),
        listProjects: async () => projects,
        upsertExpense: upsert,
        deactivateExpense: async () => "unchanged",
        upsertPurchaseClassification: async () => {},
        companyTimeZone: async () => "America/Los_Angeles",
        now: () => new Date("2026-07-29T12:00:00.000Z"),
    };
}

test("sync imports once, is a no-op on repeat, and applies a newer QBO sync token", async () => {
    const fake = createFakePrisma();
    const dependencies = createSyncDependencies(
        [PURCHASE],
        ACTIVE_PROJECTS,
        (write) => upsertQboExpense(fake.client, write),
    );

    assert.deepEqual(await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies), {
        imported: 1,
        updated: 0,
        removed: 0,
        attributionRaceSkipped: 0,
        skipped: [],
    });
    assert.deepEqual(await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies), {
        imported: 0,
        updated: 0,
        removed: 0,
        attributionRaceSkipped: 0,
        skipped: [],
    });

    const updatedDependencies = createSyncDependencies(
        [{ ...PURCHASE, syncToken: "1", total: 175 }],
        ACTIVE_PROJECTS,
        (write) => upsertQboExpense(fake.client, write),
    );
    assert.deepEqual(await syncQboExpenses({ since: new Date("2026-01-01") }, updatedDependencies), {
        imported: 0,
        updated: 1,
        removed: 0,
        attributionRaceSkipped: 0,
        skipped: [],
    });
    assert.equal(fake.rows.get("purchase-1")?.amount, 175);
});

test("overhead triage: no-customer purchases import to the configured project; equity draws stay out", async () => {
    const writes: QboExpenseWrite[] = [];
    const overheadProjects: QboExpenseProjectCandidate[] = [
        ...ACTIVE_PROJECTS,
        {
            id: "project-shop",
            name: "Shop",
            status: "In Progress",
            estimates: [{ id: "estimate-shop", createdAt: new Date("2026-07-07T00:00:00.000Z") }],
        },
    ];
    const overheadPurchase: QboPurchaseForImport = {
        ...PURCHASE,
        qbPurchaseId: "purchase-overhead",
        customerName: null,
        customerId: null,
        memo: "CLARK PUBLIC UTILITIES",
        lines: [{ description: "electric", amount: 72.33, account: "Utilities" }],
        isEquityDraw: false,
    };
    const drawPurchase: QboPurchaseForImport = {
        ...PURCHASE,
        qbPurchaseId: "purchase-draw",
        customerName: null,
        customerId: null,
        memo: "haircut",
        isEquityDraw: true,
    };
    const dependencies = createSyncDependencies(
        [overheadPurchase, drawPurchase],
        overheadProjects,
        async write => { writes.push(write); return "imported"; },
    );

    const result = await syncQboExpenses(
        { since: new Date("2026-05-01"), overheadProjectId: "project-shop" },
        dependencies,
    );

    assert.equal(result.imported, 1);
    assert.deepEqual(result.skipped, [
        { qbPurchaseId: "purchase-draw", reason: "equity-draw" },
    ]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].estimateId, "estimate-shop");
    assert.match(writes[0].description, /^\[Overhead\] CLARK PUBLIC UTILITIES \| Lines: electric \(\$72\.33\)/);

    // Without the overhead project configured, behavior is unchanged.
    const writesWithout: QboExpenseWrite[] = [];
    const withoutOverhead = await syncQboExpenses(
        { since: new Date("2026-05-01") },
        createSyncDependencies(
            [overheadPurchase],
            overheadProjects,
            async write => { writesWithout.push(write); return "imported"; },
        ),
    );
    assert.equal(withoutOverhead.imported, 0);
    assert.deepEqual(withoutOverhead.skipped, [
        { qbPurchaseId: "purchase-overhead", reason: "missing-customer" },
    ]);
    assert.equal(writesWithout.length, 0);
});

test("a configured but unavailable overhead project skips without deactivating prior imports", async () => {
    let deactivations = 0;
    const dependencies = createSyncDependencies(
        [{
            ...PURCHASE,
            qbPurchaseId: "purchase-overhead",
            customerName: null,
            customerId: null,
            isEquityDraw: false,
        }],
        ACTIVE_PROJECTS, // configured id below does not exist here
        async () => "imported",
    );
    dependencies.deactivateExpense = async () => { deactivations += 1; return "removed"; };

    const result = await syncQboExpenses(
        { since: new Date("2026-05-01"), overheadProjectId: "project-shop-missing" },
        dependencies,
    );

    assert.equal(result.imported, 0);
    assert.equal(result.removed, 0);
    assert.equal(deactivations, 0);
    assert.deepEqual(result.skipped, [
        { qbPurchaseId: "purchase-overhead", reason: "overhead-project-unavailable" },
    ]);
});

test("sync forwards the optional until bound to the purchase reader and rejects an inverted window", async () => {
    const fake = createFakePrisma();
    const dependencies = createSyncDependencies(
        [PURCHASE],
        ACTIVE_PROJECTS,
        (write) => upsertQboExpense(fake.client, write),
    );
    const readCalls: Array<{ since: Date; mode: string; until?: Date }> = [];
    const innerRead = dependencies.readPurchases;
    dependencies.readPurchases = async (tokens, since, mode, until) => {
        readCalls.push({ since, mode, until });
        return innerRead(tokens, since, mode, until);
    };

    await syncQboExpenses(
        {
            since: new Date("2026-01-01"),
            until: new Date("2026-01-31"),
            mode: "backfill",
        },
        dependencies,
    );
    assert.equal(readCalls.length, 1);
    assert.equal(readCalls[0].until?.toISOString(), "2026-01-31T00:00:00.000Z");

    await assert.rejects(
        syncQboExpenses(
            {
                since: new Date("2026-02-01"),
                until: new Date("2026-01-31"),
            },
            dependencies,
        ),
        /until date must not precede since/,
    );
    assert.equal(readCalls.length, 1);
});

test("sync reports and applies QBO removal signals", async () => {
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "expense-1",
            receiptUrl: null,
        },
    ]);
    const dependencies = createSyncDependencies([], ACTIVE_PROJECTS, async () => "unchanged");
    dependencies.readPurchases = async () => ({
        purchases: [],
        removed: [{
            qbPurchaseId: "purchase-1",
            qbSyncToken: "1",
            reason: "voided",
        }],
        deactivations: [],
        skipped: [],
    });
    dependencies.deactivateExpense = write => deactivateQboExpense(fake.client, write);

    assert.deepEqual(
        await syncQboExpenses(
            { since: new Date("2026-07-22"), mode: "incremental" },
            dependencies,
        ),
        {
            imported: 0,
            updated: 0,
            removed: 1,
            attributionRaceSkipped: 0,
            skipped: [],
        },
    );
    assert.equal(fake.rows.get("purchase-1")?.amount, 0);
});

test("sync deactivates an imported Purchase that no longer maps to an eligible job", async () => {
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "expense-1",
            receiptUrl: null,
        },
    ]);
    const noLongerAssigned = {
        ...PURCHASE,
        syncToken: "1",
        customerId: null,
        customerName: null,
    };
    const dependencies = createSyncDependencies(
        [noLongerAssigned],
        ACTIVE_PROJECTS,
        write => upsertQboExpense(fake.client, write),
    );
    dependencies.deactivateExpense = write => deactivateQboExpense(fake.client, write);

    assert.deepEqual(
        await syncQboExpenses(
            { since: new Date("2026-07-22"), mode: "incremental" },
            dependencies,
        ),
        {
            imported: 0,
            updated: 0,
            removed: 1,
            attributionRaceSkipped: 0,
            skipped: [{
                qbPurchaseId: "purchase-1",
                reason: "missing-customer",
            }],
        },
    );
    assert.equal(fake.rows.get("purchase-1")?.amount, 0);
});

test("backfill fixture imports only the active unambiguous job and stays idempotent", async () => {
    const fake = createFakePrisma();
    const purchases: QboPurchaseForImport[] = [
        PURCHASE,
        { ...PURCHASE, qbPurchaseId: "purchase-closed", customerName: "Closed Kitchen" },
        { ...PURCHASE, qbPurchaseId: "purchase-ambiguous", customerName: "Smith Remodel" },
        { ...PURCHASE, qbPurchaseId: "purchase-no-estimate", customerName: "Jones Addition" },
    ];
    const projects: QboExpenseProjectCandidate[] = [
        ...ACTIVE_PROJECTS,
        {
            id: "project-closed",
            name: "Closed Kitchen",
            status: "Closed Complete",
            estimates: [{ id: "estimate-closed", createdAt: new Date("2026-01-01") }],
        },
        {
            id: "project-smith-a",
            name: "Smith Remodel East",
            status: "In Progress",
            estimates: [{ id: "estimate-smith-a", createdAt: new Date("2026-01-01") }],
        },
        {
            id: "project-smith-b",
            name: "Smith Remodel West",
            status: "In Progress",
            estimates: [{ id: "estimate-smith-b", createdAt: new Date("2026-01-01") }],
        },
        {
            id: "project-jones",
            name: "Jones Addition",
            status: "In Progress",
            estimates: [],
        },
    ];
    const dependencies = createSyncDependencies(
        purchases,
        projects,
        (write) => upsertQboExpense(fake.client, write),
    );

    const first = await syncQboExpenses({ since: new Date("2025-01-01") }, dependencies);
    const second = await syncQboExpenses({ since: new Date("2025-01-01") }, dependencies);

    assert.equal(first.imported, 1);
    assert.equal(first.updated, 0);
    assert.deepEqual(first.skipped, [
        { qbPurchaseId: "purchase-closed", reason: "no-active-project" },
        { qbPurchaseId: "purchase-ambiguous", reason: "ambiguous-project" },
        { qbPurchaseId: "purchase-no-estimate", reason: "no-estimate" },
    ]);
    assert.deepEqual(second, {
        imported: 0,
        updated: 0,
        removed: 0,
        attributionRaceSkipped: 0,
        skipped: first.skipped,
    });
    assert.equal(fake.rows.size, 1);
});

test("the sync LOOP counts an attribution-race skip separately from imported/updated (round 31, item 2)", async () => {
    // The bug this replaces: a create-race returned "unchanged", and the loop
    // that turns per-purchase outcomes into a sync summary only ever counted
    // "imported"/"updated" — the row a backfill most needs to see (one that
    // was NEVER created) fell into neither counter and vanished from the
    // summary entirely.
    const fake = createFakePrisma([], new Map([["estimate-1", "project-moved"]]));
    const dependencies = createSyncDependencies(
        [PURCHASE],
        ACTIVE_PROJECTS,
        (write) => upsertQboExpense(fake.client, write),
    );

    const result = await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies);
    assert.equal(result.imported, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.attributionRaceSkipped, 1, "counted, not silently folded into unchanged");
    assert.equal(fake.rows.size, 0, "nothing was actually created");
});

// ── Phase 3 attribution (docs/plans/PHASE-3-ATTRIBUTION-SPEC.md §3.1, §8) ──

test("an imported expense is born knowing its job", async () => {
    const fake = createFakePrisma();
    assert.equal(await upsertQboExpense(fake.client, WRITE), "imported");
    assert.equal(fake.rows.get("purchase-1")?.projectId, "project-1");
});

test("a re-sync fills a NULL projectId but never overwrites one", async () => {
    // The sync has always KNOWN the project; before Phase 3 it dropped it. A
    // row imported back then has projectId NULL and should be caught up.
    const legacy = createFakePrisma([
        { ...WRITE, id: "expense-1", projectId: null, receiptUrl: null },
    ]);
    assert.equal(await upsertQboExpense(legacy.client, { ...WRITE, qbSyncToken: "1" }), "updated");
    assert.equal(legacy.rows.get("purchase-1")?.projectId, "project-1");

    // ...but a bookkeeper's re-attribution is a HUMAN decision, and the QBO
    // customer ref is not a newer fact about it.
    const reattributed = createFakePrisma([
        { ...WRITE, id: "expense-1", projectId: "moved-by-hand", receiptUrl: null },
    ]);
    assert.equal(
        await upsertQboExpense(reattributed.client, { ...WRITE, qbSyncToken: "1", amount: 200 }),
        "updated",
    );
    assert.equal(reattributed.rows.get("purchase-1")?.projectId, "moved-by-hand");
    assert.equal(reattributed.rows.get("purchase-1")?.amount, 200, "the rest of the write still lands");
});

test("a re-attributed row settles to unchanged instead of updating forever", async () => {
    // If projectId were compared unconditionally, every re-attributed row would
    // read as drifted on every sync and re-issue an update that deliberately
    // changes nothing — a permanent phantom write, and a permanently wrong
    // "updated" count in the sync report.
    const fake = createFakePrisma([
        { ...WRITE, id: "expense-1", projectId: "moved-by-hand", receiptUrl: null },
    ]);
    assert.equal(await upsertQboExpense(fake.client, WRITE), "unchanged");
    assert.equal(await upsertQboExpense(fake.client, WRITE), "unchanged");
    assert.equal(fake.rows.get("purchase-1")?.projectId, "moved-by-hand");
});

// ── the pair is re-read under lock, at write time (round 21, item 1) ────────

test("an estimate MOVED mid-sync is refused, not silently imported onto its new job", async () => {
    // The matcher resolved estimate-1 -> project-1, then wrote a
    // classification row and made a QBO round trip. If the estimate joined
    // another job in that window, `write` — vendor, description, amount — was
    // still matched and shaped for project-1, not for wherever the estimate
    // has since moved to. Silently swapping in the lock's project-moved would
    // land a purchase classified for one job on another job's books, so the
    // write is refused instead: nothing is created, and the next sync
    // re-matches against the estimate's current project.
    const fake = createFakePrisma([], new Map([["estimate-1", "project-moved"]]));
    // Distinct from "unchanged" (round 31, item 2): "unchanged" means the row
    // exists and there was nothing to change, which a backfill's own
    // idempotency check treats as done. This row was never created at all —
    // collapsing the two hid a permanently-unimported Purchase inside a count
    // that looked like a clean no-op rerun.
    assert.equal(await upsertQboExpense(fake.client, WRITE), "skipped-attribution-race");
    assert.equal(fake.rows.get("purchase-1"), undefined, "nothing is created on a mismatch");
});

test("an estimate that lost its project is REFUSED, not imported as half a pair", async () => {
    // Round 32. This used to import with `projectId: null` and the stale
    // `write.estimateId` beside it, on the theory that null is "the honest
    // answer". It is not: the row is not unattributed, it is attributed to an
    // estimate whose job nobody can resolve — `resolveExpenseProjectId` falls
    // through to `estimate.projectId`, which is exactly the null this row was
    // supposed to be reporting. The matcher's whole basis for the import is
    // gone, so the import does not happen and the next sync re-matches.
    const fake = createFakePrisma([], new Map([["estimate-1", null]]));
    assert.equal(await upsertQboExpense(fake.client, WRITE), "skipped-attribution-race");
    assert.equal(fake.rows.get("purchase-1"), undefined, "nothing is created");
});

test("a DELETED estimate is refused instead of taking down the sync run", async () => {
    // The crash, in full. `lockEstimateAttribution` returns null for a vanished
    // estimate exactly as it does for a project-less one, and the old guard —
    // `if (pair && ...)` — was skipped for both. The create that followed still
    // spread `write`, so it carried `estimateId: "estimate-1"` into a row whose
    // estimate no longer exists: a foreign-key violation that aborts the
    // transaction and every Purchase after it in the run.
    const fake = createFakePrisma([], new Map(), new Set(["estimate-1"]));
    assert.equal(await upsertQboExpense(fake.client, WRITE), "skipped-attribution-race");
    assert.equal(fake.rows.get("purchase-1"), undefined, "nothing is created");
});

test("the catch-up FILL refuses too, when the estimate moved out from under the plan", async () => {
    // The legacy fill path has the same shape as create: `plan.fill.projectId`
    // was computed for project-1, not for whichever job the estimate happens
    // to be on by the time this transaction locks it. The fill is skipped —
    // the row stays unattributed for the next sync to retry — but the rest of
    // the plan (here, the new qbSyncToken) still lands.
    //
    // And the OUTCOME says so (round 33, item 3). This used to answer plain
    // "updated", which is true about the write and silent about the row still
    // being on no job — so the sync summary counted it as finished work and
    // the backfill's incomplete-window check never saw it.
    const fake = createFakePrisma(
        [{ ...WRITE, id: "expense-1", projectId: null, receiptUrl: null }],
        new Map([["estimate-1", "project-moved"]]),
    );
    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1" }),
        "updated-attribution-skipped",
    );
    const row = fake.rows.get("purchase-1");
    assert.equal(row?.projectId, null, "the fill is skipped, not silently re-pointed");
    assert.equal(row?.estimateId, "estimate-1", "unchanged — it already matched the write");
    assert.equal(row?.qbSyncToken, "1", "the rest of the plan still lands");
});

test("a fill onto a project-less estimate is SKIPPED, not written half", async () => {
    // Round 32. The `else` branch used to write `{ estimateId: plan.fill.estimateId }`
    // — the plan's estimate — in precisely the case where the lock had just
    // proved that estimate names no job. That re-pointed a row from the
    // estimate it had onto one that answers nothing, and it did so under the
    // banner of a guard whose whole purpose is to refuse stale attribution.
    // There is nothing to fill from, so nothing is filled; the rest of the plan
    // still lands.
    const fake = createFakePrisma(
        [{ ...WRITE, id: "expense-1", projectId: null, estimateId: "estimate-old", receiptUrl: null }],
        new Map([["estimate-1", null]]),
    );
    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1" }),
        "updated-attribution-skipped",
    );
    const row = fake.rows.get("purchase-1");
    assert.equal(row?.projectId, null, "no job to attribute against");
    assert.equal(row?.estimateId, "estimate-old", "the row keeps the estimate it had");
    assert.equal(row?.qbSyncToken, "1", "the rest of the plan still lands");
});

test("a fill onto a DELETED estimate is skipped, and the reconciliation still lands", async () => {
    // Same null pair, reached by deletion. The old `else` wrote the vanished
    // id, which the foreign key rejects — so an attribution race turned into a
    // failed sync for every Purchase behind it. Skipping the fill leaves the
    // row unattributed (a reportable gap) and lets the tax/amount half of the
    // plan commit, which has nothing to do with attribution.
    const fake = createFakePrisma(
        [{ ...WRITE, id: "expense-1", projectId: null, estimateId: "estimate-old", receiptUrl: null }],
        new Map(),
        new Set(["estimate-1"]),
    );
    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1" }),
        "updated-attribution-skipped",
    );
    const row = fake.rows.get("purchase-1");
    assert.equal(row?.projectId, null);
    assert.equal(row?.estimateId, "estimate-old", "never re-pointed at an estimate that is gone");
    assert.equal(row?.qbSyncToken, "1");
});

test("the sync LOOP counts a refused catch-up FILL as incomplete, not as an update", async () => {
    // Round 33, item 3 — the full loop, not just upsertQboExpense.
    //
    // The bug this replaces: the fill was refused (correctly), the tax/amount
    // CAS still committed, and the outcome came back "updated". The aggregator
    // therefore incremented `updated` and never touched
    // `attributionRaceSkipped` — so a row that exists on NO JOB was reported
    // as finished work, and the backfill's incomplete-window detection, which
    // reads exactly that counter, could not see it.
    const fake = createFakePrisma(
        [{ ...WRITE, id: "expense-1", projectId: null, receiptUrl: null }],
        new Map([["estimate-1", "project-moved"]]),
    );
    const dependencies = createSyncDependencies(
        [{ ...PURCHASE, syncToken: "1" }],
        ACTIVE_PROJECTS,
        (write) => upsertQboExpense(fake.client, write),
    );

    const result = await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies);
    assert.equal(result.updated, 0, "not finished work — the row is still on no job");
    assert.equal(result.attributionRaceSkipped, 1, "counted where the backfill looks");
    assert.equal(result.imported, 0);
    assert.equal(fake.rows.get("purchase-1")?.projectId, null, "the fill really was refused");
    assert.equal(fake.rows.get("purchase-1")?.qbSyncToken, "1", "and the reconciliation still landed");
});

test("run-qbo-backfill calls the window INCOMPLETE on a refused fill", async () => {
    // The other end of the chain: the counter above is only worth writing if
    // the script that decides "this window is done" actually acts on it. The
    // real script is run here — its own aggregation, its own idempotency
    // check, its own message — with `fetch` answering the shape the sync loop
    // above produces. A source-text assertion would pass on a script that
    // printed the words and shipped the window anyway.
    const realFetch = globalThis.fetch;
    const realArgv = process.argv.slice();
    const realSecret = process.env.RECEIPT_INGEST_SECRET;
    const realLog = console.log;
    const fsMod = (await import("node:fs")).default;
    const realWrite = fsMod.writeFileSync;
    const lines: string[] = [];

    // ONE chunk, so both passes are a single request each.
    process.argv = [realArgv[0], "run-qbo-backfill", "2026-03-01", "2026-03-05"];
    process.env.RECEIPT_INGEST_SECRET = "test-secret";
    globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        // Exactly what the loop reports for a refused fill: nothing imported,
        // nothing updated, one row left incomplete.
        text: async () => JSON.stringify({
            imported: 0, updated: 0, removed: 0, attributionRaceSkipped: 1, skipped: [],
        }),
    })) as unknown as typeof fetch;
    // The script writes scripts/qbo-backfill-results.json; that file is
    // committed, and a test must not rewrite it.
    fsMod.writeFileSync = (() => {}) as typeof fsMod.writeFileSync;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };

    try {
        await import("../scripts/run-qbo-backfill.mjs");
    } finally {
        globalThis.fetch = realFetch;
        process.argv = realArgv;
        if (realSecret === undefined) delete process.env.RECEIPT_INGEST_SECRET;
        else process.env.RECEIPT_INGEST_SECRET = realSecret;
        fsMod.writeFileSync = realWrite;
        console.log = realLog;
    }

    const output = lines.join("\n");
    assert.match(output, /INCOMPLETE — this window is NOT done/);
    assert.match(output, /pass 1 hit 1 attribution race\(s\)/);
    assert.match(output, /pass 2 hit 1/);
    assert.doesNotMatch(
        output,
        /Idempotency: PASS/,
        "0/0/0 on imported\/updated\/removed must NOT read as a clean rerun while a row is incomplete",
    );
});

test("an ALREADY-attributed row is untouched by the locked re-read", async () => {
    // The re-read is part of the FILL, and the fill only ever runs under a
    // `projectId IS NULL` predicate. A bookkeeper's re-attribution must not be
    // dragged back to the estimate's job.
    const fake = createFakePrisma(
        [{ ...WRITE, id: "expense-1", projectId: "moved-by-hand", receiptUrl: null }],
        new Map([["estimate-1", "project-moved"]]),
    );
    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", amount: 200 }),
        "updated",
    );
    assert.equal(fake.rows.get("purchase-1")?.projectId, "moved-by-hand");
    assert.equal(fake.rows.get("purchase-1")?.amount, 200);
});

test("deactivation never touches the attribution columns", async () => {
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "expense-1",
            projectId: "project-1",
            costCodeId: "cc-plumb",
            costCodeSource: "manual",
            receiptUrl: null,
        },
    ]);
    assert.equal(
        await deactivateQboExpense(fake.client, {
            qbPurchaseId: "purchase-1",
            qbSyncToken: "1",
            qbSyncedAt: new Date("2026-07-29T14:00:00.000Z"),
            reason: "deleted",
        }),
        "removed",
    );
    const row = fake.rows.get("purchase-1");
    assert.equal(row?.amount, 0);
    assert.equal(row?.projectId, "project-1", "the job survives the deactivation");
    assert.equal(row?.costCodeId, "cc-plumb");
    assert.equal(row?.costCodeSource, "manual");
});

test("a lowered amount CLEARS an allocation it would strand", () => {
    // Expense_taxDeductibleBase_check enforces base <= amount - tax in the
    // database, so a re-sync that drops the amount below an existing allocation
    // would abort the whole sync transaction — one hand-allocated receipt
    // taking the entire QBO import down with it.
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", taxAmount: 10, taxDeductibleBase: 150 },
        { ...WRITE, amount: 100 },
    );
    assert.equal(plan.data.taxDeductibleBase, null, "100 - 10 = 90 < 150");
});

test("an allocation the new amount still supports is left alone", () => {
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", taxAmount: 10, taxDeductibleBase: 50 },
        { ...WRITE, amount: 100 },
    );
    assert.ok(!("taxDeductibleBase" in plan.data), "90 >= 50, so nothing to clear");
});

test("clearing a stranded allocation is a real change, not an unchanged pass", async () => {
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "expense-1",
            projectId: "project-1",
            receiptUrl: null,
            taxAmount: 10,
            taxDeductibleBase: 150,
        } as any,
    ]);
    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", amount: 100 }),
        "updated",
    );
    assert.equal((fake.rows.get("purchase-1") as any)?.taxDeductibleBase, null);
});

// ── the cost-code suggester ────────────────────────────────────────────────

const COST_CODE_IDS = new Map([
    ["03-PLUMB", "cc-plumb"],
    ["02-FRAME", "cc-frame"],
]);

type StoredForSuggestion = {
    projectId: string | null;
    // The locked re-resolve reads the job off this estimate when the row has
    // no projectId of its own (round 19, item 4).
    estimateId: string;
    costCodeId: string | null;
    costCodeSource: string | null;
    // The suggestion reads the PERSISTED text, so the stub has to carry it.
    vendor: string | null;
    description: string | null;
    qbSyncToken: string | null;
    updatedAt?: Date;
    estimate?: { projectId: string | null } | null;
} | null;

const STORED_DEFAULT: StoredForSuggestion = {
    projectId: "project-1",
    estimateId: "estimate-1",
    costCodeId: null,
    costCodeSource: null,
    vendor: "Summit Plumbing",
    description: "[QuickBooks import] rough-in",
    qbSyncToken: "3",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

function fakeSuggestionClient(stored: StoredForSuggestion = { ...STORED_DEFAULT! }) {
    const calls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    let count = 1;
    return {
        calls,
        setCount(next: number) { count = next; },
        client: {
            expense: {
                async findUnique() { return stored; },
                async updateMany(args: {
                    where: Record<string, unknown>;
                    data: { costCodeId: string; costCodeSource: string; costCodeConfidence: number };
                }) {
                    calls.push(args);
                    return { count };
                },
            },
        },
    };
}

test("a NULL cost code is filled with source ai and the rule's tier confidence", async () => {
    const fake = fakeSuggestionClient();
    const result = await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1" },
        COST_CODE_IDS,
    );
    assert.equal(result, "written");
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].data, {
        costCodeId: "cc-plumb",
        costCodeSource: "ai",
        costCodeConfidence: 0.9,
    });
});

test("the write is guarded on uncoded AND not-human-coded, with a NULL branch", async () => {
    // This is the whole of the "never overwrite a human" rule, and it lives in
    // the predicate rather than in a caller's discipline. The NULL branch is
    // load-bearing: SQL NOT IN drops NULL rows, which is every legacy row.
    const fake = fakeSuggestionClient();
    await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1" },
        COST_CODE_IDS,
    );
    const where = fake.calls[0].where;
    assert.equal(where.qbPurchaseId, "purchase-1");
    assert.equal(where.costCodeId, null);
    assert.deepEqual(where.OR, [
        { costCodeSource: null },
        // "manual-none" joined the human list in round 36, item 3: clearing a
        // phase is a decision, and NULL provenance is what every automated pass
        // reads as "a machine may write here".
        { costCodeSource: { notIn: ["capture", "manual", "manual-none"] } },
    ]);
    // Everything the decision depended on is re-asserted at write time, so a
    // row re-attributed between the read and the write is skipped rather than
    // coded on stale reasoning.
    assert.equal(where.projectId, "project-1");
});

test("the write requires the SAME attribution the suggestion was scoped to", async () => {
    // A row whose project came from the estimate (column still NULL) must be
    // written under `projectId: null` — "still unattributed" is the state the
    // decision was made in, and it is just as much a precondition as a
    // populated id.
    const fake = fakeSuggestionClient({
        ...STORED_DEFAULT,
        projectId: null,
        costCodeId: null,
        costCodeSource: null,
        estimate: { projectId: "project-1" },
    });
    await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1" },
        COST_CODE_IDS,
    );
    assert.equal(fake.calls[0].where.projectId, null);
});

test("a row a human already coded is refused on the STORED source, before any write", async () => {
    for (const costCodeSource of ["capture", "manual"]) {
        const fake = fakeSuggestionClient({ ...STORED_DEFAULT, costCodeSource });
        const result = await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1" },
            COST_CODE_IDS,
        );
        assert.equal(result, "not-written", costCodeSource);
        assert.equal(fake.calls.length, 0, "and it never even issues the guarded write");
    }
});

test("a row that is already coded is left alone", async () => {
    const fake = fakeSuggestionClient({ ...STORED_DEFAULT, costCodeId: "cc-existing" });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1" },
            COST_CODE_IDS,
        ),
        "not-written",
    );
    assert.equal(fake.calls.length, 0);
});

test("scope comes from the STORED project, not the incoming QBO match", async () => {
    // A bookkeeper moved this row into the overhead bucket. The QBO customer
    // ref still says "Mueller Bathroom", so a suggester scoped to the match
    // would hand an overhead purchase a job phase.
    const fake = fakeSuggestionClient({
        ...STORED_DEFAULT,
        projectId: OVERHEAD_PROJECT_ID,
        costCodeId: null,
        costCodeSource: null,
    });
    const result = await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1" },
        COST_CODE_IDS,
    );
    assert.equal(result, "skipped-overhead");
    assert.equal(fake.calls.length, 0);
});

test("the stored project is resolved through the estimate when the column is NULL", async () => {
    const fake = fakeSuggestionClient({
        ...STORED_DEFAULT,
        projectId: null,
        costCodeId: null,
        costCodeSource: null,
        estimate: { projectId: OVERHEAD_PROJECT_ID },
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1" },
            COST_CODE_IDS,
        ),
        "skipped-overhead",
    );
});

test("a row with no job at all gets no job phase", async () => {
    const fake = fakeSuggestionClient({ ...STORED_DEFAULT!, projectId: null, estimate: null });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1" },
            COST_CODE_IDS,
        ),
        "skipped-no-project",
    );
    assert.equal(fake.calls.length, 0);
});

test("a vanished row is reported, not treated as a silent success", async () => {
    const fake = fakeSuggestionClient(null);
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "gone" },
            COST_CODE_IDS,
        ),
        "missing-row",
    );
});

test("a phase the JOB does not have is refused, however confident the rule was", async () => {
    // The rules match on a vendor name. They know nothing about which phases
    // this job carries, and an automated write has LESS standing to invent one
    // than a human does, not more.
    const fake = fakeSuggestionClient();
    const result = await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1" },
        COST_CODE_IDS,
        async () => false,
    );
    assert.equal(result, "phase-not-on-project");
    assert.equal(fake.calls.length, 0, "and nothing is written");
});

test("the scope check is asked about the row's OWN job and the resolved code", async () => {
    const fake = fakeSuggestionClient();
    const asked: { projectId: string; costCodeId: string }[] = [];
    await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1" },
        COST_CODE_IDS,
        async (projectId, costCodeId) => { asked.push({ projectId, costCodeId }); return true; },
    );
    assert.deepEqual(asked, [{ projectId: "project-1", costCodeId: "cc-plumb" }]);
    assert.equal(fake.calls.length, 1, "an allowed phase still writes");
});

test("no rule match and an unknown code both write nothing", async () => {
    // The text comes from the STORED row now, so a no-match case has to be a
    // stored row the rules do not recognise.
    const bland = fakeSuggestionClient({
        ...STORED_DEFAULT!,
        vendor: "General Hardware",
        description: "misc supplies",
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(bland.client, { qbPurchaseId: "p" }, COST_CODE_IDS),
        "no-match",
    );
    assert.equal(bland.calls.length, 0);

    const known = fakeSuggestionClient();
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(known.client, { qbPurchaseId: "p" }, new Map()),
        "unknown-code",
    );
    assert.equal(known.calls.length, 0);
});

test("a failing suggester never fails the import it rides alongside", async () => {
    const fake = createFakePrisma();
    const dependencies = createSyncDependencies(
        [PURCHASE],
        ACTIVE_PROJECTS,
        write => upsertQboExpense(fake.client, write),
    );
    dependencies.suggestCostCode = async () => { throw new Error("cost code table unavailable"); };

    const result = await syncQboExpenses(
        { since: new Date("2026-07-01T00:00:00.000Z") },
        dependencies,
    );
    assert.equal(result.imported, 1, "the money is recorded even when the phase guess blows up");
});

test("the sync asks for a phase on a matched job, by purchase id only", async () => {
    // No projectId is passed: the suggester reads the row's stored attribution
    // itself, so the sync cannot accidentally widen its scope.
    const fake = createFakePrisma();
    const suggested: string[] = [];
    const dependencies = createSyncDependencies(
        [PURCHASE],
        ACTIVE_PROJECTS,
        write => upsertQboExpense(fake.client, write),
    );
    dependencies.suggestCostCode = async input => { suggested.push(input.qbPurchaseId); };

    await syncQboExpenses({ since: new Date("2026-07-01T00:00:00.000Z") }, dependencies);
    assert.deepEqual(suggested, ["purchase-1"]);
});

// ── the split project fill (Codex round 1, blocker 1) ──────────────────────

test("projectId and estimateId move TOGETHER, in one statement guarded on NULL", () => {
    // They are the same fact said twice, so a statement that could write one
    // without the other is a statement that can leave the row incoherent.
    const plan = planQboExpenseUpdate({ projectId: null, estimateId: "stale-estimate" }, WRITE);
    assert.deepEqual(plan.fill, { projectId: "project-1", estimateId: "estimate-1" });
    assert.ok(!("projectId" in plan.data), "the main UPDATE never carries projectId");
    assert.ok(!("estimateId" in plan.data), "nor estimateId");
    assert.equal(plan.data.amount, WRITE.amount, "the rest of the write still lands");
});

test("a row already on a project is never re-projected AND never re-estimated", () => {
    const plan = planQboExpenseUpdate({ projectId: "moved-by-hand", estimateId: "estimate-of-job-b" }, WRITE);
    assert.equal(plan.fill, null);
    assert.ok(!("projectId" in plan.data));
    assert.ok(!("estimateId" in plan.data), "the estimate belongs to the OTHER job");
    assert.equal(plan.data.amount, WRITE.amount);
});

test("attribution is write-ONCE: even the SAME job does not get a newer estimate", () => {
    // The dropped carve-out (Codex round 2). An earlier version refreshed
    // estimateId when the stored project and the incoming match agreed. It
    // bought very little — a row following its job to a newer estimate — and
    // paid by making the rule conditional, which is how the original bug got
    // in. Re-pointing an estimate is a job for an explicit re-attribution path,
    // not for an import.
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1" },
        { ...WRITE, estimateId: "estimate-2" },
    );
    assert.equal(plan.fill, null);
    assert.ok(!("estimateId" in plan.data), "never after the first write");
});

test("an unattributed row still gets its estimate corrected, even with no project to fill", () => {
    // projectId null on both sides: nothing to attribute to, but the estimate
    // link is still write-once-not-yet-written, so it may land.
    const plan = planQboExpenseUpdate(
        { projectId: null, estimateId: "stale" },
        { ...WRITE, projectId: null },
    );
    assert.deepEqual(plan.fill, { estimateId: "estimate-1" });
    assert.ok(!("projectId" in (plan.fill ?? {})));
});

test("nothing to fill is reported as nothing, not as an empty write", () => {
    const plan = planQboExpenseUpdate(
        { projectId: null, estimateId: "estimate-1" },
        { ...WRITE, projectId: null },
    );
    assert.equal(plan.fill, null);
});

test("a re-attributed row's estimateId survives a real re-sync", async () => {
    const fake = createFakePrisma([
        { ...WRITE, id: "expense-1", projectId: "moved-by-hand", estimateId: "estimate-of-job-b", receiptUrl: null },
    ]);
    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", amount: 300 }),
        "updated",
    );
    const row = fake.rows.get("purchase-1");
    assert.equal(row?.projectId, "moved-by-hand");
    assert.equal(row?.estimateId, "estimate-of-job-b");
    assert.equal(row?.amount, 300);
});

test("an ALREADY-attributed row keeps its estimate when QBO points at a newer one", async () => {
    const fake = createFakePrisma([
        { ...WRITE, id: "expense-1", projectId: "project-1", estimateId: "estimate-1", receiptUrl: null },
    ]);
    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", estimateId: "estimate-2", amount: 300 }),
        "updated",
    );
    assert.equal(fake.rows.get("purchase-1")?.estimateId, "estimate-1", "write-once, no exceptions");
    assert.equal(fake.rows.get("purchase-1")?.amount, 300);
});

test("a gross below the recorded tax CLEARS the classification and flags review", () => {
    // Codex round 6, item 2. Keeping a tax larger than the gross makes
    // `amount - taxAmount` negative and the report SUBTRACTS money from the
    // filing; the DB CHECK would also refuse the write and abort the import.
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", taxAmount: 30, taxDeductibleBase: 10 },
        { ...WRITE, amount: 20 },
    );
    assert.equal(plan.data.taxAmount, null);
    assert.equal(plan.data.taxAtSource, false);
    assert.equal(plan.data.installedAtCustomer, null, "the human's answer was about another receipt");
    assert.equal(plan.data.taxDeductibleBase, null);
    assert.equal(plan.data.needsTaxReview, true, "silence must not read as 'no tax'");
});

test("a gross that still covers the tax leaves the classification alone", () => {
    // Same gross as before, so nothing about the receipt moved.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: 100, taxAmount: 10, taxDeductibleBase: 50,
        },
        { ...WRITE, amount: 100 },
    );
    assert.ok(!("taxAmount" in plan.data));
    assert.ok(!("needsTaxReview" in plan.data));
    assert.ok(!("installedAtCustomer" in plan.data));
});

// ── ANY amount change re-opens a classification (Codex round 13, item 1) ───

test("an ORDINARY increase on a classified row asks for review", () => {
    // Nothing here breaks an invariant: $498.30 still covers $34.06 of tax and
    // a $380 allocation. But the human classified a $412.10 receipt, and this
    // is no longer that receipt.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: 412.1, taxAmount: 34.06, taxDeductibleBase: 380,
        },
        { ...WRITE, amount: 498.3 },
    );
    assert.equal(plan.data.needsTaxReview, true);
    // The classification is KEPT — it may still be right, and throwing away a
    // human's numbers is not this function's call. It is only re-opened.
    assert.ok(!("taxAmount" in plan.data), "not cleared, just flagged");
    assert.ok(!("installedAtCustomer" in plan.data));
    assert.ok(!("taxDeductibleBase" in plan.data));
});

test("an ORDINARY decrease that still satisfies every check asks for review", () => {
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: 412.1, taxAmount: 34.06, taxDeductibleBase: 100,
        },
        { ...WRITE, amount: 300 },
    );
    assert.equal(plan.data.needsTaxReview, true);
    assert.ok(!("taxDeductibleBase" in plan.data), "the allocation still fits, so it stands");
});

test("an installed-at-customer answer alone is a classification", () => {
    // The row a bookkeeper answered "yes" on but never split: no tax amount,
    // no allocation, and it is exactly the row the excise report reads.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: 412.1, installedAtCustomer: true,
        },
        { ...WRITE, amount: 498.3 },
    );
    assert.equal(plan.data.needsTaxReview, true);
});

test("an UNclassified row is not flagged by an amount change", () => {
    // No human answer to invalidate — flagging every re-synced purchase would
    // bury the ones that matter.
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", amount: 412.1 },
        { ...WRITE, amount: 498.3 },
    );
    assert.ok(!("needsTaxReview" in plan.data));
});

test("a classified row whose gross did NOT move is left alone", () => {
    // Cent-level equality, not object identity: the same money arriving as a
    // Decimal string must not read as a change on every single sync.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: "412.10" as unknown as number, taxAmount: 34.06,
        },
        { ...WRITE, amount: 412.1 },
    );
    assert.ok(!("needsTaxReview" in plan.data));
});

test("clearing a tax classification is never reported as 'unchanged'", () => {
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", taxAmount: 30, taxDeductibleBase: null },
        { ...WRITE, amount: 20 },
    );
    assert.equal(plan.data.needsTaxReview, true);
});

// ── provenance is cleared WITH the figure it described (round 34, item 2) ──

test("a gross too small for the recorded tax clears BOTH provenances, not just the tax's", () => {
    // The failure this replaces. The branch already cleared `taxAmount`,
    // `installedAtCustomer`, `taxDeductibleBase` and `taxSource` — but
    // `taxDeductibleBaseSource` was left standing at "manual". The row then
    // said: base NULL, and a person decided that base. Provenance for a figure
    // that does not exist. src/lib/receipt-intake/book.ts reads exactly this
    // column to decide whether an automated pass may touch the allocation, and
    // the correction UI shows it to a bookkeeper as their own answer.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1",
            estimateId: "estimate-1",
            amount: 412.1,
            taxAmount: 500,
            taxDeductibleBase: 50,
            installedAtCustomer: true,
            taxSource: "manual",
        },
        { ...WRITE, amount: 300 },
    );
    assert.equal(plan.data.taxAmount, null);
    assert.equal(plan.data.taxDeductibleBase, null);
    assert.equal(plan.data.taxSource, null, "the tax's provenance goes with the tax");
    assert.equal(plan.data.taxDeductibleBaseSource, null, "and the base's goes with the base");
    assert.equal(plan.data.needsTaxReview, true);
});

test("...from a NULL base source too — the write is unconditional, not a repair", () => {
    // A row that never had a base provenance still gets an explicit null, in
    // the same statement. The alternative — writing it only when something is
    // there to clear — makes the invariant depend on a read, and this branch's
    // whole point is that it does not.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1",
            estimateId: "estimate-1",
            amount: 412.1,
            taxAmount: 500,
            taxDeductibleBase: null,
            taxSource: null,
        },
        { ...WRITE, amount: 300 },
    );
    assert.equal(plan.data.taxDeductibleBaseSource, null);
    assert.ok("taxDeductibleBaseSource" in plan.data, "written, not merely absent");
});

test("a STRANDED allocation clears its provenance even though the tax is untouched", () => {
    // The other branch, and the one nothing else on this path would ever
    // reach: the recorded tax still fits the new gross, so `taxSource` is
    // deliberately left alone — but the hand allocation no longer fits, is
    // cleared, and its provenance has to go with it or the row keeps claiming
    // a bookkeeper split a receipt into figures it no longer carries.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1",
            estimateId: "estimate-1",
            amount: 412.1,
            taxAmount: 16.55,
            taxDeductibleBase: 300,
            taxSource: "ocr",
        },
        { ...WRITE, amount: 100 },
    );
    assert.equal(plan.data.taxDeductibleBase, null);
    assert.equal(plan.data.taxDeductibleBaseSource, null);
    assert.equal(plan.data.needsTaxReview, true);
    assert.ok(!("taxSource" in plan.data), "the TAX's provenance is deliberately untouched here");
    assert.ok(!("taxAmount" in plan.data), "and so is the tax itself");
});

test("an allocation that still fits keeps both the figure and its provenance", () => {
    // The control. If this ever starts clearing, the tests above are passing
    // because the branch fires on everything, not because it fires correctly.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1",
            estimateId: "estimate-1",
            amount: 412.1,
            taxAmount: 16.55,
            taxDeductibleBase: 50,
            taxSource: "manual",
        },
        { ...WRITE, amount: 412.1 },
    );
    assert.ok(!("taxDeductibleBase" in plan.data));
    assert.ok(!("taxDeductibleBaseSource" in plan.data));
});

test("deactivation RETIRES the tax classification in the same statement as the zeroing", async () => {
    // Codex round 7, item 2. Zeroing `amount` while leaving `taxAmount` behind
    // leaves taxAmount > amount, which the new CHECK refuses — so one
    // classified receipt would abort the whole sync. And the classification is
    // about a purchase QuickBooks says never happened.
    const fake = createFakePrisma([
        {
            ...WRITE,
            id: "expense-1",
            projectId: "project-1",
            receiptUrl: null,
            taxAmount: 16.55,
            taxAtSource: true,
            installedAtCustomer: true,
            taxDeductibleBase: 50,
            // A bookkeeper's split, with their name on it. The deactivate path
            // used to omit this column from the select, from the "is it
            // already retired?" test and from the write, so a deleted purchase
            // ended up with a NULL base and a "manual" source (round 34).
            taxDeductibleBaseSource: "manual",
            needsTaxReview: true,
        } as any,
    ]);
    assert.equal(
        await deactivateQboExpense(fake.client, {
            qbPurchaseId: "purchase-1",
            qbSyncToken: "1",
            qbSyncedAt: new Date("2026-07-29T14:00:00.000Z"),
            reason: "deleted",
        }),
        "removed",
    );
    const row = fake.rows.get("purchase-1") as any;
    assert.equal(row.amount, 0);
    assert.equal(row.taxAmount, null);
    assert.equal(row.taxAtSource, false);
    assert.equal(row.installedAtCustomer, null);
    assert.equal(row.taxDeductibleBase, null);
    assert.equal(row.taxDeductibleBaseSource, null, "the base's provenance retires with the base");
    assert.equal(row.needsTaxReview, false, "a vanished purchase is not something to re-check");
    // The constrained row is legal: tax <= amount and base <= amount - tax.
    assert.ok(Number(row.taxAmount ?? 0) <= Number(row.amount));
});

test("a second deactivation of an already-retired row is unchanged", async () => {
    const retired = {
        ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
        amount: 0, status: "Reviewed" as const,
        description: "[QuickBooks import] Removed in QBO (deleted)",
        qbSyncToken: "1",
        taxAmount: null, taxAtSource: false, taxSource: null, installedAtCustomer: null,
        taxDeductibleBase: null, taxDeductibleBaseSource: null, needsTaxReview: false,
    };
    const fake = createFakePrisma([retired as any]);
    assert.equal(
        await deactivateQboExpense(fake.client, {
            qbPurchaseId: "purchase-1", qbSyncToken: "1",
            qbSyncedAt: new Date("2026-07-29T15:00:00.000Z"), reason: "deleted",
        }),
        "unchanged",
    );
});

test("a row retired in every way EXCEPT the base's provenance is NOT 'unchanged'", async () => {
    // The half of the omission a write-only fix would miss. Clearing the
    // column on the write is not enough if the retirement TEST cannot see it:
    // a deleted purchase carrying a stale "manual" base source would answer
    // "unchanged" on this and every future pass, and the provenance would
    // outlive the purchase forever.
    const stale = {
        ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
        amount: 0, status: "Reviewed" as const,
        description: "[QuickBooks import] Removed in QBO (deleted)",
        qbSyncToken: "1",
        taxAmount: null, taxAtSource: false, taxSource: null, installedAtCustomer: null,
        taxDeductibleBase: null, taxDeductibleBaseSource: "manual", needsTaxReview: false,
    };
    const fake = createFakePrisma([stale as any]);
    assert.equal(
        await deactivateQboExpense(fake.client, {
            qbPurchaseId: "purchase-1", qbSyncToken: "1",
            qbSyncedAt: new Date("2026-07-29T15:00:00.000Z"), reason: "deleted",
        }),
        "removed",
    );
    assert.equal((fake.rows.get("purchase-1") as any).taxDeductibleBaseSource, null);
});

test("a tax PATCH landing mid-sync is NOT clobbered — the sync re-plans", async () => {
    // DETERMINISTIC CONCURRENCY, on the interleaving that actually loses data.
    //
    // The sync reads a row whose recorded tax ($500) is larger than the gross
    // it is about to write ($300), so its plan says "retire the whole
    // classification and flag it for review". Meanwhile a bookkeeper's PATCH
    // corrects the tax to $16.55 — perfectly valid against $300.
    //
    // Without the compare-and-set the sync writes a plan built from a figure
    // that no longer exists and wipes the correction. With it, the write misses
    // and the plan is recomputed against what is really there.
    const fake = createFakePrisma([
        {
            ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
            taxAmount: 500, taxDeductibleBase: null, installedAtCustomer: true,
        } as any,
    ]);

    const stored = fake.rows.get("purchase-1") as any;
    const prePatch = { ...stored };                       // what the sync read
    fake.rows.set("purchase-1", { ...stored, taxAmount: 16.55 });  // what the PATCH left

    let firstRead = true;
    const realFindUnique = fake.expense.findUnique;
    fake.expense.findUnique = async (args: any) => {
        if (firstRead) {
            firstRead = false;
            return prePatch;
        }
        return realFindUnique(args);
    };

    assert.equal(
        await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", amount: 300 }),
        "updated",
    );
    const after = fake.rows.get("purchase-1") as any;
    assert.equal(after.amount, 300, "the sync's own facts still land");
    assert.equal(after.taxAmount, 16.55, "the bookkeeper's correction survives");
    assert.equal(after.installedAtCustomer, true, "nor is their tax answer discarded");
    // The gross DID move ($125.50 -> $300) on a row carrying a human's tax
    // answer, so the re-plan flags it for review — a different outcome from the
    // stale plan, which would have retired the classification outright. What
    // the CAS protects is the correction itself, not the flag.
    assert.equal(after.needsTaxReview, true, "re-opened by the real amount change");
});

test("invalidating an ALLOCATION also flags the row — never a silent null", async () => {
    // Clearing the allocation on its own leaves a row that still reads as a
    // valid deduction: installedAtCustomer is untouched and a null base means
    // "the whole pre-tax total", so the report would quietly claim MORE than
    // the human allocated. This is the report-level regression.
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", taxAmount: 10, taxDeductibleBase: 150 },
        { ...WRITE, amount: 100 },
    );
    assert.equal(plan.data.taxDeductibleBase, null, "100 - 10 = 90 < 150");
    assert.equal(plan.data.needsTaxReview, true, "and the report must skip it until re-checked");
    // The tax itself is still valid against the new gross, so it stays.
    assert.ok(!("taxAmount" in plan.data));
});

// ── #3 interleaving: the sync never clobbers, and never gives up and writes ─

test("the sync takes the per-EXPENSE lock as well as the per-purchase one", async () => {
    const fake = createFakePrisma([
        { ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null } as any,
    ]);
    const keys: unknown[] = [];
    const wrapped = {
        ...fake.client,
        async $transaction(cb: any) {
            return fake.client.$transaction(async (tx: any) => {
                const inner = tx.$queryRawUnsafe;
                tx.$queryRawUnsafe = async (...args: unknown[]) => { keys.push(args[1]); return inner(...args); };
                return cb(tx);
            });
        },
    };
    await upsertQboExpense(wrapped as any, { ...WRITE, qbSyncToken: "1", amount: 400 });
    assert.ok(keys.includes("expense:expense-1"), `expense lock missing: ${JSON.stringify(keys)}`);
});

test("a RE-ATTRIBUTION mid-sync fails the CAS and is re-planned, not overwritten", async () => {
    // The attribution moved under the sync. `updatedAt` is in the predicate, so
    // the first write matches nothing; the re-plan reads the row as it now is.
    const fake = createFakePrisma([
        {
            ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
            taxAmount: 500, taxDeductibleBase: null, installedAtCustomer: true,
            updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        } as any,
    ]);
    const stored = fake.rows.get("purchase-1") as any;
    const prePatch = { ...stored };
    fake.rows.set("purchase-1", {
        ...stored, projectId: "moved-by-hand", taxAmount: 16.55,
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    });

    let firstRead = true;
    const realFindUnique = fake.expense.findUnique;
    fake.expense.findUnique = async (args: any) => {
        if (firstRead) { firstRead = false; return prePatch; }
        return realFindUnique(args);
    };

    await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", amount: 300 });
    const after = fake.rows.get("purchase-1") as any;
    assert.equal(after.projectId, "moved-by-hand", "the re-attribution stands");
    assert.equal(after.taxAmount, 16.55, "and the tax answer with it");
});

test("a permanently contended row is LEFT ALONE, never unconditionally written", async () => {
    // Both the CAS and its retry miss. The sync's own facts are recoverable on
    // the next run; a discarded human answer is not, so the correct move is to
    // do nothing rather than to clobber.
    const fake = createFakePrisma([
        {
            ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
            taxAmount: 500, taxDeductibleBase: null,
            updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        } as any,
    ]);
    const before = { ...(fake.rows.get("purchase-1") as any) };
    fake.expense.updateMany = async () => ({ count: 0 });
    let updateCalls = 0;
    fake.expense.update = (async () => { updateCalls += 1; return {} as never; }) as typeof fake.expense.update;

    const result = await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", amount: 300 });
    assert.equal(result, "unchanged");
    assert.equal(updateCalls, 0, "no unconditional write anywhere on this path");
    assert.deepEqual(fake.rows.get("purchase-1"), before);
});

// ── a REJECTED payload must never feed a suggestion (round 12, item 1) ─────

test("an out-of-order QBO payload cannot code the row from text that was refused", async () => {
    // The webhook arrives late and carries an OLDER SyncToken, so the upsert
    // correctly refuses it. Previously the sync then handed THAT payload's
    // vendor to the suggester, and the row was coded from a version of the
    // purchase the database had just thrown away.
    const fake = createFakePrisma([
        {
            ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
            qbSyncToken: "5", vendor: "General Hardware",
            description: "[QuickBooks import] misc supplies",
        } as any,
    ]);

    const stale = await upsertQboExpense(fake.client, {
        ...WRITE, qbSyncToken: "2", vendor: "Summit Plumbing",
        description: "[QuickBooks import] rough-in",
    });
    assert.equal(stale, "unchanged", "the older token is refused");
    assert.equal(fake.rows.get("purchase-1")?.vendor, "General Hardware", "and its text never lands");

    // The suggester reads what is STORED, so the refused "Summit Plumbing"
    // cannot reach it.
    const suggestion = fakeSuggestionClient({
        ...STORED_DEFAULT!,
        vendor: "General Hardware",
        description: "[QuickBooks import] misc supplies",
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(suggestion.client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS),
        "no-match",
        "the stored text matches nothing, so nothing is coded",
    );
});

test("the suggestion write is fenced on the row version AND the sync token", async () => {
    const fake = fakeSuggestionClient();
    await applyQboExpenseCostCodeSuggestion(fake.client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS);
    const where = fake.calls[0].where;
    assert.equal(where.qbSyncToken, "3", "a newer sync committing in the gap must lose");
    assert.deepEqual(where.updatedAt, new Date("2026-09-01T00:00:00.000Z"));
    assert.equal(where.costCodeId, null);
});

test("a newer sync landing between the read and the write wins", async () => {
    const fake = fakeSuggestionClient();
    fake.setCount(0); // the CAS matches nothing — the token moved
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(fake.client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS),
        "not-written",
    );
});

test("deleting a MANUALLY classified purchase retires its provenance too", () => {
    // Codex round 14, item 3. Leaving `taxSource` behind on a zeroed row means
    // the idempotency check never sees the classification as retired, so every
    // subsequent sync re-writes the same row and reports it as a change — and
    // the row still claims a person stands behind figures that are now null.
    const fake = createFakePrisma([
        {
            ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
            taxAmount: 34.06, taxAtSource: true, taxSource: "manual",
            installedAtCustomer: true, taxDeductibleBase: 100, needsTaxReview: false,
        } as any,
    ]);

    return (async () => {
        const removal = {
            qbPurchaseId: "purchase-1", qbSyncToken: "1",
            reason: "deleted", qbSyncedAt: new Date("2026-09-02T00:00:00.000Z"),
        };
        assert.equal(await deactivateQboExpense(fake.client, removal), "removed");
        const row = fake.rows.get("purchase-1") as any;
        assert.equal(row.amount, 0);
        assert.equal(row.taxAmount, null);
        assert.equal(row.taxSource, null, "nobody stands behind a purchase QBO says never happened");
        assert.equal(row.installedAtCustomer, null);
        assert.equal(row.taxDeductibleBase, null);
        assert.equal(row.needsTaxReview, false, "a gone purchase is not something to re-check");

        // ...and it is now genuinely idempotent.
        assert.equal(await deactivateQboExpense(fake.client, removal), "unchanged");
    })();
});

test("a manual NO-TAX decision is a classification, and a gross change re-opens it", () => {
    // Codex round 15, item 5. The bookkeeper looked at this receipt and decided
    // it carries no sales tax: taxAmount null, no allocation, no
    // installed-at-customer answer. Every other classification signal is
    // absent, so without `taxSource` this row — a human's explicit answer, now
    // describing a different gross — is the ONE row a re-sync says nothing
    // about.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: 412.1,
            taxAmount: null, taxDeductibleBase: null, installedAtCustomer: null,
            taxSource: "manual",
        },
        { ...WRITE, amount: 498.3 },
    );
    assert.equal(plan.data.needsTaxReview, true);
    assert.ok(!("taxAmount" in plan.data), "their answer is kept, only re-opened");
});

test("an OCR no-tax row is NOT re-opened by a gross change", () => {
    // The control. Nothing here is a human answer, so flagging it would bury
    // the rows that are.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: 412.1, taxAmount: null, taxDeductibleBase: null,
            installedAtCustomer: null, taxSource: "ocr",
        },
        { ...WRITE, amount: 498.3 },
    );
    assert.ok(!("needsTaxReview" in plan.data));
});

test("the sync READS taxSource, or the rule above can never fire", () => {
    // A rule that depends on a column nobody selected is a rule that does not
    // exist. This is the wiring check the pure-function tests cannot make.
    const fake = createFakePrisma([
        {
            ...WRITE, id: "expense-1", projectId: "project-1", receiptUrl: null,
            amount: 125.5, taxAmount: null, taxDeductibleBase: null,
            installedAtCustomer: null, taxSource: "manual", needsTaxReview: false,
        } as any,
    ]);
    return (async () => {
        assert.equal(
            await upsertQboExpense(fake.client, { ...WRITE, qbSyncToken: "1", amount: 300 }),
            "updated",
        );
        const row = fake.rows.get("purchase-1") as any;
        assert.equal(row.needsTaxReview, true, "the manual no-tax answer was re-opened");
        assert.equal(row.taxSource, "manual", "and left standing");
    })();
});

// ── signed credits in the sync (Codex round 17, item 1) ────────────────────

test("a REFUND's negative tax is not retired by a re-sync", () => {
    // `-4 > -50` is true, so the old comparison retired the classification on
    // every credit it ever saw: a -$50 return with -$4 of tax lost its tax
    // fields on the next sync, and the filing quietly stopped netting it.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: -50, taxAmount: -4, taxDeductibleBase: -40,
        },
        { ...WRITE, amount: -50 },
    );
    assert.ok(!("taxAmount" in plan.data), "the classification stands");
    assert.ok(!("taxDeductibleBase" in plan.data));
    assert.ok(!("needsTaxReview" in plan.data), "and nothing to re-check");
});

test("a REDUCED refund that can no longer carry its tax is flagged, not aborted", () => {
    // QBO now says the credit was only $3 while the row still records $4 of tax
    // coming back. That violates |tax| <= |amount| — the database CHECK would
    // refuse the write and take the whole import down with it — so the
    // classification is cleared and a person is asked.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: -50, taxAmount: -4, taxDeductibleBase: -40,
        },
        { ...WRITE, amount: -3 },
    );
    assert.equal(plan.data.taxAmount, null);
    assert.equal(plan.data.taxAtSource, false);
    assert.equal(plan.data.taxDeductibleBase, null);
    assert.equal(plan.data.installedAtCustomer, null);
    assert.equal(plan.data.needsTaxReview, true, "asked, never silently dropped");
    assert.equal(plan.data.taxSource, null, "no human figures survive, so no human source does either");
});

test("invalidation clears taxSource too, whichever human answer it recorded", () => {
    // Codex round 31: this branch used to null every tax FIGURE but leave
    // `taxSource` standing as "manual" or "manual-none" — which book.ts reads
    // as "a person already answered", permanently blocking an OCR read from
    // ever refilling `taxAmount` on a row whose human answer no longer
    // describes any receipt. Covers both states a human answer can leave.
    for (const taxSource of ["manual", "manual-none"] as const) {
        const plan = planQboExpenseUpdate(
            {
                projectId: "project-1", estimateId: "estimate-1",
                amount: -50, taxAmount: -4, taxDeductibleBase: -40, taxSource,
            },
            { ...WRITE, amount: -3 },
        );
        assert.equal(plan.data.taxAmount, null, taxSource);
        assert.equal(plan.data.taxDeductibleBase, null, taxSource);
        assert.equal(plan.data.taxSource, null, taxSource);
    }
});

test("a credit that FLIPS to a purchase invalidates the classification", () => {
    // The tax now points against the money: whatever this row is, it is not the
    // receipt somebody classified.
    const plan = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: -50, taxAmount: -4, taxDeductibleBase: null,
        },
        { ...WRITE, amount: 50 },
    );
    assert.equal(plan.data.taxAmount, null);
    assert.equal(plan.data.needsTaxReview, true);
});

test("a refund's ALLOCATION is judged on magnitude too", () => {
    // -$46 of allocation against a -$50 credit with -$4 of tax is exact; a
    // shrunken credit strands it and the row is flagged rather than left
    // claiming more than the receipt.
    const fits = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: -50, taxAmount: -4, taxDeductibleBase: -46,
        },
        { ...WRITE, amount: -50 },
    );
    assert.ok(!("needsTaxReview" in fits.data));

    const stranded = planQboExpenseUpdate(
        {
            projectId: "project-1", estimateId: "estimate-1",
            amount: -50, taxAmount: -4, taxDeductibleBase: -46,
        },
        { ...WRITE, amount: -20 },
    );
    assert.equal(stranded.data.taxDeductibleBase, null);
    assert.equal(stranded.data.needsTaxReview, true);
});

// ── the suggester resolves the job INSIDE its transaction (round 19, item 4) ─

/** A suggestion client that can open a transaction, with a scripted world. */
function suggestionTxClient(world: {
    stored: StoredForSuggestion;
    estimateProject: string | null;
    phaseOk?: boolean;
    onEstimateRead?: () => void;
}) {
    const writes: any[] = [];
    const client: any = {
        async $transaction(run: (tx: any) => Promise<unknown>) { return run(client); },
        async $queryRawUnsafe(query: string, ...args: unknown[]) {
            if (/FROM "Estimate" WHERE id/.test(query) && /"projectId"/.test(query)) {
                world.onEstimateRead?.();
                return [{ projectId: world.estimateProject }];
            }
            // The phase PROOF query answers AND locks (round 32), so it has to
            // be matched before the blanket FOR SHARE short-circuit below —
            // otherwise every phase check here would silently read as
            // "not-a-phase" and the suggester tests would prove nothing.
            if (/SELECT 1 AS ok/.test(query)) return world.phaseOk === false ? [] : [{ ok: 1 }];
            if (/FOR SHARE/.test(query)) return [];
            if (/FROM "Project" WHERE id/.test(query)) return [{ id: args[0], status: "In Progress" }];
            if (/FROM "CostCode" WHERE id/.test(query)) {
                return [{ id: args[0], code: "03-PLUMB", isActive: true }];
            }
            return [];
        },
        expense: {
            async findUnique() { return world.stored; },
            async updateMany(args: any) { writes.push(args); return { count: 1 }; },
        },
    };
    return { client, writes };
}

test("a FALLBACK-attributed row is scoped by the estimate read under lock", async () => {
    const { client, writes } = suggestionTxClient({
        stored: {
            ...(STORED_DEFAULT as object), projectId: null, estimateId: "estimate-1",
            estimate: { projectId: "project-1" },
        } as StoredForSuggestion,
        estimateProject: "project-1",
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS),
        "written",
    );
    // The write is pinned to the job the decision was made for.
    assert.equal(writes[0].where.projectId, null);
    assert.deepEqual(writes[0].where.estimate, { is: { projectId: "project-1" } });
});

test("an estimate REASSIGNED mid-suggestion is not coded for its old job", async () => {
    // The read that produced `projectId` happened on the global client; the
    // estimate moves before the transaction resolves it again. Coding the row
    // now would apply a phase list belonging to a job it is no longer on.
    //
    // Since round 37 item 3 the pass STOPS at the disagreement rather than
    // re-asking the phase question about the new job: that job's Project row
    // is not in the lock set this transaction took at its top, so reaching for
    // it would be the Estimate -> Project inversion the canonical order
    // forbids. `phaseOk: false` is left in place deliberately — the outcome
    // must not depend on whether the code happens to be a phase of the job the
    // row joined, because that question is no longer asked.
    const { client, writes } = suggestionTxClient({
        stored: {
            ...(STORED_DEFAULT as object), projectId: null, estimateId: "estimate-1",
            estimate: { projectId: "project-1" },
        } as StoredForSuggestion,
        // The locked read is the first to see the move.
        estimateProject: "project-2",
        phaseOk: false,   // 03-PLUMB is not a phase of the job it moved to
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS),
        "scope-moved",
    );
    assert.equal(writes.length, 0, "nothing is written on the old job's reasoning");
});

test("...and it stops there even when the code IS a phase of the new job", async () => {
    // The control for the test above. Without it, "scope-moved" could be the
    // phase check failing under another name; this one would sail through the
    // phase check and still must not write, because the suggestion was
    // computed from the OLD job's scope and the new job's rows are not held.
    const { client, writes } = suggestionTxClient({
        stored: {
            ...(STORED_DEFAULT as object), projectId: null, estimateId: "estimate-1",
            estimate: { projectId: "project-1" },
        } as StoredForSuggestion,
        estimateProject: "project-2",
        phaseOk: true,
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS),
        "scope-moved",
    );
    assert.equal(writes.length, 0, "the next sync re-scopes it from scratch");
});

test("an estimate that lost its project mid-suggestion is skipped", async () => {
    const { client, writes } = suggestionTxClient({
        stored: {
            ...(STORED_DEFAULT as object), projectId: null, estimateId: "estimate-1",
            estimate: { projectId: "project-1" },
        } as StoredForSuggestion,
        estimateProject: null,
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS),
        "skipped-no-project",
    );
    assert.equal(writes.length, 0);
});

test("a row with its OWN projectId needs no estimate read at all", async () => {
    let estimateReads = 0;
    const { client, writes } = suggestionTxClient({
        stored: { ...(STORED_DEFAULT as object) } as StoredForSuggestion,
        estimateProject: "project-1",
        onEstimateRead: () => { estimateReads += 1; },
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS),
        "written",
    );
    assert.equal(estimateReads, 0, "the column answers for itself");
    assert.equal(writes[0].where.projectId, "project-1");
});

test("round 36 item 3: a CLEARED phase is a human decision the suggester must not undo", async () => {
    // The bug this replaces. Clearing the phase wrote `costCodeId: null,
    // costCodeSource: null`, and NULL provenance is exactly the state this
    // function reads as "no human has spoken, a machine may write". So the very
    // next sync re-applied the same regex suggestion the bookkeeper had just
    // removed, and the clear came undone with nothing to show it had happened.
    //
    // A cleared row now carries "manual-none" — the same shape `taxSource`
    // uses for "a person looked and the answer is nothing" — and both the
    // read-side guard and the update predicate refuse it.
    const fake = fakeSuggestionClient({
        ...STORED_DEFAULT!,
        costCodeId: null,
        costCodeSource: "manual-none",
    });
    const result = await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1" },
        COST_CODE_IDS,
    );
    assert.equal(result, "not-written");
    assert.equal(fake.calls.length, 0, "the suggester must not even attempt the write");
});

test("round 36 item 3: the clear survives even if the read-side guard is bypassed", async () => {
    // Belt and braces, and the braces are the part that actually holds: the
    // read guard stops us COMPUTING a suggestion nobody may use, the update
    // predicate is the guarantee. A row cleared between the read and the write
    // must be excluded by the WHERE, not merely by the early return.
    const fake = fakeSuggestionClient({ ...STORED_DEFAULT!, costCodeId: null, costCodeSource: null });
    await applyQboExpenseCostCodeSuggestion(fake.client, { qbPurchaseId: "purchase-1" }, COST_CODE_IDS);
    const branches = fake.calls[0].where.OR as { costCodeSource?: { notIn?: string[] } | null }[];
    const notIn = branches.find(branch => branch.costCodeSource && "notIn" in branch.costCodeSource)!;
    assert.ok(
        notIn.costCodeSource!.notIn!.includes("manual-none"),
        "a row cleared after the read must still be excluded by the write predicate",
    );
});

// --- Attachment work stops on a shared QBO failure ---

test("a connection-level attach failure stops the rest and marks the run incomplete", async () => {
    const { QboRetryableError } = await import("../src/lib/quickbooks");
    const fake = createFakePrisma();
    const purchases = [PURCHASE, { ...PURCHASE, Id: "1002", DocNumber: "DOC-1002" }, { ...PURCHASE, Id: "1003", DocNumber: "DOC-1003" }];
    const attempted: string[] = [];

    const dependencies = {
        ...createSyncDependencies(purchases, ACTIVE_PROJECTS, (write) => upsertQboExpense(fake.client, write)),
        attachReceipt: async (_tokens: unknown, qbPurchaseId: string) => {
            attempted.push(qbPurchaseId);
            throw new QboRetryableError("QBO went away", 503);
        },
    };

    const result = await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies as never);

    // Codex gate: every further attachment would spend a full deadline
    // learning the same thing, and a run that gave up on them is not clean.
    assert.equal(attempted.length, 1, `kept attaching after an outage: ${attempted.length} attempts`);
    assert.equal(result.attachmentsIncomplete, true);
    assert.ok((result.attachmentsSkipped ?? 0) >= 1, "what was given up on must be counted");
    // The expense rows themselves still imported — attachments are a follow-on.
    assert.ok(result.imported >= 1, "the import itself is unaffected");
});

test("an ordinary attach failure does not stop the rest, but IS counted", async () => {
    const fake = createFakePrisma();
    const purchases = [PURCHASE, { ...PURCHASE, Id: "1002", DocNumber: "DOC-1002" }];
    const attempted: string[] = [];

    const dependencies = {
        ...createSyncDependencies(purchases, ACTIVE_PROJECTS, (write) => upsertQboExpense(fake.client, write)),
        attachReceipt: async (_tokens: unknown, qbPurchaseId: string) => {
            attempted.push(qbPurchaseId);
            throw new Error("no attachment on this one");
        },
    };

    const result = await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies as never);

    assert.equal(attempted.length, purchases.length, "a per-purchase problem is not an outage");
    // Codex gate: this used to assert attachmentsIncomplete stayed undefined,
    // codifying a false green — a whole run of receipts that never landed
    // reported a perfectly clean sync. The run continues, but it is honest.
    assert.equal(result.attachmentsIncomplete, true);
    assert.equal(result.attachmentsSkipped, purchases.length);
});


// --- A transient attachment DOWNLOAD failure is classified, not generic ---

test("the attachment download classifies its response like every other QBO call", async () => {
    const { qboResponseError, isRetryableQboError, qboHttpStatus } = await import("../src/lib/quickbooks");
    // attachQboReceipt reads the Expense row from the real prisma client before
    // it ever reaches the download, so the end-to-end helper needs a database.
    // What CHANGED is the classification of the download response, and that is
    // exactly what this asserts - the same qboResponseError the helper now
    // calls instead of `throw new Error(...)`.
    //
    // Codex gate: a bare Error made a 503 on the download indistinguishable
    // from a 404, so the sync could not tell "this file is gone" from "QBO is
    // down" and ground through the rest of the run either way. The
    // stop-on-outage behaviour that depends on this is covered by
    // "a connection-level attach failure stops the rest and marks the run
    // incomplete" above.
    for (const status of [408, 429, 500, 503]) {
        const error = await qboResponseError(new Response("busy", { status }), "QBO attachment download");
        assert.equal(isRetryableQboError(error), true, `status ${status} should be retryable`);
    }
    for (const status of [400, 403, 404]) {
        const error = await qboResponseError(new Response("nope", { status }), "QBO attachment download");
        assert.equal(qboHttpStatus(error), status, `status ${status} should stay terminal`);
    }
});


test("a receipt QBO HAS but we cannot store is counted, while a purchase with no receipt is not", async () => {
    const fake = createFakePrisma();
    const purchases = [PURCHASE, { ...PURCHASE, Id: "1002", DocNumber: "DOC-1002" }];

    // "no-attachment" is the normal case for most purchases and must NOT make
    // the run partial; "attachment-unavailable" means there IS a receipt we
    // failed to store, and must.
    const clean = {
        ...createSyncDependencies(purchases, ACTIVE_PROJECTS, (write) => upsertQboExpense(fake.client, write)),
        attachReceipt: async () => "no-attachment",
    };
    const cleanResult = await syncQboExpenses({ since: new Date("2026-01-01") }, clean as never);
    assert.equal(cleanResult.attachmentsIncomplete, undefined, "no receipt in QBO is not a failure");

    const fake2 = createFakePrisma();
    const unavailable = {
        ...createSyncDependencies(purchases, ACTIVE_PROJECTS, (write) => upsertQboExpense(fake2.client, write)),
        attachReceipt: async () => "attachment-unavailable",
    };
    const unavailableResult = await syncQboExpenses({ since: new Date("2026-01-01") }, unavailable as never);
    assert.equal(unavailableResult.attachmentsIncomplete, true, "a receipt we could not store is");
    assert.ok((unavailableResult.attachmentsSkipped ?? 0) >= 1);
});


test("attachables that exist but cannot be fetched are unavailable, not absent", async () => {
    const { attachQboReceipt } = await import("../src/lib/qbo-receipt-attachments");
    void attachQboReceipt;
    // Codex gate: the candidate filter drops attachables with no
    // TempDownloadUri, so a purchase whose ONLY attachments lacked a download
    // URL fell through to "no-attachment" — indistinguishable from a purchase
    // QuickBooks has no receipt for, and therefore never counted. The rule is
    // now: nothing in QBO at all -> no-attachment; something there we could
    // not get at -> attachment-unavailable.
    const { isAttachmentFailure } = await import("../src/lib/qbo-receipt-attachments");
    assert.equal(isAttachmentFailure("attachment-unavailable"), true);
    assert.equal(isAttachmentFailure("storage-unavailable"), true);
    // The normal case stays clean.
    assert.equal(isAttachmentFailure("no-attachment"), false);
    assert.equal(isAttachmentFailure("attached"), false);
    assert.equal(isAttachmentFailure("already-linked"), false);
    assert.equal(isAttachmentFailure("no-expense"), false);
});
