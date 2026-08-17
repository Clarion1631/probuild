import test from "node:test";
import assert from "node:assert/strict";

import { approveChangeOrderWithSignature } from "../src/lib/change-order-approval";

const approvalInput = {
    signatureName: "Client Signer",
    signatureDataUrl: "data:image/png;base64,AA==",
    approvedAt: new Date("2026-08-16T12:00:00.000Z"),
    expectedRevision: 4,
    expectedTaxFingerprint: "[]",
};

function uploadedSignature() {
    let discardCount = 0;
    return {
        url: "secure-doc://change-orders/co-1/client/signature.png",
        get discardCount() {
            return discardCount;
        },
        persistSignature: async () => ({
            url: "secure-doc://change-orders/co-1/client/signature.png",
            discard: async () => { discardCount += 1; },
        }),
    };
}

test("ambiguous approve failure keeps an upload that the committed change order references", async () => {
    const upload = uploadedSignature();
    const primaryError = new Error("connection dropped after commit");
    const probes: Array<{ id: string; url: string }> = [];

    await assert.rejects(
        approveChangeOrderWithSignature("co-1", approvalInput, {
            persistSignature: upload.persistSignature,
            approveCore: async () => { throw primaryError; },
            isSignatureReferenced: async (id: string, url: string) => {
                probes.push({ id, url });
                return true;
            },
        }),
        (error) => error === primaryError,
    );

    assert.deepEqual(probes, [{ id: "co-1", url: upload.url }]);
    assert.equal(upload.discardCount, 0);
});

test("ambiguous approve failure keeps an upload when the reference probe outcome is unknown", async () => {
    const upload = uploadedSignature();
    const primaryError = new Error("approval outcome unknown");

    await assert.rejects(
        approveChangeOrderWithSignature("co-1", approvalInput, {
            persistSignature: upload.persistSignature,
            approveCore: async () => { throw primaryError; },
            isSignatureReferenced: async () => { throw new Error("probe unavailable"); },
        }),
        (error) => error === primaryError,
    );

    assert.equal(upload.discardCount, 0);
});

test("ambiguous approve failure discards an upload only after proving it is unreferenced", async () => {
    const upload = uploadedSignature();
    const primaryError = new Error("transaction rejected before commit");

    await assert.rejects(
        approveChangeOrderWithSignature("co-1", approvalInput, {
            persistSignature: upload.persistSignature,
            approveCore: async () => { throw primaryError; },
            isSignatureReferenced: async () => false,
        }),
        (error) => error === primaryError,
    );

    assert.equal(upload.discardCount, 1);
});
