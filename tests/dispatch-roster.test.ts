import assert from "node:assert/strict";
import test from "node:test";
import { DISPATCHABLE_ROLES, isDispatchable } from "@/lib/dispatch-roster";

test("FIELD_CREW, MANAGER, and ADMIN are dispatchable when ACTIVATED", () => {
    for (const role of DISPATCHABLE_ROLES) {
        assert.equal(isDispatchable({ role, status: "ACTIVATED" }), true, role);
    }
});

test("FINANCE is never dispatchable, regardless of status", () => {
    assert.equal(isDispatchable({ role: "FINANCE", status: "ACTIVATED" }), false);
    assert.equal(isDispatchable({ role: "FINANCE" }), false);
});

test("a non-ACTIVATED status (PENDING/DISABLED) is excluded", () => {
    assert.equal(isDispatchable({ role: "FIELD_CREW", status: "PENDING" }), false);
    assert.equal(isDispatchable({ role: "MANAGER", status: "DISABLED" }), false);
    assert.equal(isDispatchable({ role: "ADMIN", status: null }), false);
});

test("an undefined status is treated as ACTIVATED (pre-filtered callers)", () => {
    assert.equal(isDispatchable({ role: "FIELD_CREW" }), true);
    assert.equal(isDispatchable({ role: "MANAGER" }), true);
    assert.equal(isDispatchable({ role: "ADMIN" }), true);
});
