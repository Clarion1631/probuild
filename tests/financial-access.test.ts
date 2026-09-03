/**
 * WHO MAY ACT ON MONEY (round 15, finding 1 — a P0).
 *
 * Every gate on the payroll and integration surface asked one question:
 *
 *     user.role === "ADMIN" || hasPermission(user, "financialReports")
 *
 * which authorizes ANY role carrying the permission. `financialReports` is in
 * ASSIGNABLE_PERMISSIONS, so an admin can grant it — and nothing stopped it
 * being granted to a portal CLIENT. That customer could then read the whole
 * company's pay rates, download the Gusto export, mutate rates through the
 * payroll actions, and reconfigure the Gusto and QuickBooks integrations,
 * including their OAuth credentials.
 *
 * Round 8 closed this class for the SUBJECT of a payroll record ("a customer
 * cannot be given a pay rate") and round 14 for a Gusto MAPPING KEY. This is
 * the VIEWER half.
 *
 * THE GATES, all now composing one predicate:
 *   1. src/lib/actions.ts             requirePayrollAccess (every payroll action)
 *   2. src/app/api/payroll/roster     GET (pay rates for the panel)
 *   3. .../time-entries/export/gusto  GET (the payroll CSV)
 *   4. src/lib/integration-access.ts  requireIntegrationAccess + canAccessIntegrations
 *                                     (Gusto + QuickBooks auth/callback/sync/mappings)
 *   5. src/lib/pay-rate-write.ts      canWriteRates (the ONE rate writer)
 *   6. .../time-entries + .../[id]    canSeePay (labor/burden cost on a punch)
 *
 * ...and the GRANTING end is closed too: checkUserMutation refuses putting a
 * privileged permission on a non-staff account at all, so the row cannot exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canActOnFinancials, canActOnFinancialsResolved, FINANCIAL_PERMISSION } from "../src/lib/financial-access";
import { checkUserMutation, ASSIGNABLE_PERMISSIONS, PRIVILEGED_PERMISSIONS } from "../src/lib/user-mutation-guard";
import { PAYROLL_STAFF_ROLES } from "../src/lib/payroll-config";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-financial-access";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

const WITH = { [FINANCIAL_PERMISSION]: true };

test("a CLIENT carrying financialReports is REFUSED — the hole", () => {
    // The exact row an admin could create: a portal customer with the payroll
    // checkbox ticked. Every gate above reads this predicate.
    assert.equal(canActOnFinancials({ role: "CLIENT", permissions: WITH }), false);
    assert.equal(canActOnFinancialsResolved("CLIENT", true), false);

    // ...and the pre-fix expression, spelled out, to show what it answered.
    const preFix = (role: string, perm: boolean) => role === "ADMIN" || perm;
    assert.equal(preFix("CLIENT", true), true, "this is what every gate used to compute");
});

test("staff still pass — the gate is not a blanket refusal", () => {
    assert.equal(canActOnFinancials({ role: "ADMIN", permissions: null }), true, "ADMIN needs no permission row");
    assert.equal(canActOnFinancials({ role: "FINANCE", permissions: WITH }), true);
    // hasPermission grants ADMIN and MANAGER unconditionally (access-rules.ts),
    // so a MANAGER passes without an explicit grant. Unchanged by this fix.
    assert.equal(canActOnFinancials({ role: "MANAGER", permissions: null }), true);
    // And a staff member WITHOUT it is still refused, so the permission half is
    // doing work too.
    assert.equal(canActOnFinancials({ role: "FINANCE", permissions: { financialReports: false } }), false);
    assert.equal(canActOnFinancials({ role: "FIELD_CREW", permissions: null }), false);
    assert.equal(canActOnFinancials(null), false);
    assert.equal(canActOnFinancials(undefined), false);
});

test("the staff half is an ALLOWLIST — a future non-staff role is refused by default", () => {
    // `role !== "CLIENT"` would be correct only until the next non-staff login
    // exists, and the failure would be silent.
    assert.equal(canActOnFinancialsResolved("SUBCONTRACTOR", true), false);
    assert.equal(canActOnFinancialsResolved("VENDOR", true), false);
    assert.equal(canActOnFinancialsResolved(null, true), false);
    assert.equal(canActOnFinancialsResolved(undefined, true), false);
    // It is the SAME allowlist the payroll subject-side checks use.
    for (const role of PAYROLL_STAFF_ROLES) {
        assert.equal(canActOnFinancialsResolved(role, true), true, role);
    }
});

test("every gate on the surface composes the shared predicate", () => {
    // The pure cases above prove the RULE; this proves it is the one each gate
    // asks. A gate that keeps its own copy is how six of them agreed on the
    // wrong answer for this long.
    const root = path.join(__dirname, "..");
    const GATES = [
        ["src/lib/actions.ts", "requirePayrollAccess"],
        ["src/app/api/payroll/roster/route.ts", "the payroll roster endpoint"],
        ["src/app/api/time-entries/export/gusto/route.ts", "the Gusto export endpoint"],
        ["src/lib/integration-access.ts", "requireIntegrationAccess"],
        ["src/lib/pay-rate-write.ts", "canWriteRates"],
        ["src/app/api/time-entries/route.ts", "canSeePay on the list endpoint"],
        ["src/app/api/time-entries/[id]/route.ts", "canSeePay on the detail endpoint"],
    ] as const;

    for (const [file, what] of GATES) {
        const source = readFileSync(path.join(root, file), "utf8");
        assert.match(source, /canActOnFinancials(Resolved)?\(/, `${what} (${file}) must compose the shared predicate`);
        // And no gate keeps the old two-part expression alongside it.
        assert.ok(
            !/role !== "ADMIN" && !hasPermission\([^)]*"financialReports"\)/.test(source),
            `${what} (${file}) still hand-rolls the old gate`
        );
        assert.ok(
            !/role === "ADMIN" \|\| hasPermission\([^)]*"financialReports"\)/.test(source),
            `${what} (${file}) still hand-rolls the old gate`
        );
    }
});

test("the shared gate lives in ONE file, and reads staff-then-permission", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "financial-access.ts"), "utf8");
    // STAFF FIRST, and as an early return — not an `&&` that a later edit can
    // reorder into a short-circuit that never runs.
    assert.match(source, /if \(!isPayrollEligibleRole\(role\)\) return false;/);
    const body = source.slice(source.indexOf("export function canActOnFinancialsResolved"));
    assert.ok(
        body.indexOf("isPayrollEligibleRole") < body.indexOf(`role === "ADMIN"`),
        "the staff check must come first — an ADMIN short-circuit above it would let a CLIENT through"
    );
});

// ---------------------------------------------------------------------------
// The GRANTING end
// ---------------------------------------------------------------------------

const ADMIN = { id: "u-admin", role: "ADMIN" };

test("a privileged permission cannot be GRANTED to a non-staff account at all", () => {
    // Closing the reading end is the guarantee; this stops the row existing.
    for (const key of PRIVILEGED_PERMISSIONS) {
        const verdict = checkUserMutation({
            actor: ADMIN,
            target: { id: "u-client", role: "CLIENT" },
            changes: { permissions: { [key]: true } },
        });
        assert.equal(verdict.ok, false, key);
        // 400, not 403: an ADMIN doing this is making a mistake, not exceeding
        // their authority, and saying so is more useful than "forbidden".
        assert.equal((verdict as { status: number }).status, 400, key);
        assert.match((verdict as { error: string }).error, new RegExp(key));
    }
});

test("...and an ordinary permission on a client is still allowed, as are staff grants", () => {
    // The control. Without it "everything is refused" would pass just as well.
    const ordinary = ASSIGNABLE_PERMISSIONS.filter(
        (key) => !(PRIVILEGED_PERMISSIONS as readonly string[]).includes(key)
    );
    assert.ok(ordinary.length > 0);
    assert.deepEqual(
        checkUserMutation({
            actor: ADMIN,
            target: { id: "u-client", role: "CLIENT" },
            changes: { permissions: { [ordinary[0]]: true } },
        }),
        { ok: true }
    );
    // And a staff target may still be granted the privileged one by an admin.
    assert.deepEqual(
        checkUserMutation({
            actor: ADMIN,
            target: { id: "u-finance", role: "FINANCE" },
            changes: { permissions: { financialReports: true } },
        }),
        { ok: true }
    );
});
