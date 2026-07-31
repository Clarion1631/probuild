import assert from "node:assert/strict";
import test from "node:test";
import {
    createQBReceiptPurchase,
    type CreateQBReceiptPurchaseInput,
    type QboReceiptProjectCandidate,
    type QboReceiptPushDependencies,
    type ReceiptAttachmentStatus,
} from "../src/lib/qbo-receipt-push";
import { POST } from "../src/app/api/integrations/qbo-receipts/create/route";

const TOKENS = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    realmId: "test-realm",
};

const PROJECT: QboReceiptProjectCandidate = {
    id: "project-1",
    name: "Mueller Remodel",
    client: { id: "client-1", name: "Mueller", email: "mueller@example.com", qbCustomerId: "cust-1" },
};

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

interface DepsOverrides {
    existingRows?: Array<{ Id: string }>;
    createdId?: string;
    vendorId?: string;
    projects?: QboReceiptProjectCandidate[];
    uploadAttachment?: QboReceiptPushDependencies["uploadAttachment"];
}

function createDeps(overrides: DepsOverrides = {}) {
    const calls = {
        queries: [] as string[],
        creates: [] as Record<string, unknown>[],
        vendorCalls: [] as string[],
        persisted: [] as Array<{ clientId: string; qbCustomerId: string }>,
    };
    const deps: Partial<QboReceiptPushDependencies> = {
        qbQueryFn: async (_tokens, query: string) => {
            calls.queries.push(query);
            return (overrides.existingRows ?? []) as never[];
        },
        qbCreateFn: async (_tokens, payload) => {
            calls.creates.push(payload);
            return { id: overrides.createdId ?? "purchase-1" };
        },
        ensureVendorFn: async (_tokens, name: string) => {
            calls.vendorCalls.push(name);
            return overrides.vendorId ?? "vendor-1";
        },
        listProjects: async () => overrides.projects ?? [PROJECT],
        persistCustomerId: async (clientId: string, qbCustomerId: string) => {
            calls.persisted.push({ clientId, qbCustomerId });
        },
        uploadAttachment:
            overrides.uploadAttachment ??
            (async () => "attached" as ReceiptAttachmentStatus),
    };
    return { deps, calls };
}

test("createQBReceiptPurchase short-circuits when the DocNumber already exists", async () => {
    const { deps, calls } = createDeps({ existingRows: [{ Id: "purchase-99" }] });
    const input = baseInput();
    const result = await createQBReceiptPurchase(TOKENS, input, deps);

    assert.deepEqual(result, {
        ok: true,
        qbPurchaseId: "purchase-99",
        docNumber: input.fileId.slice(0, 21),
        alreadyExists: true,
    });
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.vendorCalls.length, 0);
    assert.equal(calls.persisted.length, 0);
});

test("createQBReceiptPurchase returns project-not-matched and writes nothing", async () => {
    const { deps, calls } = createDeps({ projects: [] });
    const result = await createQBReceiptPurchase(TOKENS, baseInput({ projectName: "Nobody Remodel" }), deps);

    assert.deepEqual(result, { ok: false, reason: "project-not-matched", projectName: "Nobody Remodel" });
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.vendorCalls.length, 0);
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
    assert.equal(calls.persisted.length, 0);
});

test("createQBReceiptPurchase builds the payload with line-level CustomerRef and skips zero-amount groups", async () => {
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
    const payload = calls.creates[0] as any;
    assert.equal(payload.DocNumber, input.fileId.slice(0, 21));
    assert.equal(payload.Line.length, 2); // the $0 Electrical group is skipped
    for (const line of payload.Line) {
        assert.equal(line.AccountBasedExpenseLineDetail.CustomerRef.value, "cust-1");
    }
    assert.match(payload.PrivateNote, /\[gtr-file:1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890\]/);
    assert.equal(calls.vendorCalls[0], "Home Depot");
});

test('createQBReceiptPurchase omits EntityRef for an unset or "Unknown" vendor', async () => {
    const { deps: depsUnknown, calls: callsUnknown } = createDeps();
    const resultUnknown = await createQBReceiptPurchase(TOKENS, baseInput({ vendor: "Unknown" }), depsUnknown);
    assert.equal(resultUnknown.ok, true);
    assert.equal("EntityRef" in (callsUnknown.creates[0] as any), false);
    assert.equal(callsUnknown.vendorCalls.length, 0);

    const { deps: depsEmpty, calls: callsEmpty } = createDeps();
    const resultEmpty = await createQBReceiptPurchase(TOKENS, baseInput({ vendor: "" }), depsEmpty);
    assert.equal(resultEmpty.ok, true);
    assert.equal("EntityRef" in (callsEmpty.creates[0] as any), false);
    assert.equal(callsEmpty.vendorCalls.length, 0);
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

test("createQBReceiptPurchase treats an attachment failure as non-fatal", async () => {
    const { deps } = createDeps({
        uploadAttachment: async () => {
            throw new Error("boom");
        },
    });
    const result = await createQBReceiptPurchase(
        TOKENS,
        baseInput({ fileBase64: Buffer.from("hello receipt").toString("base64"), fileContentType: "image/jpeg" }),
        deps,
    );
    assert.equal(result.ok, true);
    if (result.ok && !result.alreadyExists) {
        assert.match(result.attachment, /^failed:/);
    } else {
        assert.fail("expected a fresh create");
    }
});

test("route POST rejects when the kill switch is off", async () => {
    const original = process.env.QBO_RECEIPT_PUSH_ENABLED;
    delete process.env.QBO_RECEIPT_PUSH_ENABLED;
    try {
        const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
            method: "POST",
            body: JSON.stringify({}),
            headers: { "content-type": "application/json" },
        }));
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false, reason: "push-disabled" });
    } finally {
        if (original === undefined) delete process.env.QBO_RECEIPT_PUSH_ENABLED;
        else process.env.QBO_RECEIPT_PUSH_ENABLED = original;
    }
});

test("route POST rejects a missing/invalid ingest key even when the kill switch is on", async () => {
    const originalEnabled = process.env.QBO_RECEIPT_PUSH_ENABLED;
    const originalSecret = process.env.RECEIPT_INGEST_SECRET;
    process.env.QBO_RECEIPT_PUSH_ENABLED = "true";
    process.env.RECEIPT_INGEST_SECRET = "test-secret";
    try {
        const response = await POST(new Request("https://example.test/api/integrations/qbo-receipts/create", {
            method: "POST",
            body: JSON.stringify({}),
            headers: { "content-type": "application/json" },
        }));
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
    } finally {
        if (originalEnabled === undefined) delete process.env.QBO_RECEIPT_PUSH_ENABLED;
        else process.env.QBO_RECEIPT_PUSH_ENABLED = originalEnabled;
        if (originalSecret === undefined) delete process.env.RECEIPT_INGEST_SECRET;
        else process.env.RECEIPT_INGEST_SECRET = originalSecret;
    }
});
