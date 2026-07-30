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
