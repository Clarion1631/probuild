/**
 * Route-level tests for DELETE /api/time-entries/[id] via createDeleteHandler's
 * dependency injection (same pattern as tests/time-entries-clockout-route.test.ts).
 *
 * Pins, per the Codex gate on PR #436: roles with no delete path are refused BEFORE
 * the entry lookup (no 404-vs-403 existence oracle); the owner pre-check maps to 403
 * with a code; a refused claim inside the transaction maps to 409 with a code; the
 * transaction receives the owner guard only for FIELD_CREW.
 *
 * [id]/route.ts imports mobile-auth.ts statically, which throws at module load if
 * NEXTAUTH_SECRET is unset — set it before the dynamic import (no top-level await).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeleteDependencies, DeleteTimeEntryRow } from "../src/app/api/time-entries/[id]/route";
import type { DeleteActor } from "../src/lib/time-entry-delete-policy";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const routeModule = () => import("../src/app/api/time-entries/[id]/route");
const policyModule = () => import("../src/lib/time-entry-delete-policy");

const NOW = new Date();

function entry(overrides: Partial<DeleteTimeEntryRow> = {}): DeleteTimeEntryRow {
    return {
        userId: "u-crew",
        startTime: new Date(NOW.getTime() - 60 * 60_000),
        createdAt: NOW,
        invoiceId: null,
        invoicedAt: null,
        qbTimeActivityId: null,
        qbSyncedAt: null,
        ...overrides,
    };
}

type Calls = { lookups: string[]; deletes: Array<{ id: string; dayKey: string; userId: string; guard: DeleteActor | undefined }> };

function deps(opts: {
    role?: string;
    userId?: string;
    authOk?: boolean;
    entry?: DeleteTimeEntryRow | null;
    /** What the (fake) transaction does: resolve with a result, or throw this error. */
    tx?: "deleted" | "gone" | Error;
}): { dependencies: DeleteDependencies; calls: Calls } {
    const calls: Calls = { lookups: [], deletes: [] };
    const dependencies: DeleteDependencies = {
        authenticate: async () =>
            opts.authOk === false
                ? { ok: false, status: 401, error: "Unauthorized" }
                : { ok: true, user: { id: opts.userId ?? "u-crew", role: opts.role ?? "FIELD_CREW" } },
        findTimeEntry: async (id) => { calls.lookups.push(id); return opts.entry === undefined ? entry() : opts.entry; },
        deleteEntryAndSettle: async (id, dayKey, userId, guard) => {
            calls.deletes.push({ id, dayKey, userId, guard });
            const tx = opts.tx ?? "deleted";
            if (tx instanceof Error) throw tx;
            return tx;
        },
    };
    return { dependencies, calls };
}

const req = () => new Request("https://probuild.test/api/time-entries/te1", { method: "DELETE" });
const ctx = { params: Promise.resolve({ id: "te1" }) };

async function call(d: DeleteDependencies) {
    const { createDeleteHandler } = await routeModule();
    const res = await createDeleteHandler(d)(req(), ctx);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("unauthenticated → 401, nothing looked up", async () => {
    const { dependencies, calls } = deps({ authOk: false });
    const r = await call(dependencies);
    assert.equal(r.status, 401);
    assert.deepEqual(calls.lookups, []);
});

test("FINANCE / unknown roles → 403 BEFORE the lookup (no existence oracle), same body whether or not the entry exists", async () => {
    for (const role of ["FINANCE", "", "SUPERVISOR", "admin"]) {
        const exists = deps({ role, entry: entry() });
        const missing = deps({ role, entry: null });
        const a = await call(exists.dependencies);
        const b = await call(missing.dependencies);
        assert.equal(a.status, 403, role);
        assert.equal(b.status, 403, role);
        assert.deepEqual(a.body, b.body, `${JSON.stringify(role)}: identical response for existing and missing ids`);
        assert.deepEqual(exists.calls.lookups, [], `${JSON.stringify(role)}: never looked up`);
        assert.deepEqual(exists.calls.deletes, []);
    }
});

test("unknown entry → 404 for roles that may delete", async () => {
    for (const role of ["FIELD_CREW", "MANAGER", "ADMIN"]) {
        const { dependencies, calls } = deps({ role, entry: null });
        const r = await call(dependencies);
        assert.equal(r.status, 404, role);
        assert.deepEqual(calls.deletes, [], role);
    }
});

test("FIELD_CREW owner, today, unlinked → 200 and the transaction gets the owner guard", async () => {
    const { dependencies, calls } = deps({ role: "FIELD_CREW", userId: "u-crew" });
    const r = await call(dependencies);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(calls.deletes.length, 1);
    assert.deepEqual(calls.deletes[0].guard, { id: "u-crew", role: "FIELD_CREW" });
    assert.equal(calls.deletes[0].userId, "u-crew");
});

test("FIELD_CREW pre-check refusals → 403 with the policy code, transaction never entered", async () => {
    const { DELETE_REFUSAL_MESSAGES } = await policyModule();
    const yesterday = new Date(NOW.getTime() - 24 * 3_600_000);
    const cases: Array<[Partial<DeleteTimeEntryRow>, string]> = [
        [{ userId: "u-other" }, "NOT_OWNER"],
        [{ createdAt: yesterday }, "NOT_TODAY"],
        [{ invoiceId: "inv1" }, "LOCKED_DOWNSTREAM"],
        [{ qbSyncedAt: NOW }, "LOCKED_DOWNSTREAM"],
    ];
    for (const [overrides, code] of cases) {
        const { dependencies, calls } = deps({ role: "FIELD_CREW", entry: entry(overrides) });
        const r = await call(dependencies);
        assert.equal(r.status, 403, code);
        assert.equal(r.body.code, code);
        assert.equal(r.body.error, DELETE_REFUSAL_MESSAGES[code as keyof typeof DELETE_REFUSAL_MESSAGES]);
        assert.deepEqual(calls.deletes, [], `${code}: transaction not entered`);
    }
});

test("a claim refused INSIDE the transaction → 409 with the code; other errors propagate", async () => {
    const { DeleteRefusedError } = await policyModule();
    for (const code of ["LOCKED_DOWNSTREAM", "NOT_OWNER", "NOT_TODAY", "CLAIM_LOST"] as const) {
        const { dependencies } = deps({ role: "FIELD_CREW", tx: new DeleteRefusedError(code) });
        const r = await call(dependencies);
        assert.equal(r.status, 409, code);
        assert.equal(r.body.code, code);
        assert.equal(typeof r.body.error, "string");
    }
    const boom = deps({ role: "FIELD_CREW", tx: new Error("db down") });
    const { createDeleteHandler } = await routeModule();
    await assert.rejects(createDeleteHandler(boom.dependencies)(req(), ctx), /db down/);
});

test("MANAGER / ADMIN → 200 on anyone's older, invoiced entry, and the transaction gets NO owner guard", async () => {
    for (const role of ["MANAGER", "ADMIN"]) {
        const locked = entry({ userId: "u-other", createdAt: new Date(NOW.getTime() - 3 * 24 * 3_600_000), invoiceId: "inv1", qbSyncedAt: NOW });
        const { dependencies, calls } = deps({ role, userId: "u-mgr", entry: locked });
        const r = await call(dependencies);
        assert.equal(r.status, 200, role);
        assert.equal(calls.deletes.length, 1, role);
        assert.equal(calls.deletes[0].guard, undefined, `${role}: unconditional`);
        assert.equal(calls.deletes[0].userId, "u-other", `${role}: settles the OWNER's day, not the manager's`);
    }
});

test("a row that vanished inside the transaction ('gone') is still a 200 — idempotent DELETE", async () => {
    const { dependencies } = deps({ role: "MANAGER", tx: "gone" });
    const r = await call(dependencies);
    assert.equal(r.status, 200);
});
