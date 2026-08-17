import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    buildChangeOrderSendPreviewPayload,
    canonicalChangeOrderRecipients,
    formatChangeOrderConfirmToken,
    parseChangeOrderConfirmToken,
} from "../src/lib/change-order-send-preview";
import { mintPreviewToken, verifyPreviewToken } from "../src/lib/mcp-preview-token";

const base = {
    changeOrderId: "co-terms-token",
    generation: "11111111-1111-4111-8111-111111111111",
    recipients: {
        primary: "client@example.test",
        additional: ["second@example.test"],
    },
    code: "CO-00042",
    title: "Exact tax terms",
    pricingType: "FIXED",
    markupPercent: null,
    total: 10,
    schedules: [["row-1", "Deposit", 5, null, 0]],
    status: "Draft",
    revision: 7,
    taxTerms: {
        taxExempt: false,
        taxRatePercent: 8.875,
        taxRateName: "Seattle exact rate",
    },
};

test("MCP send confirmation token is bound to revision and the canonical tax tuple", () => {
    const priorSecret = process.env.MCP_SECRET;
    process.env.MCP_SECRET = "disposable-unit-secret";
    try {
        const payload = buildChangeOrderSendPreviewPayload(base);
        const token = mintPreviewToken(payload);
        assert.equal(verifyPreviewToken(token, payload), true);

        const taxOnlyEdit = buildChangeOrderSendPreviewPayload({
            ...base,
            taxTerms: { ...base.taxTerms, taxRatePercent: 9.125, taxRateName: "Edited rate" },
        });
        assert.equal(verifyPreviewToken(token, taxOnlyEdit), false);

        const revisionOnlyEdit = buildChangeOrderSendPreviewPayload({ ...base, revision: 8 });
        assert.equal(verifyPreviewToken(token, revisionOnlyEdit), false);

        const recipientOnlyEdit = buildChangeOrderSendPreviewPayload({
            ...base,
            recipients: { ...base.recipients, additional: ["changed@example.test"] },
        });
        assert.equal(verifyPreviewToken(token, recipientOnlyEdit), false);

        const nextPreviewGeneration = buildChangeOrderSendPreviewPayload({
            ...base,
            generation: "22222222-2222-4222-8222-222222222222",
        });
        assert.equal(verifyPreviewToken(token, nextPreviewGeneration), false);
    } finally {
        if (priorSecret === undefined) delete process.env.MCP_SECRET;
        else process.env.MCP_SECRET = priorSecret;
    }
});

test("the change-order confirmation token carries its signed preview generation", () => {
    const wrapped = formatChangeOrderConfirmToken(base.generation, "0123456789abcdef0123");
    assert.deepEqual(parseChangeOrderConfirmToken(wrapped), {
        generation: base.generation,
        signature: "0123456789abcdef0123",
    });
    assert.equal(parseChangeOrderConfirmToken("missing-generation"), null);
    assert.equal(parseChangeOrderConfirmToken("not-a-uuid.0123456789abcdef0123"), null);
});

test("change-order recipients canonicalize the full primary and additional set", () => {
    assert.deepEqual(
        canonicalChangeOrderRecipients(" Client@Example.Test ", " second@example.test "),
        { primary: "client@example.test", additional: ["second@example.test"] },
    );
    assert.deepEqual(
        canonicalChangeOrderRecipients("client@example.test", " CLIENT@example.test "),
        { primary: "client@example.test", additional: [] },
    );
});

test("preview tokens require a nonempty actor secret and support Richard-only configuration", () => {
    const payload = buildChangeOrderSendPreviewPayload(base);
    assert.throws(() => mintPreviewToken(payload, ""), /preview token secret is not configured/i);
    assert.equal(verifyPreviewToken("not-a-token", payload, ""), false);

    const richardSecret = "disposable-richard-only-secret";
    const token = mintPreviewToken(payload, richardSecret);
    assert.equal(verifyPreviewToken(token, payload, richardSecret), true);
    assert.equal(verifyPreviewToken(token, payload, "different-secret"), false);
});

test("MCP describes automatic fixed approval delivery and exposes prior-send state", () => {
    const route = readFileSync("src/app/api/mcp/[transport]/route.ts", "utf8");
    assert.doesNotMatch(route, /Once the customer signs \(status Approved\), bill_change_order puts it on the invoice/);
    assert.doesNotMatch(route, /fixed orders bill directly → send_milestone_invoice emails the payment link/);
    assert.match(route, /fixed-price approval automatically bills/i);
    assert.match(route, /qbInvoiceSentAt/);
    assert.match(route, /automaticApprovalDelivery/);
});
