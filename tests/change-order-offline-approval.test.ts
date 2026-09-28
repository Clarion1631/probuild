/**
 * Pure helpers for the office-side "Mark approved" flow, plus source-shape
 * checks for the server action gate. Hermetic: no database, no network.
 * Examples are generic (CO-000NN, Jordan Lee) because the repo is public.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    OFFLINE_APPROVAL_METHODS,
    isOfflineApproval,
    offlineApprovalSummary,
    offlineHoldMilestoneWhere,
    parseOfflineApprovalInput,
} from "../src/lib/change-order-offline-approval";

const UTC = "UTC";
// 2026-09-29 03:30 UTC is still 2026-09-28 in Los Angeles (UTC-7 in September).
const NOW = new Date("2026-09-29T03:30:00.000Z");
const LA = "America/Los_Angeles";

test("T1: every listed method is accepted, unknown or empty is rejected", () => {
    for (const row of OFFLINE_APPROVAL_METHODS) {
        const parsed = parseOfflineApprovalInput({ method: row.value, approvedOn: "2026-09-28" }, { now: NOW, timeZone: LA });
        assert.equal(parsed.method, row.value);
    }
    assert.deepEqual(OFFLINE_APPROVAL_METHODS.map((row) => row.value), ["PHONE", "TEXT", "EMAIL", "IN_PERSON", "OTHER"]);
    for (const bad of ["", "SMOKE_SIGNAL", undefined, null, 5, "phone"]) {
        assert.throws(() => parseOfflineApprovalInput({ method: bad, approvedOn: "2026-09-28" }, { now: NOW, timeZone: LA }), /Choose how the customer approved/);
    }
});

test("T1: today and past dates are accepted, tomorrow and impossible dates are rejected", () => {
    const ctx = { now: NOW, timeZone: LA };
    assert.equal(parseOfflineApprovalInput({ method: "PHONE", approvedOn: "2026-09-28" }, ctx).approvedOn, "2026-09-28");
    assert.equal(parseOfflineApprovalInput({ method: "PHONE", approvedOn: "2026-01-02" }, ctx).approvedOn, "2026-01-02");
    assert.throws(() => parseOfflineApprovalInput({ method: "PHONE", approvedOn: "2026-09-29" }, ctx), /can't be in the future/);
    assert.throws(() => parseOfflineApprovalInput({ method: "PHONE", approvedOn: "2026-02-30" }, ctx), /valid approval date/);
    assert.throws(() => parseOfflineApprovalInput({ method: "PHONE", approvedOn: "" }, ctx), /valid approval date/);
    assert.throws(() => parseOfflineApprovalInput({ method: "PHONE", approvedOn: "09/28/2026" }, ctx), /valid approval date/);
});

test("T1: the future boundary follows the company zone, not UTC", () => {
    // In UTC it is already the 29th; in Los Angeles it is still the 28th.
    assert.equal(parseOfflineApprovalInput({ method: "TEXT", approvedOn: "2026-09-29" }, { now: NOW, timeZone: UTC }).approvedOn, "2026-09-29");
    assert.throws(() => parseOfflineApprovalInput({ method: "TEXT", approvedOn: "2026-09-29" }, { now: NOW, timeZone: LA }), /future/);
});

test("T1: the note is trimmed, empty becomes null, 1,001 characters is rejected", () => {
    const base = { method: "EMAIL", approvedOn: "2026-09-28" };
    const ctx = { now: NOW, timeZone: LA };
    assert.equal(parseOfflineApprovalInput({ ...base, note: "  approved on a call  " }, ctx).note, "approved on a call");
    assert.equal(parseOfflineApprovalInput({ ...base, note: "   " }, ctx).note, null);
    assert.equal(parseOfflineApprovalInput({ ...base }, ctx).note, null);
    assert.equal(parseOfflineApprovalInput({ ...base, note: null }, ctx).note, null);
    assert.equal(parseOfflineApprovalInput({ ...base, note: "x".repeat(1000) }, ctx).note?.length, 1000);
    assert.throws(() => parseOfflineApprovalInput({ ...base, note: "x".repeat(1001) }, ctx), /at most 1000/);
});

test("T1: approvedAt is company-local noon of the entered date", () => {
    const parsed = parseOfflineApprovalInput({ method: "PHONE", approvedOn: "2026-09-20" }, { now: NOW, timeZone: LA });
    // Noon PDT is 19:00 UTC.
    assert.equal(parsed.approvedAt.toISOString(), "2026-09-20T19:00:00.000Z");
});

test("T1: the summary label renders the company-zone date, not the UTC date", () => {
    // 2026-09-21 02:00 UTC is still Sep 20 in Los Angeles.
    const label = offlineApprovalSummary(
        { approvedBy: "Jordan Lee", approvedAt: new Date("2026-09-21T02:00:00.000Z"), approvalMethod: "PHONE" },
        LA,
    );
    assert.equal(label, "Approved by Jordan Lee on Sep 20, 2026 (by phone)");
    assert.equal(
        offlineApprovalSummary({ approvedBy: "Jordan Lee", approvedAt: new Date("2026-09-21T02:00:00.000Z"), approvalMethod: "IN_PERSON" }, UTC),
        "Approved by Jordan Lee on Sep 21, 2026 (in person)",
    );
});

test("T1: isOfflineApproval only matches the OFFLINE source", () => {
    assert.equal(isOfflineApproval({ approvalSource: "OFFLINE" }), true);
    assert.equal(isOfflineApproval({ approvalSource: null }), false);
    assert.equal(isOfflineApproval({}), false);
    assert.equal(isOfflineApproval(null), false);
});

test("T1: the reminder hold is undefined for no ids and the null-safe three-way OR otherwise", () => {
    assert.equal(offlineHoldMilestoneWhere([]), undefined);
    assert.deepEqual(offlineHoldMilestoneWhere(["co-1", "co-2"]), {
        OR: [
            { sourceChangeOrderId: null },
            { sourceChangeOrderId: { notIn: ["co-1", "co-2"] } },
            { qbInvoiceSentAt: { not: null } },
        ],
    });
});

// ── T5: the server action's gate, checked from the source ───────────────────

function actionBody(): string {
    const src = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const start = src.indexOf("export async function markChangeOrderApprovedOffline(");
    assert.ok(start > 0, "markChangeOrderApprovedOffline must exist");
    return src.slice(start);
}

test("T5: the action gates on permission, then ADMIN/MANAGER, then project access, before any read or write", () => {
    const body = actionBody();
    const permission = body.indexOf("assertChangeOrderPermission()");
    const role = body.indexOf("isAdminOrManager(user)");
    const project = body.indexOf("canAccessProject(user");
    const firstDbRead = body.indexOf("prisma.changeOrder.findUnique");
    const core = body.indexOf("approveChangeOrderOfflineCore");
    assert.ok(permission > 0 && role > permission && project > role, "gate order");
    assert.ok(firstDbRead > role, "the role gate precedes the first database read");
    assert.ok(core > project, "the core runs only after every gate");
    assert.match(body, /throw new Error\("Forbidden"\)/);
});

test("T5: the approver comes from the session, never from client input", () => {
    const body = actionBody();
    assert.match(body, /actor: \{ userId: user\.id, name: user\.name\?\.trim\(\) \|\| user\.email \}/);
    assert.doesNotMatch(body, /input\??\.(approvedBy|actor|name)/);
});

test("T5: the action is the last export of actions.ts, so no line-keyed manifest moves", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const exports = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    assert.equal(exports[exports.length - 1], "markChangeOrderApprovedOffline");
});
