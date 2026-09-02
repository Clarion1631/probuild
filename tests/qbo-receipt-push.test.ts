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
