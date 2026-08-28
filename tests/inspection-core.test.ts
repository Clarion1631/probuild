import assert from "node:assert/strict";
import { test } from "node:test";

import {
    assertInspectionLinksBelongToProject,
    defaultInspectionShare,
    inspectionResult,
    parseInspectionDate,
    requireInspectionDate,
} from "../src/lib/inspection-core";

test("inspection result and date rules reject incomplete evidence", () => {
    assert.equal(inspectionResult("PASSED"), "PASSED");
    assert.throws(() => inspectionResult("DRAFT"), /Invalid inspection result/);
    assert.throws(() => requireInspectionDate("SCHEDULED", null, null), /scheduled date/);
    assert.throws(() => requireInspectionDate("PASSED", null, null), /performed date/);
    assert.equal(parseInspectionDate("2026-08-26", "Date")?.toISOString(), "2026-08-26T00:00:00.000Z");
    assert.throws(() => parseInspectionDate("2026-02-30", "Date"), /invalid/);
});

test("passed inspections share by default and explicit manager choices win", () => {
    assert.equal(defaultInspectionShare("PASSED", undefined), true);
    assert.equal(defaultInspectionShare("FAILED", undefined), false);
    assert.equal(defaultInspectionShare("PASSED", false), false);
    assert.equal(defaultInspectionShare("PARTIAL", true), true);
});

test("inspection links are rejected when they do not belong to the project", async () => {
    const queries: unknown[] = [];
    const db = {
        permit: { findFirst: async (query: { where: { id: string; projectId: string }; select: { id: true } }) => { queries.push(query); return null; } },
        scheduleTask: { findFirst: async (query: { where: { id: string; projectId: string }; select: { id: true } }) => { queries.push(query); return { id: "task-ok" }; } },
    };

    await assert.rejects(
        assertInspectionLinksBelongToProject(db, "project-a", "permit-other-project", null),
        /permitId does not belong/,
    );
    assert.deepEqual(queries, [{ where: { id: "permit-other-project", projectId: "project-a" }, select: { id: true } }]);

    const taskDb = {
        permit: { findFirst: async () => ({ id: "permit-ok" }) },
        scheduleTask: { findFirst: async (query: { where: { id: string; projectId: string }; select: { id: true } }) => { queries.push(query); return null; } },
    };
    await assert.rejects(
        assertInspectionLinksBelongToProject(taskDb, "project-a", null, "task-other-project"),
        /scheduleTaskId does not belong/,
    );
});
