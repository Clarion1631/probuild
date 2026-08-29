import assert from "node:assert/strict";
import test from "node:test";

import { PROCUREMENT_TABLES, targetMatches } from "../scripts/apply-procurement-material-item.mjs";

test("guarded procurement DDL accepts only the expected database and host", () => {
  assert.equal(targetMatches({ db: "probuild", host: "db.example.com" }, "probuild", "db.example.com"), true);
  assert.equal(targetMatches({ db: "other", host: "db.example.com" }, "probuild", "db.example.com"), false);
  assert.equal(targetMatches({ db: "probuild", host: "wrong.example.com" }, "probuild", "db.example.com"), false);
});

test("guarded procurement DDL contains all and only the V1 additive tables", () => {
  assert.deepEqual(PROCUREMENT_TABLES, [
    "MaterialImportRun",
    "MaterialImportRow",
    "MaterialItem",
    "MaterialItemEvidence",
    "MaterialItemEvent",
    "MaterialItemPurchaseOrderItem",
    "MaterialItemExpense",
    "MaterialItemSource",
    "ProcurementAuthorityConfig",
  ]);
});
