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

function createFakePrisma(initial: StoredExpense[] = []) {
    const rows = new Map(initial.map((row) => [row.qbPurchaseId, { ...row }]));
    const expense = {
        async findUnique(args: { where: { qbPurchaseId: string } }) {
            return rows.get(args.where.qbPurchaseId) ?? null;
        },
        async create(args: { data: QboExpenseWrite }) {
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
                const transactionLock = {
                    async $queryRawUnsafe() {
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
        skipped: [],
    });
    assert.deepEqual(await syncQboExpenses({ since: new Date("2026-01-01") }, dependencies), {
        imported: 0,
        updated: 0,
        removed: 0,
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
        skipped: first.skipped,
    });
    assert.equal(fake.rows.size, 1);
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
    costCodeId: string | null;
    costCodeSource: string | null;
    estimate?: { projectId: string | null } | null;
} | null;

function fakeSuggestionClient(
    stored: StoredForSuggestion = { projectId: "project-1", costCodeId: null, costCodeSource: null },
) {
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
        {
            qbPurchaseId: "purchase-1",
            vendor: "Summit Plumbing",
            description: "[QuickBooks import] rough-in",
        },
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
        { qbPurchaseId: "purchase-1", vendor: "Ferguson", description: "x" },
        COST_CODE_IDS,
    );
    const where = fake.calls[0].where;
    assert.equal(where.qbPurchaseId, "purchase-1");
    assert.equal(where.costCodeId, null);
    assert.deepEqual(where.OR, [
        { costCodeSource: null },
        { costCodeSource: { notIn: ["capture", "manual"] } },
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
        projectId: null,
        costCodeId: null,
        costCodeSource: null,
        estimate: { projectId: "project-1" },
    });
    await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1", vendor: "Ferguson", description: "x" },
        COST_CODE_IDS,
    );
    assert.equal(fake.calls[0].where.projectId, null);
});

test("a row a human already coded is refused on the STORED source, before any write", async () => {
    for (const costCodeSource of ["capture", "manual"]) {
        const fake = fakeSuggestionClient({ projectId: "project-1", costCodeId: null, costCodeSource });
        const result = await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1", vendor: "Ferguson", description: "x" },
            COST_CODE_IDS,
        );
        assert.equal(result, "not-written", costCodeSource);
        assert.equal(fake.calls.length, 0, "and it never even issues the guarded write");
    }
});

test("a row that is already coded is left alone", async () => {
    const fake = fakeSuggestionClient({ projectId: "project-1", costCodeId: "cc-existing", costCodeSource: null });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1", vendor: "Ferguson", description: "x" },
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
        projectId: OVERHEAD_PROJECT_ID,
        costCodeId: null,
        costCodeSource: null,
    });
    const result = await applyQboExpenseCostCodeSuggestion(
        fake.client,
        { qbPurchaseId: "purchase-1", vendor: "Summit Plumbing", description: "x" },
        COST_CODE_IDS,
    );
    assert.equal(result, "skipped-overhead");
    assert.equal(fake.calls.length, 0);
});

test("the stored project is resolved through the estimate when the column is NULL", async () => {
    const fake = fakeSuggestionClient({
        projectId: null,
        costCodeId: null,
        costCodeSource: null,
        estimate: { projectId: OVERHEAD_PROJECT_ID },
    });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1", vendor: "Summit Plumbing", description: "x" },
            COST_CODE_IDS,
        ),
        "skipped-overhead",
    );
});

test("a row with no job at all gets no job phase", async () => {
    const fake = fakeSuggestionClient({ projectId: null, costCodeId: null, costCodeSource: null, estimate: null });
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "purchase-1", vendor: "Summit Plumbing", description: "x" },
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
            { qbPurchaseId: "gone", vendor: "Summit Plumbing", description: "x" },
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
        { qbPurchaseId: "purchase-1", vendor: "Summit Plumbing", description: "x" },
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
        { qbPurchaseId: "purchase-1", vendor: "Summit Plumbing", description: "x" },
        COST_CODE_IDS,
        async (projectId, costCodeId) => { asked.push({ projectId, costCodeId }); return true; },
    );
    assert.deepEqual(asked, [{ projectId: "project-1", costCodeId: "cc-plumb" }]);
    assert.equal(fake.calls.length, 1, "an allowed phase still writes");
});

test("no rule match and an unknown code both write nothing", async () => {
    const fake = fakeSuggestionClient();
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "p", vendor: "General Hardware", description: "misc" },
            COST_CODE_IDS,
        ),
        "no-match",
    );
    assert.equal(
        await applyQboExpenseCostCodeSuggestion(
            fake.client,
            { qbPurchaseId: "p", vendor: "Summit Plumbing", description: "x" },
            new Map(),
        ),
        "unknown-code",
    );
    assert.equal(fake.calls.length, 0);
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
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", taxAmount: 10, taxDeductibleBase: 50 },
        { ...WRITE, amount: 100 },
    );
    assert.ok(!("taxAmount" in plan.data));
    assert.ok(!("needsTaxReview" in plan.data));
    assert.ok(!("installedAtCustomer" in plan.data));
});

test("clearing a tax classification is never reported as 'unchanged'", () => {
    const plan = planQboExpenseUpdate(
        { projectId: "project-1", estimateId: "estimate-1", taxAmount: 30, taxDeductibleBase: null },
        { ...WRITE, amount: 20 },
    );
    assert.equal(plan.data.needsTaxReview, true);
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
        taxAmount: null, taxAtSource: false, installedAtCustomer: null,
        taxDeductibleBase: null, needsTaxReview: false,
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
    assert.notEqual(after.needsTaxReview, true, "and it is not flagged on a stale premise");
    assert.equal(after.installedAtCustomer, true, "nor is their tax answer discarded");
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
