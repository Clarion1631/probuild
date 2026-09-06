import assert from "node:assert/strict";
import test from "node:test";

import { isValidBankImageIngestKey } from "@/lib/bank-image-auth";

test("bank-image ingest accepts only its dedicated x-ingest-key", () => {
    const secret = "dedicated-bank-image-secret";
    assert.equal(isValidBankImageIngestKey(secret, secret), true);
    assert.equal(isValidBankImageIngestKey("wrong", secret), false);
    assert.equal(isValidBankImageIngestKey(null, secret), false);
    assert.equal(isValidBankImageIngestKey(secret, undefined), false);
});
