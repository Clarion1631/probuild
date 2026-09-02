import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
    createQBReceiptPurchase,
    ensureQBVendor,
    QboAccountConfigError,
    QboVendorDuplicateError,
    QboPurchaseFaultError,
    type CreateQBReceiptPurchaseInput,
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
    existingRows?: Array<{ Id: string; PrivateNote?: string }>;
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
    const { deps, calls } = createDeps({ existingRows: [{ Id: "purchase-99", PrivateNote: `note ${marker}` }] });
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.deepEqual(result, {
        ok: true,
        qbPurchaseId: "purchase-99",
        docNumber: input.fileId.slice(0, 21),
        alreadyExists: true,
        // No file in this input, so there is nothing to attach.
        attachment: "skipped",
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
            (async () => ({ ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const })),
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
            return { ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const };
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
            return { ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const };
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
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
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
    });
    // Still idempotent on the books: no second Purchase.
    assert.equal(calls.creates.length, 0);
    assert.deepEqual(uploads, [{ purchaseId: "99", fileName: "receipt.jpg" }]);
});

test("already-exists does NOT re-upload when the deterministic filename is already attached", async () => {
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    let uploadCount = 0;
    const { deps } = createDeps({
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
        attachableRows: [attachableRow("99", "receipt.jpg")],
        uploadAttachment: async () => {
            uploadCount += 1;
            return "attached";
        },
    });

    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.equal(result.ok && result.alreadyExists && result.attachment, "already-attached");
    assert.equal(uploadCount, 0, "an existing attachment must never be duplicated");
});

test("already-exists ignores an Attachable that belongs to a different entity type", async () => {
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const { deps } = createDeps({
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
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
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
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
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
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
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
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
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
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
            return { ok: true, qbPurchaseId: "p1", docNumber: "doc", alreadyExists: true, attachment: "already-attached" as const };
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


// --- The REAL ensure helpers must honour the route budget ---

test("the real vendor/customer ensures are bounded by the route budget", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError, QBTimeoutError } = await import("../src/lib/quickbooks");
    const { createQBReceiptPurchase } = await import("../src/lib/qbo-receipt-push");

    // Codex gate: ensureQBVendor/ensureQBCustomer make several QBO round trips
    // of their own (exact-name query, prefix query, create, duplicate
    // re-query). Those calls did not carry the budget, so a push could sit in
    // the ensures until the platform killed the function. This drives the REAL
    // helpers - nothing is replaced with a fake ensure - and only the network
    // underneath them is slow.
    const CEILING_MS = 60_000;
    const CALL_MS = 400;
    const calls: string[] = [];

    const slowFetch = (async (url: string) => {
        calls.push(String(url));
        await new Promise(resolve => setTimeout(resolve, CALL_MS));
        // Every lookup comes back empty, so the helpers walk their full path.
        return new Response(JSON.stringify({ QueryResponse: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;

    // Enough budget for a few calls, nowhere near enough for the whole push.
    const deadline = createRouteDeadline(2_200);
    const started = Date.now();

    const error = await withFetch(slowFetch, () =>
        createQBReceiptPurchase(
            TOKENS,
            baseInput({ ...FILE_INPUT }),
            // Only the database read is stubbed; every QBO call is real.
            { listProjects: async () => [PROJECT] },
            deadline,
        ),
    ).then(() => null, (e: unknown) => e as Error);

    const elapsed = Date.now() - started;

    assert.ok(error, "the push must stop itself rather than run to the ceiling");
    assert.ok(
        isQBBudgetExhaustedError(error) || error instanceof QBTimeoutError,
        `stopped for the wrong reason: ${error?.name}: ${error?.message}`,
    );
    // The point of the whole exercise: nowhere near the 60s route ceiling.
    assert.ok(elapsed < CEILING_MS / 10, `ran ${elapsed}ms, which is not comfortably under ${CEILING_MS}ms`);
    // Proof the real helpers were exercised: several distinct QBO round trips
    // happened through qbTimedFetch before the budget cut them off.
    assert.ok(calls.length >= 2, `expected several real QBO calls, saw ${calls.length}`);
    // The customer ensure runs first, so that is where the budget bites here;
    // both helpers are on the same clock and the assertion accepts either.
    assert.ok(
        calls.some(url => /Customer|Vendor/i.test(url)),
        `a real ensure should have queried QBO: ${calls.join(", ")}`,
    );
    // And it stopped INSIDE the ensure rather than completing the whole push.
    assert.equal(
        calls.some(url => /purchase\?requestid/i.test(url)),
        false,
        "the books write must not have been reached",
    );
});

test("an already-spent budget stops the real ensures before any QBO call", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    const { createQBReceiptPurchase } = await import("../src/lib/qbo-receipt-push");

    let calls = 0;
    const countingFetch = (async () => {
        calls++;
        return new Response(JSON.stringify({ QueryResponse: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;

    const spent = createRouteDeadline(2_000, Date.now() - 12_000);
    const error = await withFetch(countingFetch, () =>
        createQBReceiptPurchase(
            TOKENS,
            baseInput({ ...FILE_INPUT }),
            { listProjects: async () => [PROJECT] },
            spent,
        ),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(isQBBudgetExhaustedError(error), `got ${error?.name}: ${error?.message}`);
    assert.equal(calls, 0, "not one QBO request may be issued on an exhausted budget");
});


// --- The account-verification cache must not bind waiters to another clock ---

test("two concurrent pushes each honour THEIR OWN remaining budget", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    const { createQBReceiptPurchase } = await import("../src/lib/qbo-receipt-push");

    // Codex gate: caching the in-flight PROMISE bound every waiter to the
    // first request's lifetime, so a push with two seconds left would await a
    // verification started under someone else's 50s deadline and sit there
    // long past its own ceiling.
    let verifyStarted = 0;
    const slowAccounts = async (query: string) => {
        if (/FROM Account/i.test(query)) {
            verifyStarted++;
            // Longer than the second request's budget, shorter than the first's.
            await new Promise(resolve => setTimeout(resolve, 1_500));
            return defaultAccountRow(query);
        }
        return [];
    };

    const makeDeps = () => ({
        qbQueryFn: (async (_t: unknown, query: string) => await slowAccounts(query)) as never,
        ensureVendorFn: (async () => "vendor-1") as never,
        ensureCustomerFn: (async () => "cust-1") as never,
        listProjects: async () => [PROJECT],
        qbCreateFn: (async () => ({ id: "purchase-1" })) as never,
        uploadAttachment: (async () => "attached" as ReceiptAttachmentStatus) as never,
    });

    // A realm nothing else has used, so the module-level verification cache is
    // COLD and both pushes genuinely wait on the same in-flight verification.
    const tokens = { ...TOKENS, realmId: `realm-concurrency-${Date.now()}` };
    const generous = createRouteDeadline(30_000);
    const nearlySpent = createRouteDeadline(1_400, Date.now() - 700); // ~700ms left

    const started = Date.now();
    const [slowResult, fastResult] = await Promise.allSettled([
        createQBReceiptPurchase(tokens, baseInput(), makeDeps(), generous),
        createQBReceiptPurchase(tokens, baseInput({ fileId: "2BcDeFgHiJkLmNoPqRsTuVwXyZ0987654321" }), makeDeps(), nearlySpent),
    ]);
    const elapsed = Date.now() - started;

    // Both pushes shared one in-flight verification rather than duplicating it.
    // One shared in-flight verification, not one per push.
    assert.equal(verifyStarted, 3, "three account queries: one verification, shared");

    // The short-budget push must have given up on its OWN clock, well before
    // the 1.5s verification finished.
    assert.equal(fastResult.status, "rejected", "the short-budget push should not have waited it out");
    if (fastResult.status === "rejected") {
        assert.ok(
            isQBBudgetExhaustedError(fastResult.reason),
            `expected a budget error, got ${(fastResult.reason as Error)?.name}: ${(fastResult.reason as Error)?.message}`,
        );
    }
    // The generous push is unaffected by the other one walking away.
    assert.equal(slowResult.status, "fulfilled", `generous push failed: ${JSON.stringify(slowResult)}`);
    assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
});

// --- Attachment lookup: classify by status, not by "it threw" ---

test("a 400/403/404 attachment lookup is terminal, not an endless retry", async () => {
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;

    for (const status of [400, 403, 404]) {
        const { deps } = createDeps({
            existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
            attachableQueryImpl: async () => {
                throw new QboHttpError(`QB query failed (${status})`, status);
            },
        });
        const result = await createQBReceiptPurchase(TOKENS, input, deps);
        // QuickBooks answered with a refusal that will repeat: record it and
        // move on rather than resending forever.
        assert.equal(result.ok, true, `status ${status} should stay ok:true`);
        assert.equal(
            result.ok && result.alreadyExists && result.attachment,
            `failed:${status}`,
            `status ${status}`,
        );
    }
});

test("a 429/5xx attachment lookup stays retryable", async () => {
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;

    for (const status of [429, 500, 503]) {
        const { deps } = createDeps({
            existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
            attachableQueryImpl: async () => {
                throw new QboHttpError(`QB query failed (${status})`, status);
            },
        });
        await assert.rejects(
            () => createQBReceiptPurchase(TOKENS, input, deps),
            (e: unknown) => (e as Error)?.name === "QboRetryableError",
            `status ${status}`,
        );
    }
});

test("qbQuery raises a typed QboHttpError carrying the status", async () => {
    const { qbQuery, qboHttpStatus } = await import("../src/lib/quickbooks");
    const impl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const error = await withFetch(impl, () => qbQuery(TOKENS, "SELECT Id FROM Vendor")).then(
        () => null,
        (e: unknown) => e as Error,
    );
    assert.equal(error?.name, "QboHttpError");
    assert.equal(qboHttpStatus(error), 404);
});


// --- Recovery lookup must match the upload path's transient set ---

test("a 401 attachment LOOKUP forces one refresh and retries, like the upload does", async () => {
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;

    // Codex gate: the upload retried a 401 after a forced refresh while the
    // lookup treated it as terminal - one recovery step giving up exactly
    // where the other kept going.
    let lookups = 0;
    let refreshes = 0;
    const uploads: string[] = [];
    const { deps } = createDeps({
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
        attachableQueryImpl: async () => {
            lookups++;
            if (lookups === 1) throw new QboHttpError("QB query failed (401)", 401);
            return []; // after the refresh: no attachment on file yet
        },
        uploadAttachment: async (t) => {
            uploads.push(t.accessToken);
            return "attached";
        },
    });

    deps.refreshTokensFn = async () => {
        refreshes++;
        return { accessToken: "fresh-token", refreshToken: "r", realmId: "test-realm" };
    };
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.equal(result.ok && result.alreadyExists && result.attachment, "attached");
    assert.equal(lookups, 2, "one retry after the refresh");
    assert.equal(refreshes, 1, "exactly one forced refresh");
    assert.deepEqual(uploads, ["fresh-token"], "the upload must use the refreshed token");
});

test("a 401 lookup that survives the refresh is retryable, not terminal", async () => {
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    let refreshes = 0;
    const { deps } = createDeps({
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
        attachableQueryImpl: async () => {
            throw new QboHttpError("QB query failed (401)", 401);
        },
    });

    deps.refreshTokensFn = async () => {
        refreshes++;
        return { accessToken: "fresh-token", refreshToken: "r", realmId: "test-realm" };
    };
    await assert.rejects(
        () => createQBReceiptPurchase(TOKENS, input, deps),
        (e: unknown) => (e as Error)?.name === "QboRetryableError",
    );
    assert.equal(refreshes, 1, "must not loop on the refresh");
});

test("a 408 attachment lookup is retryable, matching the upload path", async () => {
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;
    const { deps } = createDeps({
        existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
        attachableQueryImpl: async () => {
            throw new QboHttpError("QB query failed (408)", 408);
        },
    });
    await assert.rejects(
        () => createQBReceiptPurchase(TOKENS, input, deps),
        (e: unknown) => (e as Error)?.name === "QboRetryableError",
    );
});

test("the lookup and the upload agree on which statuses are transient", async () => {
    const { isTransientAttachmentStatus } = await import("../src/lib/qbo-receipt-push");
    // One list, both paths.
    for (const status of [401, 408, 429, 500, 503]) {
        assert.equal(isTransientAttachmentStatus(status), true, String(status));
    }
    for (const status of [400, 403, 404, 413, 415]) {
        assert.equal(isTransientAttachmentStatus(status), false, String(status));
    }
});

// --- The shared verification runs on its own clock, whoever starts it ---

test("a SHORT-budget push starting the verification does not poison it for others", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    const { createQBReceiptPurchase } = await import("../src/lib/qbo-receipt-push");

    // Codex gate: ordering matters. When the impatient request is the one that
    // KICKS OFF the shared verification, binding that work to its deadline
    // killed the verification everyone else was waiting on. The shared work
    // now has its own fixed budget; the initiator only gives up on its own.
    let accountQueries = 0;
    const slowAccounts = async (query: string) => {
        if (/FROM Account/i.test(query)) {
            accountQueries++;
            await new Promise(resolve => setTimeout(resolve, 1_200));
            return defaultAccountRow(query);
        }
        return [];
    };
    const makeDeps = () => ({
        qbQueryFn: (async (_t: unknown, query: string) => await slowAccounts(query)) as never,
        ensureVendorFn: (async () => "vendor-1") as never,
        ensureCustomerFn: (async () => "cust-1") as never,
        listProjects: async () => [PROJECT],
        qbCreateFn: (async () => ({ id: "purchase-1" })) as never,
        uploadAttachment: (async () => "attached" as ReceiptAttachmentStatus) as never,
    });

    // Cold cache for this realm so the verification genuinely runs.
    const tokens = { ...TOKENS, realmId: `realm-order-${Date.now()}` };
    const nearlySpent = createRouteDeadline(1_400, Date.now() - 700); // ~700ms left

    // The impatient one goes FIRST and therefore starts the shared work.
    const impatient = createQBReceiptPurchase(tokens, baseInput(), makeDeps(), nearlySpent);
    await new Promise(resolve => setTimeout(resolve, 50));
    const patient = createQBReceiptPurchase(
        tokens,
        baseInput({ fileId: "3CdEfGhIjKlMnOpQrStUvWxYz1234567890" }),
        makeDeps(),
        createRouteDeadline(30_000),
    );

    const [impatientResult, patientResult] = await Promise.allSettled([impatient, patient]);

    assert.equal(impatientResult.status, "rejected", "the initiator should give up on its own budget");
    if (impatientResult.status === "rejected") {
        assert.ok(
            isQBBudgetExhaustedError(impatientResult.reason),
            `expected a budget error, got ${(impatientResult.reason as Error)?.name}`,
        );
    }
    // The whole point: the patient push still completes.
    assert.equal(
        patientResult.status,
        "fulfilled",
        `the shared verification was poisoned: ${JSON.stringify(patientResult)}`,
    );
    assert.equal(accountQueries, 3, "one shared verification, not one per push");
});


// --- One transient classification, shared by every create path ---

test("a 503 on the REAL vendor/customer/purchase create reaches the route as a 503 retry", async () => {
    // Codex gate: each create classified for itself and none knew about
    // transient statuses, so a 503 came back as a bare Error and the route
    // reported an unknown failure (500) instead of the outage it plainly was.
    // This drives the real helpers through the real route handler; only the
    // network underneath returns 503.
    const events: AutomationEventInput[] = [];
    const serviceUnavailable = (async () =>
        new Response(JSON.stringify({ Fault: { Error: [{ code: "5000" }] } }), {
            status: 503,
            headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

    const { POST } = createRouteHandlers({
        getFreshTokens: async () => TOKENS,
        createPurchase: (tokens, input, deadline) =>
            withFetch(serviceUnavailable, async () => {
                const mod = await import("../src/lib/qbo-receipt-push");
                // Real ensures, real queries, real create — nothing stubbed but
                // the project list, which is a database read.
                return mod.createQBReceiptPurchase(tokens, input, { listProjects: async () => [PROJECT] }, deadline);
            }),
        logEvent: event => { events.push(event); },
    });

    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: JSON.stringify({
            fileId: "file-503",
            projectName: PROJECT.name,
            vendor: "Home Depot",
            date: "2026-07-15",
            totalAmount: 100,
            groups: [{ category: "03 Plumbing", amount: 100 }],
        }),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, retry: true, reason: "qbo-unavailable" });
    assert.equal(events[0].reason, "qbo-unavailable");
});

test("408/429/5xx share one transient classification at the boundary", async () => {
    const { isTransientQboStatus } = await import("../src/lib/quickbooks");
    for (const status of [408, 429, 500, 502, 503, 504]) {
        assert.equal(isTransientQboStatus(status), true, String(status));
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
        assert.equal(isTransientQboStatus(status), false, String(status));
    }
});

test("qboResponseError picks the class from the status", async () => {
    const { qboResponseError, isRetryableQboError, qboHttpStatus } = await import("../src/lib/quickbooks");

    const transient = await qboResponseError(new Response("busy", { status: 503 }), "QB vendor create");
    assert.equal(isRetryableQboError(transient), true);
    assert.equal(qboHttpStatus(transient), null, "a retryable error is not a plain HTTP error");

    const terminal = await qboResponseError(new Response("nope", { status: 400 }), "QB vendor create");
    assert.equal(terminal.name, "QboHttpError");
    assert.equal(qboHttpStatus(terminal), 400);
});


// --- A deterministic 4xx from an ensure is terminal, not a retry loop ---

test("a 400 on the REAL customer create is a terminal qbo-fault at the route", async () => {
    // Codex gate: a business refusal from an ensure arrived as an untyped
    // QboHttpError and fell through to the generic 500, so the bot retried an
    // answer QuickBooks had already given, verbatim, forever.
    const events: AutomationEventInput[] = [];
    const badRequest = (async (url: string) =>
        // Lookups come back empty so the ensure proceeds to the create, which
        // QuickBooks refuses.
        /\/customer\b/.test(String(url)) && !String(url).includes("query")
            ? new Response(JSON.stringify({ Fault: { Error: [{ code: "6240" }] } }), { status: 400 })
            : new Response(JSON.stringify({ QueryResponse: {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
            })) as unknown as typeof fetch;

    const { POST } = createRouteHandlers({
        getFreshTokens: async () => TOKENS,
        createPurchase: (tokens, input, deadline) =>
            withFetch(badRequest, async () => {
                const mod = await import("../src/lib/qbo-receipt-push");
                return mod.createQBReceiptPurchase(tokens, input, { listProjects: async () => [PROJECT] }, deadline);
            }),
        logEvent: event => { events.push(event); },
    });

    const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: JSON.stringify({
            fileId: "file-400",
            projectName: PROJECT.name,
            vendor: "Home Depot",
            date: "2026-07-15",
            totalAmount: 100,
            groups: [{ category: "03 Plumbing", amount: 100 }],
        }),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));

    // 200 + ok:false is terminal for the Apps Script: it books via the email
    // path instead of hammering a refusal.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, "qbo-fault");
    assert.equal(body.detail, "400");
    assert.equal(events[0].reason, "qbo-fault:400");
});

test("a 403 from an ensure is terminal too, while a 503 stays retryable", async () => {
    const { QboHttpError, QboRetryableError } = await import("../src/lib/quickbooks");

    const terminal = createRouteHandlers({
        createPurchase: async () => { throw new QboHttpError("QB customer create failed (403)", 403); },
    });
    const terminalResponse = await terminal.POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(terminalResponse.status, 200);
    assert.deepEqual(await terminalResponse.json(), { ok: false, reason: "qbo-fault", detail: "403" });

    const transient = createRouteHandlers({
        createPurchase: async () => { throw new QboRetryableError("QB customer create failed (503)", 503); },
    });
    const transientResponse = await transient.POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
        method: "POST",
        body: validBody(),
        headers: { "content-type": "application/json", "x-ingest-key": "ingest-secret" },
    }));
    assert.equal(transientResponse.status, 503);
    assert.deepEqual(await transientResponse.json(), { ok: false, retry: true, reason: "qbo-unavailable" });
});


// --- deposit-ingest: the money-moving send shares the request budget ---

test("the deposit-ingest booking passes its deadline into the payment send", async () => {
    const { createRouteDeadline, isQBBudgetExhaustedError } = await import("../src/lib/quickbooks");
    const { sendQBPaymentCreateRequest } = await import("../src/lib/quickbooks");

    // Codex gate: the initial booking built its request under the shared
    // budget but then sent it without one, so the third and most important
    // serial call - the one that moves money - ran unbounded.
    const spent = createRouteDeadline(2_000, Date.now() - 12_000);
    let calls = 0;
    const countingFetch = (async () => {
        calls++;
        return new Response(JSON.stringify({ Payment: { Id: "p1", TotalAmt: 100 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;

    const error = await withFetch(countingFetch, () =>
        sendQBPaymentCreateRequest(TOKENS, JSON.stringify({ TotalAmt: 100 }), "req-1", spent),
    ).then(() => null, (e: unknown) => e as Error);

    assert.ok(isQBBudgetExhaustedError(error), `got ${error?.name}: ${error?.message}`);
    assert.equal(calls, 0, "an exhausted budget must not issue the payment create");
});

test("the payment send succeeds normally when there is budget left", async () => {
    const { createRouteDeadline, sendQBPaymentCreateRequest } = await import("../src/lib/quickbooks");
    const okFetch = (async () =>
        new Response(JSON.stringify({ Payment: { Id: "p9", TotalAmt: 250 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

    const sent = await withFetch(okFetch, () =>
        sendQBPaymentCreateRequest(TOKENS, JSON.stringify({ TotalAmt: 250 }), "req-2", createRouteDeadline(30_000)),
    );
    assert.deepEqual(sent, { paymentId: "p9", amount: 250 });
});


// --- A failed 401 refresh must not be swallowed ---

test("typed refresh failures propagate from the attachment 401 retry", async () => {
    const { defaultUploadAttachment } = await import("../src/lib/qbo-receipt-push");
    const { QBTimeoutError, QboRetryableError, QBTokenStrandedError } = await import("../src/lib/quickbooks");
    const { QBTokenPersistenceError } = await import("../src/lib/quickbooks-payments");

    // Codex gate: `.catch(() => null)` made a QBO outage, a stranded token and
    // a persistence failure all look like an ordinary 401, hiding the one
    // thing a human needs to act on.
    const unauthorized = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    for (const error of [
        new QBTimeoutError("refresh timed out"),
        new QboRetryableError("503 from Intuit", 503),
        new QBTokenStrandedError("ECONNRESET"),
        new QBTokenPersistenceError(),
    ]) {
        const thrown = await withFetch(unauthorized, () =>
            defaultUploadAttachment(TOKENS, "99", uploadFile, async () => { throw error; }),
        ).then(() => null, (e: unknown) => e as Error);
        assert.equal(thrown?.name, error.name, `${error.name} was swallowed`);
    }
});

test("an ordinary refresh failure still degrades to the plain 401 outcome", async () => {
    const { defaultUploadAttachment } = await import("../src/lib/qbo-receipt-push");
    const unauthorized = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const thrown = await withFetch(unauthorized, () =>
        defaultUploadAttachment(TOKENS, "99", uploadFile, async () => { throw new Error("not connected"); }),
    ).then(() => null, (e: unknown) => e as Error);
    // Still retryable (the 401 survived), but not masquerading as a token error.
    assert.equal(thrown?.name, "QboRetryableError");
});

// --- The recovery lookup's 401 retry matches the upload branch exactly ---

test("typed refresh failures propagate from the attachment LOOKUP 401 retry too", async () => {
    const { QboHttpError, QBTimeoutError, QboRetryableError, QBTokenStrandedError } = await import("../src/lib/quickbooks");
    const { QBTokenPersistenceError } = await import("../src/lib/quickbooks-payments");
    const input = baseInput({ ...FILE_INPUT });
    const marker = `[gtr-file:${input.fileId}]`;

    // Codex gate: the upload branch preserved these; the existing-purchase
    // recovery branch still swallowed them, so the same outage read as an
    // ordinary 401 depending on which call happened to hit it first.
    for (const error of [
        new QBTimeoutError("refresh timed out"),
        new QboRetryableError("503 from Intuit", 503),
        new QBTokenStrandedError("ECONNRESET"),
        new QBTokenPersistenceError(),
    ]) {
        const { deps } = createDeps({
            existingRows: [{ Id: "99", PrivateNote: `note ${marker}` }],
            attachableQueryImpl: async () => {
                throw new QboHttpError("QB query failed (401)", 401);
            },
        });
        deps.refreshTokensFn = async () => { throw error; };
        const thrown = await createQBReceiptPurchase(TOKENS, input, deps).then(
            () => null,
            (e: unknown) => e as Error,
        );
        assert.equal(thrown?.name, error.name, `${error.name} was swallowed by the lookup branch`);
    }
});
