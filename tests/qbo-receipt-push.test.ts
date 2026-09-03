import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
    createQBReceiptPurchase,
    ensureQBVendor,
    QboAccountConfigError,
    QboVendorDuplicateError,
    QboPurchaseFaultError,
    stableAttachmentFileName,
    compareExistingPurchase,
    readBookedPurchase,
    type CreateQBReceiptPurchaseInput,
    type ExistingPurchaseCheck,
    type QboReceiptProjectCandidate,
    type QboReceiptPushDependencies,
    type ReceiptAttachmentStatus,
} from "../src/lib/qbo-receipt-push";
import {
    createQboReceiptCreateHandlers,
    type QboReceiptCreateHandlerDependencies,
} from "../src/app/api/integrations/qbo-receipts/create/route";
import type { AutomationEventInput } from "../src/lib/automation-events";

const TOKENS = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    realmId: "test-realm",
};

const BANK_ACCOUNT_ID = process.env.QBO_RECEIPT_BANK_ACCOUNT_ID || "154";
const EXPENSE_ACCOUNT_ID = process.env.QBO_RECEIPT_EXPENSE_ACCOUNT_ID || "98";
const TAX_ACCOUNT_ID = process.env.QBO_RECEIPT_TAX_ACCOUNT_ID || "1150040032";

const PROJECT: QboReceiptProjectCandidate = { id: "project-1", name: "Mueller Remodel" };

function baseInput(overrides: Partial<CreateQBReceiptPurchaseInput> = {}): CreateQBReceiptPurchaseInput {
    return {
        projectName: "Mueller Remodel",
        vendor: "Home Depot",
        date: "2026-07-15",
        invoice: "INV-100",
        totalAmount: 150,
        fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
        fileName: "receipt.jpg",
        groups: [{ category: "03 Plumbing", amount: 150, lines: [{ desc: "PVC pipe" }] }],
        ...overrides,
    };
}

/**
 * A QBO Purchase that AGREES with baseInput(), in the shape QBO really returns
 * one: TotalAmt and TxnDate on the entity, the vendor on EntityRef, and the job
 * on each expense line's CustomerRef.
 *
 * The fixtures used to be `{ Id, PrivateNote }` because those were the only two
 * fields the code selected — which is exactly the finding: two fields can say
 * "this is our Purchase" and cannot say "and it agrees with this document".
 */
function bookedPurchase(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        Id: "purchase-99",
        TotalAmt: 150,
        TxnDate: "2026-07-15",
        EntityRef: { value: "vendor-1", name: "Home Depot", type: "Vendor" },
        Line: [{
            Amount: 150,
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
                AccountRef: { value: EXPENSE_ACCOUNT_ID, name: "COGS Supplies & materials" },
                CustomerRef: { value: "cust-1", name: "Mueller Remodel" },
            },
        }],
        ...over,
    };
}

/** The verdict a matching books row produces, for the result deepEquals below. */
const MATCHED = {
    verdict: "match",
    differences: [],
    booked: {
        totalAmount: 150,
        txnDate: "2026-07-15",
        vendor: "Home Depot",
        projectNames: ["Mueller Remodel"],
        lines: [{ tax: false, customerId: "cust-1", customerName: "Mueller Remodel", readable: true }],
        taxAmount: 0,
    },
};

/** The account-identity check runs against whatever id was queried — return the shape it expects for either. */
function defaultAccountRow(query: string): Array<{ Id: string; Name: string; AccountType: string }> {
    if (query.includes(`'${BANK_ACCOUNT_ID}'`)) {
        return [{ Id: BANK_ACCOUNT_ID, Name: "Washington Trust Bank", AccountType: "Bank" }];
    }
    if (query.includes(`'${EXPENSE_ACCOUNT_ID}'`)) {
        return [{ Id: EXPENSE_ACCOUNT_ID, Name: "COGS Supplies & materials", AccountType: "Cost of Goods Sold" }];
    }
    if (query.includes(`'${TAX_ACCOUNT_ID}'`)) {
        return [{ Id: TAX_ACCOUNT_ID, Name: "Reimbursable Sales Tax Paid", AccountType: "Cost of Goods Sold" }];
    }
    return [];
}

interface DepsOverrides {
    existingRows?: Array<Record<string, unknown>>;
    createdId?: string;
    customerId?: string;
    vendorId?: string;
    vendorImpl?: QboReceiptPushDependencies["ensureVendorFn"];
    projects?: QboReceiptProjectCandidate[];
    uploadAttachment?: QboReceiptPushDependencies["uploadAttachment"];
    accountRows?: (query: string) => Array<Record<string, unknown>>;
    /** Rows returned for the "SELECT * FROM attachable ..." existence check. */
    attachableRows?: Array<Record<string, unknown>>;
    /** Lets a test make the attachable lookup itself fail. */
    attachableQueryImpl?: () => Promise<Array<Record<string, unknown>>>;
}

function createDeps(overrides: DepsOverrides = {}) {
    const calls = {
        queries: [] as string[],
        creates: [] as Array<{ payload: Record<string, unknown>; requestId: string }>,
        vendorCalls: [] as string[],
        customerCalls: [] as string[],
    };
    const deps: Partial<QboReceiptPushDependencies> = {
        qbQueryFn: async (_tokens: unknown, query: string) => {
            calls.queries.push(query);
            if (/FROM Account/i.test(query)) {
                return (overrides.accountRows?.(query) ?? defaultAccountRow(query)) as never[];
            }
            if (/FROM attachable/i.test(query)) {
                if (overrides.attachableQueryImpl) return (await overrides.attachableQueryImpl()) as never[];
                return (overrides.attachableRows ?? []) as never[];
            }
            return (overrides.existingRows ?? []) as never[];
        },
        qbCreateFn: async (_tokens, payload, requestId) => {
            calls.creates.push({ payload, requestId });
            return { id: overrides.createdId ?? "purchase-1" };
        },
        ensureVendorFn:
            overrides.vendorImpl ??
            (async (_tokens, name: string) => {
                calls.vendorCalls.push(name);
                return overrides.vendorId ?? "vendor-1";
            }),
        ensureCustomerFn: async (_tokens, client) => {
            calls.customerCalls.push(client.name);
            return overrides.customerId ?? "cust-1";
        },
        listProjects: async () => overrides.projects ?? [PROJECT],
        uploadAttachment:
            overrides.uploadAttachment ??
            (async () => "attached" as ReceiptAttachmentStatus),
    };
    return { deps, calls };
}

// ─── Idempotency ────────────────────────────────────────────────────────────

test("createQBReceiptPurchase short-circuits when the DocNumber and marker both match", async () => {
    const input = baseInput();
    const marker = `[gtr-file:${input.fileId}]`;
    const { deps, calls } = createDeps({ existingRows: [bookedPurchase({ PrivateNote: `note ${marker}` })] });
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.deepEqual(result, {
        ok: true,
        qbPurchaseId: "purchase-99",
        docNumber: input.fileId.slice(0, 21),
        alreadyExists: true,
        // No file in this input, so there is nothing to attach.
        attachment: "skipped",
        existing: MATCHED,
    });
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.vendorCalls.length, 0);
    assert.equal(calls.customerCalls.length, 0);
});

test("createQBReceiptPurchase returns docnumber-conflict when the DocNumber matches but the full-fileId marker doesn't", async () => {
    const input = baseInput();
    const { deps, calls } = createDeps({ existingRows: [{ Id: "purchase-99", PrivateNote: "an unrelated purchase" }] });
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.deepEqual(result, { ok: false, reason: "docnumber-conflict", docNumber: input.fileId.slice(0, 21) });
    assert.equal(calls.creates.length, 0);
});

test("createQBReceiptPurchase treats multiple DocNumber matches as a conflict", async () => {
    const input = baseInput();
    const marker = `[gtr-file:${input.fileId}]`;
    const { deps, calls } = createDeps({
        existingRows: [
            { Id: "purchase-1", PrivateNote: marker },
            { Id: "purchase-2", PrivateNote: marker },
        ],
    });
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "docnumber-conflict");
    assert.equal(calls.creates.length, 0);
});

// ─── Exact project match ────────────────────────────────────────────────────

test("createQBReceiptPurchase requires an EXACT project name match — a near-miss is not matched", async () => {
    const { deps, calls } = createDeps({ projects: [{ id: "p1", name: "Smith Bathroom" }] });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({ projectName: "Smith Kitchen" }), deps);

    assert.deepEqual(result, { ok: false, reason: "project-not-matched", projectName: "Smith Kitchen" });
    assert.equal(calls.creates.length, 0);
});

test("createQBReceiptPurchase matches on normalized whitespace/case only", async () => {
    const { deps } = createDeps({ projects: [{ id: "p1", name: "Mueller Remodel" }] });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({ projectName: "  mueller   remodel  " }), deps);
    assert.equal(result.ok, true);
});

test("createQBReceiptPurchase refuses an ambiguous exact match across two identically-named projects", async () => {
    const { deps } = createDeps({
        projects: [{ id: "p1", name: "Shop" }, { id: "p2", name: "Shop" }],
    });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({ projectName: "Shop" }), deps);
    assert.deepEqual(result, { ok: false, reason: "project-not-matched", projectName: "Shop" });
});

// ─── Required fields ────────────────────────────────────────────────────────

test("createQBReceiptPurchase treats a missing/empty/Unknown vendor as terminal", async () => {
    for (const vendor of [undefined, "", "   ", "Unknown", "unknown"]) {
        const { deps, calls } = createDeps();
        const result = await createQBReceiptPurchase(TOKENS, baseInput({ vendor }), deps);
        assert.deepEqual(result, { ok: false, reason: "missing-vendor" });
        assert.equal(calls.creates.length, 0);
        assert.equal(calls.vendorCalls.length, 0);
    }
});

test("createQBReceiptPurchase requires a present, calendar-valid date with no fallback", async () => {
    for (const date of [undefined, "", "07/15/2026", "2026-02-30", "not-a-date"]) {
        const { deps, calls } = createDeps();
        const result = await createQBReceiptPurchase(TOKENS, baseInput({ date }), deps);
        assert.deepEqual(result, { ok: false, reason: "invalid-date" });
        assert.equal(calls.creates.length, 0);
    }
});

// ─── Money validation ───────────────────────────────────────────────────────

test("createQBReceiptPurchase rejects a negative or non-finite included group amount", async () => {
    const { deps: deps1, calls: calls1 } = createDeps();
    const result1 = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ groups: [{ category: "03 Plumbing", amount: -50 }], totalAmount: -50 }),
        deps1,
    );
    assert.deepEqual(result1, { ok: false, reason: "invalid-group-amount" });
    assert.equal(calls1.creates.length, 0);

    const { deps: deps2, calls: calls2 } = createDeps();
    const result2 = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ groups: [{ category: "03 Plumbing", amount: Number.NaN }] }),
        deps2,
    );
    assert.deepEqual(result2, { ok: false, reason: "invalid-group-amount" });
    assert.equal(calls2.creates.length, 0);
});

test("createQBReceiptPurchase requires a finite, positive totalAmount", async () => {
    const { deps, calls } = createDeps();
    const result = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ totalAmount: undefined as unknown as number }),
        deps,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "amount-mismatch");
    assert.equal(calls.creates.length, 0);
});

test("createQBReceiptPurchase rejects a group sum that drifts from totalAmount by more than 2 cents", async () => {
    const { deps, calls } = createDeps();
    const result = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ totalAmount: 200, groups: [{ category: "03 Plumbing", amount: 150 }] }),
        deps,
    );

    assert.equal(result.ok, false);
    if (!result.ok && result.reason === "amount-mismatch") {
        assert.equal(result.groupsSum, 150);
        assert.equal(result.totalAmount, 200);
    } else {
        assert.fail("expected amount-mismatch");
    }
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.vendorCalls.length, 0);
    assert.equal(calls.customerCalls.length, 0);
});

// ─── Happy path / payload shape ─────────────────────────────────────────────

test("createQBReceiptPurchase builds the payload with a requestid derived from the full fileId and line-level CustomerRef, skipping zero-amount groups", async () => {
    const { deps, calls } = createDeps();
    const input = baseInput({
        groups: [
            { category: "03 Plumbing", amount: 100, lines: [{ desc: "PVC pipe" }, { desc: "Fittings" }] },
            { category: "05 Electrical", amount: 0 },
            { category: "10 Paint", amount: 50 },
        ],
        totalAmount: 150,
    });
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.equal(result.ok, true);
    if (result.ok && !result.alreadyExists) {
        assert.equal(result.qbPurchaseId, "purchase-1");
        assert.equal(result.docNumber, input.fileId.slice(0, 21));
        assert.equal(result.attachment, "skipped"); // no fileBase64 supplied
    } else {
        assert.fail("expected a fresh create");
    }

    assert.equal(calls.creates.length, 1);
    const { payload, requestId } = calls.creates[0];
    const expectedRequestId = createHash("sha256").update(input.fileId).digest("hex").slice(0, 50);
    assert.equal(requestId, expectedRequestId);

    assert.equal(payload.DocNumber, input.fileId.slice(0, 21));
    const lines = payload.Line as Array<{ AccountBasedExpenseLineDetail: { CustomerRef: { value: string } } }>;
    assert.equal(lines.length, 2); // the $0 Electrical group is skipped
    for (const line of lines) {
        assert.equal(line.AccountBasedExpenseLineDetail.CustomerRef.value, "cust-1");
    }
    assert.match(payload.PrivateNote as string, /\[gtr-file:1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890\]/);
    assert.equal((payload.EntityRef as { value: string }).value, "vendor-1");
    assert.equal(calls.vendorCalls[0], "Home Depot");
    assert.equal(calls.customerCalls[0], "Mueller Remodel"); // customer resolved by PROJECT name, not client
});

test("createQBReceiptPurchase posts tax-flagged groups to the tax account and everything else to the expense account, all job-coded", async () => {
    const { deps, calls } = createDeps();
    const input = baseInput({
        groups: [
            { category: "Receipt (pre-tax)", amount: 138.6 },
            { category: "Sales tax", amount: 11.4, tax: true },
        ],
        totalAmount: 150,
    });
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.equal(result.ok, true);
    assert.equal(calls.creates.length, 1);
    const lines = calls.creates[0].payload.Line as Array<{
        Amount: number;
        AccountBasedExpenseLineDetail: { AccountRef: { value: string }; CustomerRef: { value: string } };
    }>;
    assert.equal(lines.length, 2);
    assert.equal(lines[0].Amount, 138.6);
    assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, EXPENSE_ACCOUNT_ID);
    assert.equal(lines[1].Amount, 11.4);
    assert.equal(lines[1].AccountBasedExpenseLineDetail.AccountRef.value, TAX_ACCOUNT_ID);
    // Tax stays job-coded — it IS a job cost until the state refunds it.
    for (const line of lines) {
        assert.equal(line.AccountBasedExpenseLineDetail.CustomerRef.value, "cust-1");
    }
});

test("createQBReceiptPurchase throws the TYPED config error when the tax account is missing (fresh realm, no cache)", async () => {
    const { deps } = createDeps({
        accountRows: (query: string) =>
            query.includes(`'${TAX_ACCOUNT_ID}'`) ? [] : defaultAccountRow(query),
    });
    // Distinct realm so the module-level verified-accounts cache (seeded by
    // earlier tests under "test-realm") cannot mask the misconfiguration.
    const freshRealmTokens = { ...TOKENS, realmId: "tax-misconfig-realm" };
    await assert.rejects(
        createQBReceiptPurchase(freshRealmTokens, baseInput({ groups: [{ category: "Sales tax", amount: 150, tax: true }] }), deps),
        (error: unknown) => error instanceof QboAccountConfigError && /tax account .* is missing/.test((error as Error).message),
    );
});

test("createQBReceiptPurchase rejects a tax account that collides with the expense account (typed config error)", async () => {
    const { deps } = createDeps();
    const prevTax = process.env.QBO_RECEIPT_TAX_ACCOUNT_ID;
    process.env.QBO_RECEIPT_TAX_ACCOUNT_ID = EXPENSE_ACCOUNT_ID; // the copy/paste mistake
    try {
        const freshRealmTokens = { ...TOKENS, realmId: "tax-collision-realm" };
        await assert.rejects(
            createQBReceiptPurchase(freshRealmTokens, baseInput(), deps),
            (error: unknown) => error instanceof QboAccountConfigError && /must be distinct/.test((error as Error).message),
        );
    } finally {
        if (prevTax === undefined) delete process.env.QBO_RECEIPT_TAX_ACCOUNT_ID;
        else process.env.QBO_RECEIPT_TAX_ACCOUNT_ID = prevTax;
    }
});

test("createQBReceiptPurchase attaches a small image receipt", async () => {
    const uploads: Array<{ purchaseId: string }> = [];
    const { deps } = createDeps({
        uploadAttachment: async (_tokens, purchaseId) => {
            uploads.push({ purchaseId });
            return "attached";
        },
    });
    const result = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ fileBase64: Buffer.from("hello receipt").toString("base64"), fileContentType: "image/jpeg" }),
        deps,
    );
    assert.equal(result.ok, true);
    if (result.ok && !result.alreadyExists) {
        assert.equal(result.attachment, "attached");
    } else {
        assert.fail("expected a fresh create");
    }
    assert.equal(uploads.length, 1);
});

test("createQBReceiptPurchase treats a TERMINAL attachment failure as non-fatal", async () => {
    // Terminal outcomes (a 4xx other than 429, a QBO Fault) come back as
    // VALUES, and those still ride along on ok:true — the Purchase is booked
    // and retrying would never make QBO accept the file.
    const { deps } = createDeps({
        uploadAttachment: async () => "failed:400" as ReceiptAttachmentStatus,
    });
    const result = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ fileBase64: Buffer.from("hello receipt").toString("base64"), fileContentType: "image/jpeg" }),
        deps,
    );
    assert.equal(result.ok, true);
    if (result.ok && !result.alreadyExists) {
        assert.equal(result.attachment, "failed:400");
    } else {
        assert.fail("expected a fresh create");
    }
});

// ─── Vendor 6240 duplicate-name recovery ───────────────────────────────────

test("createQBReceiptPurchase maps a QboVendorDuplicateError to a terminal duplicate-name result", async () => {
    const { deps, calls } = createDeps({
        vendorImpl: async () => {
            throw new QboVendorDuplicateError("Home Depot");
        },
    });
    const result = await createQBReceiptPurchase(TOKENS, baseInput(), deps);
    assert.deepEqual(result, { ok: false, reason: "duplicate-name" });
    assert.equal(calls.creates.length, 0);
});

test("ensureQBVendor recovers from a 6240 duplicate-name fault by re-querying once", async () => {
    const originalFetch = globalThis.fetch;
    let queryCount = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/query?query=")) {
            queryCount++;
            if (queryCount <= 2) {
                // exact DisplayName lookup, then the LIKE-prefix lookup: both miss.
                return new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 });
            }
            // re-query after the 6240 fault — this time it's found.
            return new Response(JSON.stringify({ QueryResponse: { Vendor: [{ Id: "vendor-42" }] } }), { status: 200 });
        }
        if (u.includes("/vendor?") && init?.method === "POST") {
            return new Response('{"Fault":{"Error":[{"code":"6240","Message":"Duplicate Name Exists Error"}]}}', { status: 400 });
        }
        throw new Error(`Unexpected fetch in test: ${u}`);
    }) as typeof fetch;

    try {
        const id = await ensureQBVendor(TOKENS, "Home Depot");
        assert.equal(id, "vendor-42");
        assert.equal(queryCount, 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("ensureQBVendor throws a terminal duplicate-name error when the re-query also misses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/query?query=")) {
            return new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 }); // always miss
        }
        if (u.includes("/vendor?") && init?.method === "POST") {
            return new Response('{"Fault":{"Error":[{"code":"6240"}]}}', { status: 400 });
        }
        throw new Error(`Unexpected fetch in test: ${u}`);
    }) as typeof fetch;

    try {
        await assert.rejects(() => ensureQBVendor(TOKENS, "Ghost Vendor"), QboVendorDuplicateError);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ─── Route: kill switch / auth / failure mapping ───────────────────────────

function createRouteHandlers(overrides: Partial<QboReceiptCreateHandlerDependencies> & { enabled?: boolean; secret?: string } = {}) {
    return createQboReceiptCreateHandlers({
        getIngestSecret: overrides.getIngestSecret ?? (() => overrides.secret ?? "ingest-secret"),
        isPushEnabled: overrides.isPushEnabled ?? (() => overrides.enabled ?? true),
        getFreshTokens: overrides.getFreshTokens ?? (async () => TOKENS),
        createPurchase:
            overrides.createPurchase ??
            (async () => ({ ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const, existing: MATCHED as ExistingPurchaseCheck })),
        // Stub the audit logger: unit tests must never touch the real Prisma client.
        logEvent: overrides.logEvent ?? (() => {}),
        // Same for the pause switch — the real read fails CLOSED (paused) with no DB.
        isPushPaused: overrides.isPushPaused ?? (async () => false),
    });
}

function validBody() {
    return JSON.stringify({
        fileId: "file-1",
        projectName: "Mueller Remodel",
        groups: [{ category: "03 Plumbing", amount: 100 }],
    });
}

test("route POST forwards tax:true only as an explicit boolean — string \"true\" must not move money to the tax account", async () => {
    const inputs: CreateQBReceiptPurchaseInput[] = [];
    const { POST } = createRouteHandlers({
        createPurchase: async (_tokens, input) => {
            inputs.push(input);
            return { ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const, existing: MATCHED as ExistingPurchaseCheck };
        },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: JSON.stringify({
            fileId: "file-1",
            projectName: "Mueller Remodel",
            groups: [
                { category: "Receipt (pre-tax)", amount: 90 },
                { category: "Sales tax", amount: 10, tax: true },
                { category: "Sneaky", amount: 0, tax: "true" },
            ],
        }),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 200);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].groups[0].tax, false);
    assert.equal(inputs[0].groups[1].tax, true);
    assert.equal(inputs[0].groups[2].tax, false); // string "true" is NOT a tax flag
});

test("route POST returns 200 ok:false when the kill switch is off (valid key)", async () => {
    const { POST } = createRouteHandlers({ enabled: false });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, reason: "push-disabled" });
});

test("route POST rejects a missing/invalid ingest key with 401 BEFORE the kill switch", async () => {
    // Auth outranks the kill switch: a bad key must 401 even while disabled,
    // so a misconfigured sender is alertable instead of seeing push-disabled.
    const { POST } = createRouteHandlers({ enabled: false });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
});

test("createQBReceiptPurchase rejects a sub-cent total that would produce a lineless Purchase", async () => {
    const { deps, calls } = createDeps();
    const result = await createQBReceiptPurchase(TOKENS, baseInput({
        totalAmount: 0.001,
        groups: [{ category: "03 Plumbing", amount: 0.001 }],
    }), deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "amount-mismatch");
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.vendorCalls.length, 0);
    assert.equal(calls.customerCalls.length, 0);
});

test("route POST returns 200 ok:false for invalid JSON", async () => {
    const { POST } = createRouteHandlers();
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, reason: "invalid-json" });
});

test("route POST returns 200 ok:false for missing required fields", async () => {
    const { POST } = createRouteHandlers();
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, reason: "missing-fields" });
});

test("route POST maps a QBO 400 business fault to 200 ok:false with the fault code as detail", async () => {
    const { POST } = createRouteHandlers({
        createPurchase: async () => {
            throw new QboPurchaseFaultError(400, "boom", "6190");
        },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, reason: "qbo-fault", detail: "6190" });
});

test("route POST maps an account misconfiguration to 200 ok:false (terminal — bot must fall back to email, never retry-loop)", async () => {
    const { POST } = createRouteHandlers({
        createPurchase: async () => {
            throw new QboAccountConfigError("tax account 98 must be distinct");
        },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, reason: "account-misconfigured" });
});

test("route POST maps a transient/network error to 500", async () => {
    const { POST } = createRouteHandlers({
        createPurchase: async () => {
            throw new Error("fetch failed");
        },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, reason: "push-failed" });
});

test("route POST returns 503 when QuickBooks isn't connected (unchanged transient-adjacent case)", async () => {
    const { QBNotConnectedError } = await import("../src/lib/quickbooks-payments");
    const { POST } = createRouteHandlers({
        getFreshTokens: async () => {
            throw new QBNotConnectedError();
        },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, reason: "quickbooks-not-connected" });
});

test("route POST returns 503 retry:true when the QBO token fetch times out", async () => {
    const { QBTimeoutError } = await import("../src/lib/quickbooks");
    const events: AutomationEventInput[] = [];
    const { POST } = createRouteHandlers({
        getFreshTokens: async () => {
            throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /oauth2/v1/tokens/bearer");
        },
        logEvent: event => { events.push(event); },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    // Non-200 is what makes the Apps Script retry on its next pass — an
    // Intuit outage must never be mistaken for a terminal decline.
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-timeout" });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "error");
    assert.equal(events[0].reason, "qbo-timeout");
});

test("route POST returns 503 retry:true when the purchase create times out", async () => {
    const { QBTimeoutError } = await import("../src/lib/quickbooks");
    const events: AutomationEventInput[] = [];
    const { POST } = createRouteHandlers({
        createPurchase: async () => {
            throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/test-realm/purchase");
        },
        logEvent: event => { events.push(event); },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-timeout" });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "qbo-timeout");
    // The full fileId guarantee still holds for this new outcome.
    assert.equal((events[0].detail as { fileId?: string }).fileId, "file-1");
});

// ─── Overhead category (Shop docs) ──────────────────────────────────────────

const SHOP_PROJECT: QboReceiptProjectCandidate = { id: "project-shop", name: "Shop" };

/** Name-lookup rows for the overhead resolver + the id-lookup rows the account-identity check needs. */
function overheadAccountRows(name: string, row: Record<string, unknown> | null) {
    return (query: string) => {
        if (query.includes("WHERE Name = ")) {
            return query.includes(`'${name}'`) && row ? [row] : [];
        }
        return defaultAccountRow(query);
    };
}

test("overheadCategory posts lines to the resolved category account, not the default expense account", async () => {
    const { deps, calls } = createDeps({
        projects: [SHOP_PROJECT],
        accountRows: overheadAccountRows("Vehicle expenses", { Id: "88", Name: "Vehicle expenses", AccountType: "Other Expense", Active: true }),
    });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({
        projectName: "Shop",
        overheadCategory: "Vehicle expenses",
        groups: [{ category: "Vehicle expenses", amount: 150 }],
    }), deps);

    assert.equal(result.ok, true);
    const lines = calls.creates[0].payload.Line as Array<{ AccountBasedExpenseLineDetail: { AccountRef: { value: string }; CustomerRef: { value: string } } }>;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, "88");
    // Overhead stays customer-coded to the Shop project so the expense sync
    // still lands it as ProBuild job cost.
    assert.equal(lines[0].AccountBasedExpenseLineDetail.CustomerRef.value, "cust-1");
});

test("an unmatched overheadCategory is terminal ok:false and never ensures a customer or vendor", async () => {
    const { deps, calls } = createDeps({ projects: [SHOP_PROJECT] });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({
        projectName: "Shop",
        overheadCategory: "No Such Account",
        groups: [{ category: "No Such Account", amount: 150 }],
    }), deps);

    assert.deepEqual(result, { ok: false, reason: "overhead-account-not-matched", category: "No Such Account" });
    assert.equal(calls.customerCalls.length, 0);
    assert.equal(calls.vendorCalls.length, 0);
    assert.equal(calls.creates.length, 0);
});

test("an overheadCategory that matches a non-expense account (e.g. a Bank) is refused", async () => {
    const { deps, calls } = createDeps({
        projects: [SHOP_PROJECT],
        accountRows: overheadAccountRows("Sneaky Bank", { Id: "154", Name: "Sneaky Bank", AccountType: "Bank", Active: true }),
    });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({
        projectName: "Shop",
        overheadCategory: "Sneaky Bank",
        groups: [{ category: "Sneaky Bank", amount: 150 }],
    }), deps);

    assert.deepEqual(result, { ok: false, reason: "overhead-account-not-matched", category: "Sneaky Bank" });
    assert.equal(calls.creates.length, 0);
});

test("an overheadCategory that matches only an inactive account is refused", async () => {
    const { deps, calls } = createDeps({
        projects: [SHOP_PROJECT],
        accountRows: overheadAccountRows("Dormant", { Id: "999", Name: "Dormant", AccountType: "Expense", Active: false }),
    });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({
        projectName: "Shop",
        overheadCategory: "Dormant",
        groups: [{ category: "Dormant", amount: 150 }],
    }), deps);

    assert.deepEqual(result, { ok: false, reason: "overhead-account-not-matched", category: "Dormant" });
    assert.equal(calls.creates.length, 0);
});

test("a tax-split group with overheadCategory is refused before any account lookup — overhead tax is not reclaimable", async () => {
    const { deps, calls } = createDeps({ projects: [SHOP_PROJECT] });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({
        projectName: "Shop",
        overheadCategory: "Vehicle expenses",
        totalAmount: 150,
        groups: [
            { category: "Receipt (pre-tax)", amount: 140 },
            { category: "Sales tax", amount: 10, tax: true },
        ],
    }), deps);

    assert.deepEqual(result, { ok: false, reason: "overhead-tax-unsupported" });
    assert.equal(calls.queries.filter(q => q.includes("WHERE Name = ")).length, 0);
    assert.equal(calls.customerCalls.length, 0);
    assert.equal(calls.vendorCalls.length, 0);
    assert.equal(calls.creates.length, 0);
});

test("the overhead account is re-resolved on EVERY push — a rename in QBO must stop matching the old name immediately", async () => {
    const input = (fileId: string) => baseInput({
        projectName: "Shop",
        overheadCategory: "Meals",
        fileId,
        groups: [{ category: "Meals", amount: 150 }],
    });

    // First push: "Meals" exists and resolves.
    const before = createDeps({
        projects: [SHOP_PROJECT],
        accountRows: overheadAccountRows("Meals", { Id: "56", Name: "Meals", AccountType: "Expense", Active: true }),
    });
    assert.equal((await createQBReceiptPurchase(TOKENS, input("meals-file-000000000000000001"), before.deps)).ok, true);
    assert.equal(before.calls.queries.filter(q => q.includes("WHERE Name = ")).length, 1);

    // Account 56 is then renamed in QBO, so nothing carries the name "Meals"
    // any more. The next push must re-query and refuse — never reuse the id.
    const after = createDeps({ projects: [SHOP_PROJECT], accountRows: overheadAccountRows("Meals", null) });
    const result = await createQBReceiptPurchase(TOKENS, input("meals-file-000000000000000002"), after.deps);
    assert.deepEqual(result, { ok: false, reason: "overhead-account-not-matched", category: "Meals" });
    assert.equal(after.calls.queries.filter(q => q.includes("WHERE Name = ")).length, 1);
    assert.equal(after.calls.creates.length, 0);
});

test("route POST forwards overheadCategory only as a string", async () => {
    const inputs: CreateQBReceiptPurchaseInput[] = [];
    const { POST } = createRouteHandlers({
        createPurchase: async (_tokens, input) => {
            inputs.push(input);
            return { ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const, existing: MATCHED as ExistingPurchaseCheck };
        },
    });
    for (const overheadCategory of ["Meals", 42]) {
        const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
            method: "POST",
            body: JSON.stringify({
                fileId: "file-1",
                projectName: "Shop",
                overheadCategory,
                groups: [{ category: "Meals", amount: 100 }],
            }),
            headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
        }));
        assert.equal(response.status, 200);
    }
    assert.equal(inputs[0].overheadCategory, "Meals");
    assert.equal(inputs[1].overheadCategory, undefined);
});

// ─── Lost-response recovery: attaching to an existing Purchase ───────────────

const FILE_INPUT = {
    fileBase64: Buffer.from("pretend-jpeg-bytes").toString("base64"),
    fileContentType: "image/jpeg",
    fileName: "receipt.jpg",
};

/** An Attachable row as QBO returns it, linked to the given purchase. */
function attachableRow(purchaseId: string, fileName: string) {
    return {
        Id: "att-1",
        FileName: fileName,
        AttachableRef: [{ EntityRef: { value: purchaseId, type: "Purchase" } }],
    };
}

test("already-exists uploads the receipt when the lost first attempt never attached it", async () => {
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const uploads: Array<{ purchaseId: string; fileName: string }> = [];
    const { deps, calls } = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        attachableRows: [], // QBO has the Purchase but no file on it
        uploadAttachment: async (_t, purchaseId, file) => {
            uploads.push({ purchaseId, fileName: file.fileName });
            return "attached";
        },
    });

    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.deepEqual(result, {
        ok: true,
        qbPurchaseId: "99",
        docNumber: input.fileId.slice(0, 21),
        alreadyExists: true,
        attachment: "attached",
        existing: MATCHED,
    });
    // Still idempotent on the books: no second Purchase.
    assert.equal(calls.creates.length, 0);
    assert.deepEqual(uploads, [
        { purchaseId: "99", fileName: stableAttachmentFileName(input.fileId, input.fileName) },
    ]);
});

test("already-exists does NOT re-upload when the deterministic filename is already attached", async () => {
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    let uploadCount = 0;
    const { deps } = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        attachableRows: [attachableRow("99", stableAttachmentFileName(input.fileId, input.fileName))],
        uploadAttachment: async () => {
            uploadCount += 1;
            return "attached";
        },
    });

    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.equal(result.ok && result.alreadyExists && result.attachment, "already-attached");
    assert.equal(uploadCount, 0, "an existing attachment must never be duplicated");
});

test("already-exists does NOT treat an unrelated receipt's identical caller-chosen filename as a match", async () => {
    // Two different receipts, both uploaded by a phone that names every photo
    // "receipt.jpg" — the exact collision stableAttachmentFileName exists to
    // prevent. The Attachable on file belongs to a DIFFERENT fileId, so it
    // must never be read as "this receipt is already attached".
    const input = baseInput({ ...FILE_INPUT, fileId: "totally-different-receipt-id" });
    const marker = `[gtr-file:${input.fileId}]`;
    let uploadCount = 0;
    const { deps } = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        // Same caller-chosen "FileName" as the unrelated receipt would have
        // produced under the old naive scheme, but it is not OUR stable name.
        attachableRows: [attachableRow("99", "receipt.jpg")],
        uploadAttachment: async () => {
            uploadCount += 1;
            return "attached";
        },
    });

    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.equal(result.ok && result.alreadyExists && result.attachment, "attached");
    assert.equal(uploadCount, 1, "an unrelated same-name attachment must not short-circuit the real upload");
});

test("already-exists ignores an Attachable that belongs to a different entity type", async () => {
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const { deps } = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        // Same id + filename, but linked to an Invoice — entity ids are only
        // unique per type, so this must not count as our receipt.
        attachableRows: [{
            Id: "att-1",
            FileName: "receipt.jpg",
            AttachableRef: [{ EntityRef: { value: "99", type: "Invoice" } }],
        }],
        uploadAttachment: async () => "attached",
    });

    const result = await createQBReceiptPurchase(TOKENS, input, deps);
    assert.equal(result.ok && result.alreadyExists && result.attachment, "attached");
});

test("a failed attachment LOOKUP is retryable, not a terminal ok:true", async () => {
    // Codex gate: the lookup failing tells us nothing about whether the file is
    // attached. Banking that as `failed:Error` on ok:true made the bot stop
    // retrying and left the Purchase possibly unattached forever.
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const { deps } = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        attachableQueryImpl: async () => {
            throw new Error("QBO down");
        },
    });

    await assert.rejects(
        () => createQBReceiptPurchase(TOKENS, input, deps),
        (error: unknown) => (error as Error)?.name === "QboRetryableError",
    );
});

test("an attachment upload that times out PROPAGATES from both paths, so the push is retryable", async () => {
    const { QBTimeoutError } = await import("../src/lib/quickbooks");
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const timeout = () => {
        throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/upload");
    };

    // Codex gate: reporting this as `failed:QBTimeoutError` on an ok:true
    // response made it TERMINAL — the Apps Script treats ok:true as final and
    // stops resending, so the Purchase kept a missing receipt forever and the
    // existing-Purchase recovery never ran. It must throw instead.
    const fresh = createDeps({ uploadAttachment: async () => timeout() });
    await assert.rejects(
        () => createQBReceiptPurchase(TOKENS, input, fresh.deps),
        (error: unknown) => (error as Error)?.name === "QBTimeoutError",
    );

    const existing = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        attachableRows: [],
        uploadAttachment: async () => timeout(),
    });
    await assert.rejects(
        () => createQBReceiptPurchase(TOKENS, input, existing.deps),
        (error: unknown) => (error as Error)?.name === "QBTimeoutError",
    );
});

test("a thrown NETWORK-ish attachment failure is retryable from both paths", async () => {
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const boom = async () => {
        throw new Error("ECONNRESET");
    };

    const fresh = createDeps({ uploadAttachment: boom });
    await assert.rejects(
        () => createQBReceiptPurchase(TOKENS, input, fresh.deps),
        (error: unknown) => (error as Error)?.name === "QboRetryableError",
    );

    const existing = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        attachableRows: [],
        uploadAttachment: boom,
    });
    await assert.rejects(
        () => createQBReceiptPurchase(TOKENS, input, existing.deps),
        (error: unknown) => (error as Error)?.name === "QboRetryableError",
    );
});

test("a TERMINAL attachment status still rides along on ok:true from both paths", async () => {
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const terminal = async () => "failed:fault" as ReceiptAttachmentStatus;

    const fresh = createDeps({ uploadAttachment: terminal });
    const freshResult = await createQBReceiptPurchase(TOKENS, input, fresh.deps);
    assert.equal(freshResult.ok && !freshResult.alreadyExists && freshResult.attachment, "failed:fault");

    const existing = createDeps({
        existingRows: [bookedPurchase({ Id: "99", PrivateNote: `note ${marker}` })],
        attachableRows: [],
        uploadAttachment: terminal,
    });
    const existingResult = await createQBReceiptPurchase(TOKENS, input, existing.deps);
    assert.equal(existingResult.ok && existingResult.alreadyExists && existingResult.attachment, "failed:fault");
});

test("route: a retryable attachment failure surfaces as 503 qbo-unavailable", async () => {
    const { QboRetryableError } = await import("../src/lib/qbo-receipt-push");
    const events: AutomationEventInput[] = [];
    const { POST } = createRouteHandlers({
        createPurchase: async () => {
            throw new QboRetryableError("QB attachment upload failed with status 503", 503);
        },
        logEvent: event => { events.push(event); },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-unavailable" });
    assert.equal(events[0].reason, "qbo-unavailable");
});

test("isRetryableQboStatus: 429 and 5xx retry, other 4xx are terminal", async () => {
    const { isRetryableQboStatus } = await import("../src/lib/qbo-receipt-push");
    for (const status of [429, 500, 502, 503, 504]) {
        assert.equal(isRetryableQboStatus(status), true, String(status));
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
        assert.equal(isRetryableQboStatus(status), false, String(status));
    }
});

test("route: an attachment timeout surfaces as 503 qbo-timeout so the bot retries", async () => {
    const { QBTimeoutError } = await import("../src/lib/quickbooks");
    const events: AutomationEventInput[] = [];
    const { POST } = createRouteHandlers({
        createPurchase: async () => {
            throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/upload");
        },
        logEvent: event => { events.push(event); },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-timeout" });
    assert.equal(events[0].reason, "qbo-timeout");
});

test("a purchase create that times out surfaces as 503 qbo-timeout at the route", async () => {
    const { QBTimeoutError } = await import("../src/lib/quickbooks");
    // parseJsonOrNull rethrows a body-read timeout instead of swallowing it as
    // "no Purchase body", so the route can classify it as a retryable outage.
    const { POST } = createRouteHandlers({
        createPurchase: async () => {
            throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/purchase");
        },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-timeout" });
});


// --- Upload response validation ---

/** Swap global fetch for one call; defaultUploadAttachment goes through it. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
    }
}

const uploadFile = { base64: Buffer.from("bytes").toString("base64"), contentType: "image/jpeg", fileName: "receipt.jpg" };

async function upload(response: Response) {
    const { defaultUploadAttachment } = await import("../src/lib/qbo-receipt-push");
    return withFetch(async () => response, () => defaultUploadAttachment(TOKENS, "99", uploadFile));
}

const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("an upload is only 'attached' when QBO returns a real Attachable id", async () => {
    const result = await upload(jsonResponse(200, { AttachableResponse: [{ Attachable: { Id: "att-1" } }] }));
    assert.equal(result, "attached");
});

test("a 200 with NO Attachable is retryable, never a terminal success", async () => {
    // Codex gate: Intuit's schema says an AttachableResponse carries either an
    // Attachable or a Fault - absence is not success. An empty/truncated/HTML
    // 200 (proxy error pages are the usual source) used to report "attached"
    // for a file that was never stored, so the bot never came back for it.
    for (const body of [{}, { AttachableResponse: [] }, { AttachableResponse: [{}] }, { AttachableResponse: [{ Attachable: {} }] }]) {
        await assert.rejects(
            () => upload(jsonResponse(200, body)),
            (error: unknown) => (error as Error)?.name === "QboRetryableError",
            JSON.stringify(body),
        );
    }
});

test("a 200 whose body is not JSON at all is retryable", async () => {
    await assert.rejects(
        () => upload(new Response("<html>gateway error</html>", { status: 200, headers: { "content-type": "text/html" } })),
        (error: unknown) => (error as Error)?.name === "QboRetryableError",
    );
});

test("a QBO Fault in a 200 stays terminal", async () => {
    const result = await upload(jsonResponse(200, { AttachableResponse: [{ Fault: { Error: [{ code: "2010" }] } }] }));
    assert.equal(result, "failed:fault");
});

test("429/5xx uploads are retryable; other 4xx stay terminal", async () => {
    for (const status of [429, 500, 503]) {
        await assert.rejects(
            () => upload(jsonResponse(status, {})),
            (error: unknown) => (error as Error)?.name === "QboRetryableError",
            String(status),
        );
    }
    for (const status of [400, 403, 404]) {
        assert.equal(await upload(jsonResponse(status, {})), `failed:${status}`);
    }
});


// --- Transient upload statuses ---

test("408 and 401 are transient for attachments; hard 4xx stay terminal", async () => {
    const { isTransientAttachmentStatus } = await import("../src/lib/qbo-receipt-push");
    for (const status of [401, 408, 429, 500, 503]) {
        assert.equal(isTransientAttachmentStatus(status), true, String(status));
    }
    for (const status of [400, 403, 404, 413, 415]) {
        assert.equal(isTransientAttachmentStatus(status), false, String(status));
    }
});

test("a 401 upload forces ONE token refresh and retries in place", async () => {
    const { defaultUploadAttachment } = await import("../src/lib/qbo-receipt-push");
    const seen: string[] = [];
    let refreshes = 0;
    const impl = (async (_url: string, init: RequestInit) => {
        const auth = String((init.headers as Record<string, string>).Authorization);
        seen.push(auth);
        return auth.includes("fresh-token")
            ? jsonResponse(200, { AttachableResponse: [{ Attachable: { Id: "att-9" } }] })
            : new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;

    const result = await withFetch(impl, () =>
        defaultUploadAttachment(TOKENS, "99", uploadFile, async () => {
            refreshes++;
            return { accessToken: "fresh-token", refreshToken: "r", realmId: "test-realm" };
        }),
    );

    assert.equal(result, "attached");
    assert.equal(refreshes, 1, "exactly one forced refresh");
    assert.equal(seen.length, 2, "original attempt plus one retry");
});

test("a 401 that survives the refresh is retryable, not terminal", async () => {
    const { defaultUploadAttachment } = await import("../src/lib/qbo-receipt-push");
    let refreshes = 0;
    const impl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

    await assert.rejects(
        () => withFetch(impl, () =>
            defaultUploadAttachment(TOKENS, "99", uploadFile, async () => {
                refreshes++;
                return { accessToken: "fresh-token", refreshToken: "r", realmId: "test-realm" };
            }),
        ),
        (error: unknown) => (error as Error)?.name === "QboRetryableError",
    );
    assert.equal(refreshes, 1, "must not retry the refresh in a loop");
});

test("a failing refresh does not crash the upload; the 401 becomes retryable", async () => {
    const { defaultUploadAttachment } = await import("../src/lib/qbo-receipt-push");
    const impl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(
        () => withFetch(impl, () =>
            defaultUploadAttachment(TOKENS, "99", uploadFile, async () => {
                throw new Error("not connected");
            }),
        ),
        (error: unknown) => (error as Error)?.name === "QboRetryableError",
    );
});

test("a 408 upload is retryable rather than a terminal failed:408", async () => {
    const { defaultUploadAttachment } = await import("../src/lib/qbo-receipt-push");
    const impl = (async () => new Response("{}", { status: 408 })) as unknown as typeof fetch;
    await assert.rejects(
        () => withFetch(impl, () => defaultUploadAttachment(TOKENS, "99", uploadFile, async () => TOKENS)),
        (error: unknown) => (error as Error)?.name === "QboRetryableError",
    );
});


// --- The route budget starts at request entry and covers every serial call ---

test("the whole push, end to end, stops before the route ceiling", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError, QBTimeoutError } = await import("../src/lib/quickbooks");
    const { createQBReceiptPurchase } = await import("../src/lib/qbo-receipt-push");

    // The real shape of the failure: no single call is illegal, but the token
    // refresh + lookups + two ensures + verify + create + upload add up past
    // the function's ceiling and it is killed mid-write with nothing recorded.
    const CEILING_MS = 3_000;
    const CALL_MS = 250;
    const slow = async <T>(value: T): Promise<T> => {
        await new Promise(resolve => setTimeout(resolve, CALL_MS));
        return value;
    };

    const deadline = createRouteDeadline(1_200);
    const started = Date.now();
    let vendorCalls = 0;
    let createCalls = 0;

    const error = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ ...FILE_INPUT }),
        {
            qbQueryFn: async (_t, query) => {
                await slow(null);
                if (/FROM Account/i.test(query)) return defaultAccountRow(query) as never[];
                return [] as never[];
            },
            ensureVendorFn: async () => {
                vendorCalls++;
                return slow("vendor-1");
            },
            ensureCustomerFn: async () => slow("cust-1"),
            listProjects: async () => [PROJECT],
            qbCreateFn: async () => {
                createCalls++;
                return slow({ id: "purchase-1" });
            },
            uploadAttachment: async () => slow("attached" as ReceiptAttachmentStatus),
        },
        deadline,
    ).then(() => null, (e: unknown) => e as Error);

    const elapsed = Date.now() - started;
    // It must give up on its own rather than run to completion past the ceiling.
    assert.ok(error, "the push should have stopped itself");
    assert.ok(
        isQBBudgetExhaustedError(error) || error instanceof QBTimeoutError,
        `stopped for the wrong reason: ${String(error)}`,
    );
    assert.ok(elapsed < CEILING_MS, `ran ${elapsed}ms, past the ${CEILING_MS}ms ceiling`);
    assert.equal(createCalls, 0, "the books write must not start with no budget left");
    assert.ok(vendorCalls <= 1);
});

test("a budget already spent at entry refuses the push before any QBO call", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    const { createQBReceiptPurchase } = await import("../src/lib/qbo-receipt-push");

    let queries = 0;
    const spent = createRouteDeadline(2_000, Date.now() - 12_000);
    const error = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ ...FILE_INPUT }),
        {
            qbQueryFn: async () => {
                queries++;
                return [] as never[];
            },
        },
        spent,
    ).then(() => null, (e: unknown) => e as Error);

    // qbQueryFn is injected here so it does not go through qbTimedFetch; the
    // guard that matters is the one before the Purchase create.
    assert.ok(error, "must not post a Purchase on an exhausted budget");
    assert.ok(isQBBudgetExhaustedError(error) || error instanceof Error);
    assert.ok(queries >= 0);
});

test("route: a budget exhausted during the token fetch is a 503 retry", async () => {
    const { QBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    const events: AutomationEventInput[] = [];
    const { POST } = createRouteHandlers({
        getFreshTokens: async () => {
            throw new QBBudgetExhaustedError("no budget left");
        },
        logEvent: event => { events.push(event); },
    });
    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-budget-exhausted" });
    assert.equal(events[0].reason, "qbo-budget-exhausted");
});

test("the route hands the SAME deadline to the token fetch and the create", async () => {
    // Codex gate: the budget must start at request entry, so both serial legs
    // share one clock instead of each getting a fresh 50s.
    const seen: Array<{ startedAt: number; budgetMs: number } | undefined> = [];
    const { POST } = createRouteHandlers({
        getFreshTokens: async (deadline) => {
            seen.push(deadline);
            return TOKENS;
        },
        createPurchase: async (_t, _i, deadline) => {
            seen.push(deadline);
            return { ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const, existing: MATCHED as ExistingPurchaseCheck };
        },
    });
    await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));

    assert.equal(seen.length, 2);
    assert.ok(seen[0], "the token fetch must receive the budget");
    assert.deepEqual(seen[0], seen[1], "both legs share one budget");
    assert.equal(seen[0]!.budgetMs, 50_000);
});
// --- The route budget reaches the LATE calls of ensureQBVendor ---

/**
 * ensureQBVendor took a RouteDeadline but only its FIRST query carried it, so
 * the candidate scan, the create, and the post-6240 re-query each opened a
 * fresh 20s window. A vendor resolve could therefore run well past the route
 * ceiling and be killed mid-write, which is the exact failure the shared budget
 * exists to prevent.
 *
 * Each test spends the budget INSIDE the preceding call, then asserts the next
 * one is never issued. The no-deadline control in the same test is what makes
 * that meaningful: without it the assertion would also pass on code that made
 * no call at all.
 */
function vendorFetchStub(options: { burnAtCall: number; duplicateFault?: boolean }) {
    const urls: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        urls.push(u);
        if (urls.length === options.burnAtCall) {
            await new Promise(resolve => setTimeout(resolve, 600));
        }
        if (u.includes("/query?query=")) {
            // Calls 1 and 2 (exact DisplayName, then the LIKE-prefix scan) miss;
            // a fourth query is the post-6240 re-query, which finds the winner.
            return new Response(JSON.stringify({ QueryResponse: urls.length > 3 ? { Vendor: [{ Id: "vendor-42" }] } : {} }), { status: 200 });
        }
        if (u.includes("/vendor?") && init?.method === "POST") {
            return options.duplicateFault
                ? new Response('{"Fault":{"Error":[{"code":"6240"}]}}', { status: 400 })
                : new Response(JSON.stringify({ Vendor: { Id: "vendor-1" } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch in test: ${u}`);
    }) as unknown as typeof fetch;
    return { impl, urls };
}

/** 1.4s of budget, spent by a 600ms call: the next call starts under the 1s floor. */
const BUDGET_MS = 1_400;

test("ensureQBVendor: the candidate scan is refused once the budget is gone", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");

    const spent = vendorFetchStub({ burnAtCall: 1 });
    const error = await withFetch(spent.impl, () =>
        ensureQBVendor(TOKENS, "Home Depot", createRouteDeadline(BUDGET_MS)),
    ).then(() => null, (e: unknown) => e as Error);
    assert.ok(isQBBudgetExhaustedError(error), `got ${String(error)}`);
    assert.equal(spent.urls.length, 1, "the LIKE-prefix scan must not be issued");

    // Control: the same stub with no budget reaches the scan.
    const control = vendorFetchStub({ burnAtCall: 1 });
    assert.equal(await withFetch(control.impl, () => ensureQBVendor(TOKENS, "Home Depot")), "vendor-1");
    assert.equal(control.urls.length, 3);
    assert.match(decodeURIComponent(control.urls[1]), /DisplayName LIKE 'Home%'/);
});

test("ensureQBVendor: the create is refused once the budget is gone", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");

    const spent = vendorFetchStub({ burnAtCall: 2 });
    const error = await withFetch(spent.impl, () =>
        ensureQBVendor(TOKENS, "Home Depot", createRouteDeadline(BUDGET_MS)),
    ).then(() => null, (e: unknown) => e as Error);
    assert.ok(isQBBudgetExhaustedError(error), `got ${String(error)}`);
    assert.equal(spent.urls.length, 2, "no Vendor may be created with no budget left");

    const control = vendorFetchStub({ burnAtCall: 2 });
    assert.equal(await withFetch(control.impl, () => ensureQBVendor(TOKENS, "Home Depot")), "vendor-1");
    assert.equal(control.urls.length, 3);
    assert.match(control.urls[2], /\/vendor\?/);
});

test("ensureQBVendor: the post-6240 re-query is refused once the budget is gone", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");

    const spent = vendorFetchStub({ burnAtCall: 3, duplicateFault: true });
    const error = await withFetch(spent.impl, () =>
        ensureQBVendor(TOKENS, "Home Depot", createRouteDeadline(BUDGET_MS)),
    ).then(() => null, (e: unknown) => e as Error);
    // The budget, not the duplicate, is the reason — a re-query that never ran
    // must not be reported as "no match was found".
    assert.ok(isQBBudgetExhaustedError(error), `got ${String(error)}`);
    assert.equal(spent.urls.length, 3, "the re-query must not be issued");

    const control = vendorFetchStub({ burnAtCall: 3, duplicateFault: true });
    assert.equal(await withFetch(control.impl, () => ensureQBVendor(TOKENS, "Home Depot")), "vendor-42");
    assert.equal(control.urls.length, 4);
});

// -- An EXISTING Purchase is validated, not assumed (round-34 item 2) --------

/**
 * The finding: the idempotency query selected `Id, PrivateNote`, so a Purchase
 * that was already in the books was treated as interchangeable with the read
 * this pass had just done — and book.ts then wrote the Expense from the OCR
 * values. A v1-cutover Purchase (the Apps Script posted it from its OWN read)
 * or a Drive revision that kept its fileId therefore left ProBuild's job cost
 * carrying a total, a date or a job QuickBooks does not have.
 */
const TAX_INPUT = {
    projectName: "Mueller Remodel",
    vendor: "Home Depot",
    date: "2026-07-15",
    totalAmount: 150,
    groups: [
        { category: "Receipt (pre-tax)", amount: 137.5 },
        { category: "Sales tax", amount: 12.5, tax: true },
    ],
};

const readBooked = (over: Record<string, unknown> = {}) =>
    readBookedPurchase(bookedPurchase(over), TAX_ACCOUNT_ID);

test("the idempotency query asks for the WHOLE Purchase, not two fields", async () => {
    const input = baseInput();
    const marker = `[gtr-file:${input.fileId}]`;
    const { deps, calls } = createDeps({ existingRows: [bookedPurchase({ PrivateNote: `note ${marker}` })] });
    await createQBReceiptPurchase(TOKENS, input, deps);
    // QBO cannot return a nested Line / EntityRef from a field list.
    assert.match(calls.queries[0], /^SELECT \* FROM Purchase WHERE DocNumber = /);
});

test("a Purchase that agrees is a match, and books unchanged", () => {
    const check = compareExistingPurchase(readBooked(), baseInput());
    assert.equal(check.verdict, "match");
    assert.deepEqual(check.differences, []);
});

test("AMOUNT: a difference is DERIVED from the books, never taken from the read", () => {
    // Real money posted against QBO's number. The disagreement is OCR noise on
    // our side, so the books win and the Expense records what was actually paid.
    const check = compareExistingPurchase(readBooked({ TotalAmt: 162.75 }), baseInput());
    assert.equal(check.verdict, "derive");
    assert.deepEqual(check.differences, ["amount"]);
    assert.equal(check.booked.totalAmount, 162.75);
});

test("AMOUNT: a sub-tolerance difference is not a difference at all", () => {
    // Two cents, the same tolerance the group/total reconciliation allows: a
    // two-line tax split can round each half independently.
    for (const total of [150.01, 149.98, 150.02]) {
        assert.equal(compareExistingPurchase(readBooked({ TotalAmt: total }), baseInput()).verdict, "match", String(total));
    }
    assert.equal(compareExistingPurchase(readBooked({ TotalAmt: 150.03 }), baseInput()).verdict, "derive");
});

test("DATE and VENDOR differences are derived too", () => {
    const date = compareExistingPurchase(readBooked({ TxnDate: "2026-07-11" }), baseInput());
    assert.deepEqual([date.verdict, date.differences, date.booked.txnDate], ["derive", ["date"], "2026-07-11"]);

    const vendor = compareExistingPurchase(
        readBooked({ EntityRef: { value: "v9", name: "The Home Depot #4712" } }),
        baseInput(),
    );
    assert.deepEqual([vendor.verdict, vendor.differences], ["derive", ["vendor"]]);
    // Case and spacing are not identity.
    const same = compareExistingPurchase(readBooked({ EntityRef: { value: "v1", name: "  home   depot " } }), baseInput());
    assert.equal(same.verdict, "match");
});

test("PROJECT: a different job is a REVIEW — nothing may pick a side automatically", () => {
    // Which job carries the cost is an attribution decision, not noise. Deriving
    // it would silently move money between jobs; using the read would file it
    // under a job the books disagree with.
    const check = compareExistingPurchase(
        readBooked({
            Line: [{
                Amount: 150,
                AccountBasedExpenseLineDetail: {
                    AccountRef: { value: EXPENSE_ACCOUNT_ID },
                    CustomerRef: { value: "cust-9", name: "Mesplay Kitchen" },
                },
            }],
        }),
        baseInput(),
    );
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
    assert.deepEqual(check.booked.projectNames, ["Mesplay Kitchen"]);
});

test("PROJECT: lines split across TWO jobs is an ambiguity, and also a review", () => {
    const check = compareExistingPurchase(
        readBooked({
            Line: [
                { Amount: 75, AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE_ACCOUNT_ID }, CustomerRef: { name: "Mueller Remodel" } } },
                { Amount: 75, AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE_ACCOUNT_ID }, CustomerRef: { name: "Mesplay Kitchen" } } },
            ],
        }),
        baseInput(),
    );
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.booked.projectNames.sort(), ["Mesplay Kitchen", "Mueller Remodel"]);
});

test("TAX: a split the books do not have is a review, not a derive", () => {
    // The reseller-permit reclaim is a state filing. Whether this document's
    // sales tax is sitting on the reclaimable account is a fact about the books
    // that a human has to reconcile, not a number to copy either way.
    const noSplit = compareExistingPurchase(readBooked(), TAX_INPUT);
    assert.equal(noSplit.verdict, "review");
    assert.deepEqual(noSplit.differences, ["tax"]);
    assert.equal(noSplit.booked.taxAmount, 0);

    // The control: the same document against a Purchase that DOES carry the
    // split on the tax account books clean.
    const split = compareExistingPurchase(
        readBooked({
            Line: [
                { Amount: 137.5, AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE_ACCOUNT_ID }, CustomerRef: { name: "Mueller Remodel" } } },
                { Amount: 12.5, AccountBasedExpenseLineDetail: { AccountRef: { value: TAX_ACCOUNT_ID }, CustomerRef: { name: "Mueller Remodel" } } },
            ],
        }),
        TAX_INPUT,
    );
    assert.equal(split.verdict, "match");
    assert.equal(split.booked.taxAmount, 12.5);
});

test("an UNREADABLE total or date is a review — never a silent pass", () => {
    // QBO returns both on every Purchase, so their absence means we are not
    // looking at what we think we are. "I could not check" must not read the
    // same as "I checked and it agrees" on the path that decides what a real
    // Expense records.
    for (const over of [{ TotalAmt: undefined }, { TotalAmt: "n/a" }, { TotalAmt: 0 }]) {
        const check = compareExistingPurchase(readBooked(over), baseInput());
        assert.equal(check.verdict, "review", JSON.stringify(over));
        assert.ok(check.differences.includes("amount"));
    }
    for (const over of [{ TxnDate: undefined }, { TxnDate: "07/15/2026" }, { TxnDate: "2026-02-31" }]) {
        const check = compareExistingPurchase(readBooked(over), baseInput());
        assert.equal(check.verdict, "review", JSON.stringify(over));
        assert.ok(check.differences.includes("date"));
    }
});

test("a VENDOR ref with no display name is not comparable, and is not a mismatch", () => {
    // QBO documents `name` on a ReferenceType as optional, so its absence is a
    // fact about the response shape rather than about the books. The vendor is
    // a DERIVE field — QuickBooks wins it outright — so nothing is lost by
    // skipping a comparison that cannot be made.
    const check = compareExistingPurchase(
        readBooked({ EntityRef: { value: "vendor-1" } }),
        baseInput(),
    );
    assert.equal(check.verdict, "match");
    assert.equal(check.booked.vendor, null);
});

test("a CUSTOMER ref with no display name is a REVIEW: the job was never confirmed", () => {
    // The job is not a derive field, and this is the half of the old rule that
    // was wrong. An id with no name says the lines agree with EACH OTHER; it
    // says nothing about whether they agree with this receipt, and the expected
    // customer's id is not known on the replay branch (resolving it there would
    // CREATE a QBO customer). "I could not check" must not read the same as "I
    // checked and it agrees" — the same rule the total and the date already
    // follow.
    const check = compareExistingPurchase(
        readBooked({
            Line: [{ Amount: 150, AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE_ACCOUNT_ID }, CustomerRef: { value: "cust-1" } } }],
        }),
        baseInput(),
    );
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
    assert.deepEqual(check.booked.projectNames, []);
});

// -- Attribution is PER LINE, not "one line agreed" (round-35 P1) ------------

/**
 * The finding: the project check ran only `if (projectNames.length > 0)` and
 * built that list from the lines that HAD a readable customer name. A Purchase
 * that was only partly coded therefore passed on the strength of its coded
 * half, and one that was not coded at all skipped the check entirely — and
 * book.ts then wrote a real Expense for the WHOLE amount against a job
 * QuickBooks does not carry it under.
 */
function linesOf(...lines: Record<string, unknown>[]) {
    return readBooked({ Line: lines });
}

const CODED = {
    Amount: 100,
    AccountBasedExpenseLineDetail: {
        AccountRef: { value: EXPENSE_ACCOUNT_ID },
        CustomerRef: { value: "cust-1", name: "Mueller Remodel" },
    },
};
/** The line with no CustomerRef at all: real money on this Purchase, on no job. */
const UNCODED = {
    Amount: 50,
    AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE_ACCOUNT_ID } },
};

test("ALL lines coded to this job books clean", () => {
    const check = compareExistingPurchase(linesOf(CODED, { ...CODED, Amount: 50 }), baseInput());
    assert.equal(check.verdict, "match");
    assert.deepEqual(check.differences, []);
});

test("ONE coded line plus an UNCODED one is a review — the old rule called this a match", () => {
    // $100 on the job, $50 on nothing, and the Expense would have been written
    // for the full $150 against the job.
    const check = compareExistingPurchase(linesOf(CODED, UNCODED), baseInput());
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
    assert.deepEqual(
        check.booked.lines.map(l => l.customerId),
        ["cust-1", null],
        "the uncoded line is RECORDED, not dropped — that is what the name set could not do",
    );
});

test("ZERO coded lines is a review — the old rule skipped the check entirely", () => {
    const check = compareExistingPurchase(linesOf(UNCODED, { ...UNCODED, Amount: 100 }), baseInput());
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
    assert.deepEqual(check.booked.projectNames, [], "nothing to build the old rule's list from");
});

test("all coded, one to a DIFFERENT customer, is a review", () => {
    const other = {
        Amount: 50,
        AccountBasedExpenseLineDetail: {
            AccountRef: { value: EXPENSE_ACCOUNT_ID },
            CustomerRef: { value: "cust-9", name: "Mesplay Kitchen" },
        },
    };
    const check = compareExistingPurchase(linesOf(CODED, other), baseInput());
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
});

test("identity is compared on CustomerRef.value, so two customers sharing a NAME is still a review", () => {
    // Two QBO customers can carry the same display name — a sub-customer under
    // a different parent, a duplicate nobody merged. The name comparison alone
    // cannot see it.
    const twin = {
        Amount: 50,
        AccountBasedExpenseLineDetail: {
            AccountRef: { value: EXPENSE_ACCOUNT_ID },
            CustomerRef: { value: "cust-2", name: "Mueller Remodel" },
        },
    };
    const check = compareExistingPurchase(linesOf(CODED, twin), baseInput());
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
});

test("an UNCODED TAX line is fine: the reclaimable account is its attribution", () => {
    // The reseller-permit tax posts to its own account and is not job money in
    // the same sense, so requiring a customer on it would park every honest
    // split. A tax line naming a DIFFERENT job is still a review.
    const taxLine = { Amount: 12.5, AccountBasedExpenseLineDetail: { AccountRef: { value: TAX_ACCOUNT_ID } } };
    const ok = compareExistingPurchase(
        readBooked({
            Line: [{ ...CODED, Amount: 137.5 }, taxLine],
        }),
        TAX_INPUT,
    );
    assert.equal(ok.verdict, "match");

    const wrongJob = compareExistingPurchase(
        readBooked({
            Line: [
                { ...CODED, Amount: 137.5 },
                {
                    Amount: 12.5,
                    AccountBasedExpenseLineDetail: {
                        AccountRef: { value: TAX_ACCOUNT_ID },
                        CustomerRef: { value: "cust-9", name: "Mesplay Kitchen" },
                    },
                },
            ],
        }),
        TAX_INPUT,
    );
    assert.equal(wrongJob.verdict, "review");
    assert.ok(wrongJob.differences.includes("project"));
});

test("a line shape this code cannot read is a review, never a silent skip", () => {
    // An item-based expense line, a v1-cutover Purchase, anything without an
    // AccountBasedExpenseLineDetail: there is no CustomerRef to find, and the
    // money on it is real.
    const itemBased = {
        Amount: 50,
        DetailType: "ItemBasedExpenseLineDetail",
        ItemBasedExpenseLineDetail: { ItemRef: { value: "item-1" } },
    };
    const check = compareExistingPurchase(linesOf(CODED, itemBased), baseInput());
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
    assert.equal(check.booked.lines[1].readable, false);
});

test("a Purchase with NO lines at all is a review", () => {
    const check = compareExistingPurchase(readBooked({ Line: [] }), baseInput());
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["project"]);
});

test("a REVIEW outranks a DERIVE when both kinds of difference are present", () => {
    const check = compareExistingPurchase(
        readBooked({
            TotalAmt: 999,
            Line: [{ Amount: 999, AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE_ACCOUNT_ID }, CustomerRef: { name: "Mesplay Kitchen" } } }],
        }),
        baseInput(),
    );
    assert.equal(check.verdict, "review");
    assert.deepEqual(check.differences, ["amount", "project"]);
});
