import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// scripts/backfill-crew-assignments.mjs backfilled the old "ACTIVATED
// FIELD_CREW, plus CJ by name" rule, since replaced by the dispatch-board
// switch rule in src/lib/crew-auto-assign.ts (see
// scripts/sync-crew-to-in-progress.mjs). Restating the old script's
// eligibility logic here to compare against the new TS rule would just pin
// staleness, so this now only asserts the script is the deprecated pointer
// it claims to be and performs no writes.

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "backfill-crew-assignments.mjs");
const source = fs.readFileSync(SCRIPT_PATH, "utf8");

test("backfill-crew-assignments.mjs is a deprecated no-op pointing at sync-crew-to-in-progress.mjs", () => {
    assert.match(source, /DEPRECATED/);
    assert.match(source, /sync-crew-to-in-progress\.mjs/);
    assert.ok(!/PrismaClient/.test(source), "the deprecated stub must not touch the database");
    assert.ok(!/\.connect\(/.test(source) && !/\bconnect:/.test(source), "the deprecated stub must not write crew connections");
});
