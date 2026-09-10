import assert from "node:assert/strict";
import test from "node:test";
import { DISPATCHABLE_ROLES, isDispatchable } from "@/lib/dispatch-roster";

test("flag on + ACTIVATED is dispatchable for every configured dispatch role", () => {
    for (const role of DISPATCHABLE_ROLES) {
        assert.equal(isDispatchable({ role, status: "ACTIVATED", showOnDispatch: true }), true, role);
    }
});

test("flag off is never dispatchable, regardless of role or status", () => {
    for (const role of ["FIELD_CREW", "MANAGER", "ADMIN"]) {
        assert.equal(isDispatchable({ role, status: "ACTIVATED", showOnDispatch: false }), false, role);
    }
});

test("FINANCE is never dispatchable, even with the flag on", () => {
    assert.equal(isDispatchable({ role: "FINANCE", status: "ACTIVATED", showOnDispatch: true }), false);
    assert.equal(isDispatchable({ role: "FINANCE", showOnDispatch: true }), false);
});

test("a non-ACTIVATED status (PENDING/DISABLED/null) is excluded even with the flag on", () => {
    assert.equal(isDispatchable({ role: "FIELD_CREW", status: "PENDING", showOnDispatch: true }), false);
    assert.equal(isDispatchable({ role: "MANAGER", status: "DISABLED", showOnDispatch: true }), false);
    assert.equal(isDispatchable({ role: "ADMIN", status: null, showOnDispatch: true }), false);
});

test("a missing showOnDispatch contract field is rejected by TypeScript and is not dispatchable at runtime", () => {
    // @ts-expect-error showOnDispatch is a required shared data contract.
    assert.equal(isDispatchable({ role: "FIELD_CREW", status: "ACTIVATED" }), false);
});

test("an undefined status is treated as ACTIVATED (pre-filtered callers)", () => {
    assert.equal(isDispatchable({ role: "FIELD_CREW", showOnDispatch: true }), true);
    assert.equal(isDispatchable({ role: "MANAGER", showOnDispatch: true }), true);
    assert.equal(isDispatchable({ role: "ADMIN", showOnDispatch: true }), true);
});
