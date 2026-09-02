import assert from "node:assert/strict";
import test from "node:test";
import {
    deactivateQboExpense,
    findActiveProjectForQboPurchase,
    normalizeQboPurchase,
    syncQboExpenses,
    upsertQboExpense,
    type QboExpenseProjectCandidate,
    type QboExpenseSyncDependencies,
    type QboExpenseWrite,
    type QboPurchaseNormalizationSkipReason,
    type QboPurchaseForImport,
} from "../src/lib/qbo-expense-sync";

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
    };
    let lockTail: Promise<void> = Promise.resolve();

    return {
        rows,
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
