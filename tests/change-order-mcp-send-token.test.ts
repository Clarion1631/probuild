import test from "node:test";
import assert from "node:assert/strict";

import {
    buildChangeOrderSendPreviewPayload,
} from "../src/lib/change-order-send-preview";
import { mintPreviewToken, verifyPreviewToken } from "../src/lib/mcp-preview-token";

const base = {
    changeOrderId: "co-terms-token",
    recipient: "client@example.test",
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
    } finally {
        if (priorSecret === undefined) delete process.env.MCP_SECRET;
        else process.env.MCP_SECRET = priorSecret;
    }
});
