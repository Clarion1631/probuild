import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseProcurementXlsx } from "../src/lib/procurement-import";

const fixture = (name: string) => path.join(process.cwd(), "tests", "fixtures", "procurement", "xlsx", name);

test("layout v1 stages a valid material row with an immutable input hash", async () => {
  const parsed = await parseProcurementXlsx(await fs.readFile(fixture("layout-v1-minimal.xlsx")));

  assert.equal(parsed.layoutVersion, "v1");
  assert.equal(parsed.sourceSheetName, "Materials");
  assert.equal(parsed.headerRowNumber, 1);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].description, "Kitchen faucet");
  assert.equal(parsed.rows[0].sourceProjectRef, "Christensen Remodel");
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
});

test("layout v2 preserves a blank source project as a data gap instead of guessing", async () => {
  const parsed = await parseProcurementXlsx(await fs.readFile(fixture("layout-v2-data-gap.xlsx")));

  assert.equal(parsed.layoutVersion, "v2");
  assert.equal(parsed.sourceSheetName, "Materials");
  assert.equal(parsed.headerRowNumber, 1);
  assert.equal(parsed.rows[0].sourceProjectRef, null);
  assert.equal(parsed.rows[0].rowNumber, 2);
});

test("unsupported headers fail before an import run can be staged", async () => {
  const bytes = await fs.readFile(fixture("unsupported-layout.xlsx"));
  await assert.rejects(
    () => parseProcurementXlsx(bytes),
    /Unsupported procurement XLSX layout/,
  );
});
