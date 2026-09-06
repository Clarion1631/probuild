import assert from "node:assert/strict";
import test from "node:test";

import { isIncomingEvidenceSource } from "@/lib/bank-image-sources";

test("incoming WTB evidence is excluded from matching sources", () => {
    assert.equal(isIncomingEvidenceSource("WTB_ONLINE_INCOMING"), true);
    assert.equal(isIncomingEvidenceSource("WTB_ONLINE"), false);
    assert.equal(isIncomingEvidenceSource("WTB_STATEMENT"), false);
});
