/**
 * Request-level tests for GET /api/pdf/invoices/[id] and /api/pdf/change-orders/[id]:
 * the ?exact=1 flag (409 when the server PDF would not match the page), the ?milestone= focus ids,
 * and that the entitlement checks still run before any PDF is made.
 *
 * Same require()-patch technique as tests/qbo-sync-route-auth.test.ts (never mock.module(): it breaks the
 * require chain for every other module in the file on Node 20).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { NextRequest } from "next/server";

const state: {
    staff: boolean;
    portalClientId: string | null;
    invoice: any;
    changeOrder: any;
    coWhere: any;
    lossy: boolean;
    invoiceCalls: Array<{ id: string; opts: any }>;
    coCalls: string[];
} = { staff: false, portalClientId: null, invoice: null, changeOrder: null, coWhere: null, lossy: false, invoiceCalls: [], coCalls: [] };

function reset() {
    state.staff = false; state.portalClientId = null; state.lossy = false; state.coWhere = null;
    state.invoice = { clientId: "c1", project: { clientId: "c1" } };
    state.changeOrder = { id: "co1" };
    state.invoiceCalls = []; state.coCalls = [];
}

const fakeAuth = { isStaffRequest: async () => state.staff, getPortalClientId: async () => state.portalClientId };
const fakePrisma = {
    invoice: { findUnique: async () => state.invoice },
    changeOrder: { findFirst: async (args: any) => { state.coWhere = args.where; return state.changeOrder; } },
};
const PDF_BYTES = Buffer.from("%PDF-1.7 fake");
const fakePdf = {
    generateInvoicePdfWithAudit: async (id: string, opts: any) => { state.invoiceCalls.push({ id, opts }); return { bytes: PDF_BYTES, lossy: state.lossy }; },
    generateChangeOrderPdfWithAudit: async (id: string) => { state.coCalls.push(id); return { bytes: PDF_BYTES, lossy: state.lossy }; },
};

let invoiceGET: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let coGET: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/pdf-route-auth") return fakeAuth;
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
        if (id === "@/lib/pdf") return fakePdf;
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    try {
        invoiceGET = (await import("../src/app/api/pdf/invoices/[id]/route")).GET as any;
        coGET = (await import("../src/app/api/pdf/change-orders/[id]/route")).GET as any;
    } finally {
        Module.prototype.require = originalRequire;
    }
    assert.equal(typeof invoiceGET, "function");
    assert.equal(typeof coGET, "function");
});

beforeEach(reset);

const ctx = { params: Promise.resolve({ id: "inv1" }) };
const req = (path: string) => new NextRequest(`http://localhost${path}`);

test("invoice: anonymous and wrong-client callers get 404 and no PDF is made", async () => {
    assert.equal((await invoiceGET(req("/api/pdf/invoices/inv1"), ctx)).status, 404);
    state.portalClientId = "someone-else";
    assert.equal((await invoiceGET(req("/api/pdf/invoices/inv1"), ctx)).status, 404);
    assert.equal(state.invoiceCalls.length, 0);
});

test("invoice: entitled + lossy + exact=1 answers 409 JSON, never cached", async () => {
    state.portalClientId = "c1"; state.lossy = true;
    const res = await invoiceGET(req("/api/pdf/invoices/inv1?exact=1"), ctx);
    assert.equal(res.status, 409);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("invoice: lossy without the flag still answers the PDF; clean with the flag answers the PDF", async () => {
    state.portalClientId = "c1"; state.lossy = true;
    const plain = await invoiceGET(req("/api/pdf/invoices/inv1"), ctx);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("content-type"), "application/pdf");
    state.lossy = false;
    const exact = await invoiceGET(req("/api/pdf/invoices/inv1?exact=1"), ctx);
    assert.equal(exact.status, 200);
    assert.equal(exact.headers.get("content-type"), "application/pdf");
});

test("invoice: milestone ids are trimmed, filtered and capped before they reach the generator", async () => {
    state.portalClientId = "c1";
    await invoiceGET(req(`/api/pdf/invoices/inv1?milestone=${encodeURIComponent(" a , b ,," + "x".repeat(51))}`), ctx);
    assert.deepEqual(state.invoiceCalls[0].opts.requestedMilestoneIds, ["a", "b"]);
    const many = Array.from({ length: 45 }, (_, i) => `m${i}`).join(",");
    await invoiceGET(req(`/api/pdf/invoices/inv1?milestone=${many}`), ctx);
    assert.equal(state.invoiceCalls[1].opts.requestedMilestoneIds.length, 40);
});

test("invoice: only the exact path asks the PDF to omit the focused Total Amount", async () => {
    state.portalClientId = "c1";
    await invoiceGET(req("/api/pdf/invoices/inv1?milestone=a&exact=1"), ctx);
    assert.equal(state.invoiceCalls[0].opts.omitFocusedTotal, true);
    await invoiceGET(req("/api/pdf/invoices/inv1?milestone=a"), ctx);
    assert.equal(state.invoiceCalls[1].opts.omitFocusedTotal, false);
});

test("change order: a portal client is scoped to its own, non-Draft change orders; a miss is 404", async () => {
    state.portalClientId = "c1";
    assert.equal((await coGET(req("/api/pdf/change-orders/co1"), ctx)).status, 200);
    assert.deepEqual(state.coWhere.status, { in: ["Sent", "Approved", "Declined"] });
    assert.deepEqual(state.coWhere.project, { clientId: "c1" });
    state.changeOrder = null;
    assert.equal((await coGET(req("/api/pdf/change-orders/co1"), ctx)).status, 404);
});

test("change order: staff + lossy + exact=1 answers 409; lossy without the flag answers the PDF", async () => {
    state.staff = true; state.lossy = true;
    assert.equal((await coGET(req("/api/pdf/change-orders/co1?exact=1"), ctx)).status, 409);
    assert.equal((await coGET(req("/api/pdf/change-orders/co1"), ctx)).status, 200);
});
