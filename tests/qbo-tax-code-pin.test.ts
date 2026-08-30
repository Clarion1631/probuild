import assert from "node:assert/strict";
import test from "node:test";
import { resolveQBTaxCodeId, createQBMilestoneInvoice, type QBTokens } from "../src/lib/quickbooks";

// Stub global fetch so every QBO call is captured; each test installs its own handler.
type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
const calls: Array<{ url: string; body: unknown }> = [];
function stubFetch(handler: Handler) {
    calls.length = 0;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        const out = handler(url, init);
        const status = out.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => out.body,
            text: async () => JSON.stringify(out.body),
        } as Response;
    };
}

const tokens: QBTokens = { accessToken: "tok", refreshToken: "ref", realmId: "123", connected: true } as QBTokens;

const taxCodeRows = (rows: Array<{ Id: string; Name: string; Active?: boolean }>) => ({
    QueryResponse: { TaxCode: rows },
});

test("resolveQBTaxCodeId: exact name match returns the QBO id", async () => {
    stubFetch(() => ({ body: taxCodeRows([{ Id: "13", Name: "Winlock", Active: true }]) }));
    assert.equal(await resolveQBTaxCodeId(tokens, "Winlock"), "13");
    assert.match(decodeURIComponent(calls[0].url), /SELECT Id, Name, Active FROM TaxCode WHERE Name = 'Winlock'/);
});

test("resolveQBTaxCodeId: case-insensitive on the returned row, skips inactive codes", async () => {
    stubFetch(() => ({ body: taxCodeRows([{ Id: "9", Name: "winlock", Active: false }, { Id: "13", Name: "WINLOCK", Active: true }]) }));
    assert.equal(await resolveQBTaxCodeId(tokens, "Winlock"), "13");
});

test("resolveQBTaxCodeId: null for blank name (no QBO call), no match, or lookup failure", async () => {
    stubFetch(() => ({ body: taxCodeRows([{ Id: "13", Name: "Winlock" }]) }));
    assert.equal(await resolveQBTaxCodeId(tokens, null), null);
    assert.equal(await resolveQBTaxCodeId(tokens, "   "), null);
    assert.equal(calls.length, 0, "blank names must not hit QBO");

    stubFetch(() => ({ body: taxCodeRows([]) }));
    assert.equal(await resolveQBTaxCodeId(tokens, "Camas"), null);

    stubFetch(() => ({ status: 500, body: { Fault: { Error: [{ Message: "boom" }] } } }));
    assert.equal(await resolveQBTaxCodeId(tokens, "Winlock"), null, "lookup errors fail soft");
});

test("resolveQBTaxCodeId: escapes quotes in the jurisdiction name", async () => {
    stubFetch(() => ({ body: taxCodeRows([]) }));
    await resolveQBTaxCodeId(tokens, "O'Brien");
    assert.match(decodeURIComponent(calls[0].url), /Name = 'O\\'Brien'/);
});

const baseInput = {
    docNumber: "INV-00177-2",
    customerId: "542",
    itemId: "7",
    description: "Berg ADU — Drywall Complete",
    amount: 15000,
};

test("createQBMilestoneInvoice: taxed push pins TxnTaxCodeRef alongside TotalTax", async () => {
    stubFetch(() => ({ body: { Invoice: { Id: "6278", TotalAmt: 15000 } } }));
    await createQBMilestoneInvoice(tokens, {
        ...baseInput,
        tax: { preTaxAmount: 13888.89, taxAmount: 1111.11 },
        taxCodeId: "13",
    });
    const payload = calls[0].body as { TxnTaxDetail: unknown; Line: Array<{ Amount: number; SalesItemLineDetail: { TaxCodeRef?: { value: string } } }> };
    assert.deepEqual(payload.TxnTaxDetail, { TxnTaxCodeRef: { value: "13" }, TotalTax: 1111.11 });
    assert.equal(payload.Line[0].Amount, 13888.89);
    assert.deepEqual(payload.Line[0].SalesItemLineDetail.TaxCodeRef, { value: "TAX" });
});

test("createQBMilestoneInvoice: no tax code resolved keeps the pre-existing payload shape", async () => {
    stubFetch(() => ({ body: { Invoice: { Id: "1", TotalAmt: 15000 } } }));
    await createQBMilestoneInvoice(tokens, { ...baseInput, tax: { preTaxAmount: 13888.89, taxAmount: 1111.11 }, taxCodeId: null });
    const payload = calls[0].body as { TxnTaxDetail: unknown };
    assert.deepEqual(payload.TxnTaxDetail, { TotalTax: 1111.11 });
});

test("createQBMilestoneInvoice: tax-exempt push carries no TxnTaxDetail even when a code id is passed", async () => {
    stubFetch(() => ({ body: { Invoice: { Id: "2", TotalAmt: 7500 } } }));
    await createQBMilestoneInvoice(tokens, { ...baseInput, amount: 7500, tax: null, taxCodeId: "13" });
    const payload = calls[0].body as { TxnTaxDetail?: unknown; Line: Array<{ Amount: number; SalesItemLineDetail: { TaxCodeRef?: unknown } }> };
    assert.equal(payload.TxnTaxDetail, undefined);
    assert.equal(payload.Line[0].Amount, 7500);
    assert.equal(payload.Line[0].SalesItemLineDetail.TaxCodeRef, undefined);
});
