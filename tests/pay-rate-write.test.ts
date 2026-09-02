/**
 * The ONE pay-rate write path (src/lib/pay-rate-write.ts).
 *
 * Rates used to be written from three routes, each with its own permission
 * check, its own Number() conversion, and only one of them stamping
 * lastRateSyncAt. These tests pin the single path: who may write, what parses,
 * and that the staleness stamp cannot be skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRateChange, canWriteRates } from "../src/lib/pay-rate-write";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-pay-rate-write-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

function fakeClient() {
    const writes: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    return {
        writes,
        client: { user: { update: async (args: any) => { writes.push(args); return {}; } } },
    };
}

const ADMIN = { role: "ADMIN" };
const FINANCE_REPORTS = { role: "FINANCE", permissions: { financialReports: true } };
const PLAIN_MANAGER = { role: "MANAGER", permissions: { financialReports: false } };
const FINANCE_NO_REPORTS = { role: "FINANCE", permissions: { financialReports: false } };
const CREW = { role: "FIELD_CREW", permissions: { financialReports: false } };

test("the rate gate is EXACTLY the payroll export's gate", () => {
    assert.equal(canWriteRates(ADMIN), true);
    assert.equal(canWriteRates(FINANCE_REPORTS), true);
    // A FINANCE user WITHOUT financialReports is refused — that is the part
    // Phase 5 tightened.
    assert.equal(canWriteRates(FINANCE_NO_REPORTS), false);
    assert.equal(canWriteRates(CREW), false);
    assert.equal(canWriteRates(null), false);
    // A MANAGER passes, because hasPermission grants managers everything
    // app-wide (access-rules.ts). Not a new grant — managers could already
    // write rates — and deliberately identical to the export's own check so the
    // rates panel and the download cannot disagree about who may act.
    assert.equal(canWriteRates(PLAIN_MANAGER), true);
});

test("a payload with no rate fields needs no payroll permission and writes nothing", async () => {
    const { writes, client } = fakeClient();
    const result = await applyRateChange(CREW, "u1", {}, client);
    assert.deepEqual(result, { ok: true, changed: false });
    assert.equal(writes.length, 0, "an ordinary profile edit must not be blocked");
});

test("a caller without payroll access cannot change a rate", async () => {
    const { writes, client } = fakeClient();
    const result = await applyRateChange(CREW, "u1", { hourlyRate: "31.00" }, client);
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 403);
    assert.equal(writes.length, 0);
});

test("every rate write stamps lastRateSyncAt and stores an exact decimal", async () => {
    const { writes, client } = fakeClient();
    const result = await applyRateChange(ADMIN, "u1", { hourlyRate: "28.5", burdenRate: "6" }, client);
    assert.deepEqual(result, { ok: true, changed: true });
    const data = writes[0].data;
    // Prisma.Decimal, not a float — a rate must never round-trip through one.
    assert.equal(String(data.hourlyRate), "28.5");
    assert.equal(String(data.burdenRate), "6");
    assert.ok(data.lastRateSyncAt instanceof Date, "the staleness stamp cannot be skipped");
});

test("sub-cent, exponent and out-of-range rates are refused, not rounded", async () => {
    const { writes, client } = fakeClient();
    for (const bad of ["28.005", "1e2", "-1", "99999", "abc"]) {
        const result = await applyRateChange(ADMIN, "u1", { hourlyRate: bad }, client);
        assert.equal(result.ok, false, bad);
    }
    assert.equal(writes.length, 0);
});

test("pay type rides the same path, and only accepts the two real values", async () => {
    const { writes, client } = fakeClient();
    assert.equal((await applyRateChange(ADMIN, "u1", { payType: "SALARY" }, client)).ok, true);
    assert.equal(writes[0].data.payType, "SALARY");
    // A pay-type-only change is not a rate confirmation, so it does not stamp.
    assert.equal(writes[0].data.lastRateSyncAt, undefined);
    assert.equal((await applyRateChange(ADMIN, "u1", { payType: "GUESS" }, client)).ok, false);
});
