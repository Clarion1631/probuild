/**
 * Attribution matrix for time-entry edits (src/lib/time-entry-edit-audit.ts), pinned
 * per Codex gate on PR #437: every privileged edit is stamped — a manager editing
 * their OWN punch included — while a worker's self-edit carries no manager stamp.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { privilegedEditStamp } from "../src/lib/time-entry-edit-audit";

const NOW = new Date("2026-08-31T17:00:00.000Z");

test("manager editing someone else's punch is stamped", () => {
    assert.deepEqual(privilegedEditStamp("u-mgr", true, NOW), { editedByManagerId: "u-mgr", editedAt: NOW });
});

test("manager editing their OWN punch is stamped too (self-edits must not read as Original)", () => {
    // The caller passes isPrivileged only — ownership deliberately plays no part.
    assert.deepEqual(privilegedEditStamp("u-mgr", true, NOW), { editedByManagerId: "u-mgr", editedAt: NOW });
});

test("worker editing their own punch gets no manager stamp", () => {
    assert.deepEqual(privilegedEditStamp("u-crew", false, NOW), {});
});
