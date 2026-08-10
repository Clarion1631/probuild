import { expect, test } from "@playwright/test";
import {
    canAccessEstimate,
    estimateScopeWhere,
    canAccessProject,
    accessibleProjectIds,
    type EstimateOwner,
    type ProjectScopedUser,
} from "../src/lib/access-rules";

/**
 * The list filter and the detail-page assertion have to answer identically for
 * every input, or the estimate list shows rows whose detail page throws
 * Forbidden — the exact bug this pair of PRs closed.
 *
 * The companion spec (financial-action-auth.spec.ts) proves the WIRING: that
 * each action calls the right helper. This one proves the RULE: that the two
 * forms of the rule actually agree. Source-grep assertions cannot catch a
 * predicate that still mentions every expected token but returns the wrong
 * answer, so these tests run the real functions over a truth table.
 */

/** Minimal evaluator for the where-fragment shapes estimateScopeWhere emits. */
function whereAdmits(where: any, row: EstimateOwner & { id: string }): boolean {
    if (where.id?.in) return where.id.in.includes(row.id);
    if (where.OR) return where.OR.some((branch: any) => whereAdmits(branch, row));

    // Leaf branch: every stated key must hold.
    for (const [key, cond] of Object.entries(where) as [keyof EstimateOwner, any][]) {
        const value = row[key] ?? null;
        if (cond === null) {
            if (value !== null) return false;
        } else if (cond?.in) {
            if (value === null || !cond.in.includes(value)) return false;
        } else if (cond && "not" in cond) {
            if (cond.not === null ? value === null : value === cond.not) return false;
        } else if (value !== cond) {
            return false;
        }
    }
    return true;
}

const ADMIN: ProjectScopedUser = { role: "ADMIN" };
const MANAGER: ProjectScopedUser = { role: "MANAGER" };
// FINANCE is deliberately NOT exempt from project scoping for estimates.
const FINANCE_NO_ACCESS: ProjectScopedUser = { role: "FINANCE", permissions: { estimates: true } };
const FINANCE_ON_P1: ProjectScopedUser = {
    role: "FINANCE", permissions: { estimates: true }, projectAccess: [{ projectId: "p1" }],
};
const ESTIMATOR_LEADS: ProjectScopedUser = {
    role: "EMPLOYEE", permissions: { estimates: true, leadAccess: true }, projectAccess: [{ projectId: "p1" }],
};
const LEADS_ONLY: ProjectScopedUser = { role: "EMPLOYEE", permissions: { estimates: true, leadAccess: true } };
const CREW_ON_P2: ProjectScopedUser = {
    role: "FIELD_CREW", permissions: { estimates: true }, assignedProjects: [{ id: "p2" }],
};
const NOBODY: ProjectScopedUser = { role: "EMPLOYEE", permissions: {} };

const USERS: [string, ProjectScopedUser][] = [
    ["ADMIN", ADMIN], ["MANAGER", MANAGER],
    ["FINANCE (no project access)", FINANCE_NO_ACCESS], ["FINANCE (access to p1)", FINANCE_ON_P1],
    ["estimator with p1 + leadAccess", ESTIMATOR_LEADS], ["leadAccess only", LEADS_ONLY],
    ["crew assigned to p2", CREW_ON_P2], ["no access at all", NOBODY],
];

const ROWS: [string, EstimateOwner & { id: string }][] = [
    ["project-owned p1", { id: "e1", projectId: "p1", leadId: null }],
    ["project-owned p2", { id: "e2", projectId: "p2", leadId: null }],
    ["project-owned p9 (nobody has it)", { id: "e3", projectId: "p9", leadId: null }],
    ["lead-owned", { id: "e4", projectId: null, leadId: "l1" }],
    ["converted: lead l1 AND project p1", { id: "e5", projectId: "p1", leadId: "l1" }],
    ["converted: lead l1 AND project p9", { id: "e6", projectId: "p9", leadId: "l1" }],
    ["ownerless", { id: "e7", projectId: null, leadId: null }],
];

test("the estimate list filter and the detail assertion agree on every row", () => {
    for (const [userLabel, user] of USERS) {
        const where = estimateScopeWhere(user);
        for (const [rowLabel, row] of ROWS) {
            expect(
                whereAdmits(where, row),
                `${userLabel} / ${rowLabel}: the list filter and canAccessEstimate must agree`,
            ).toBe(canAccessEstimate(user, row));
        }
    }
});

test("an ownerless estimate is invisible and untouchable for everyone, including admins", () => {
    const ownerless = { id: "e7", projectId: null, leadId: null };
    for (const [label, user] of USERS) {
        expect(canAccessEstimate(user, ownerless), `${label} must not be granted an ownerless estimate`).toBe(false);
        expect(whereAdmits(estimateScopeWhere(user), ownerless), `${label} must not see an ownerless estimate`).toBe(false);
    }
});

test("leadAccess never rescues an estimate on a project the user cannot reach", () => {
    // Converted estimates carry BOTH ids. Project ownership takes precedence,
    // so holding leadAccess must not open another job's numbers.
    const convertedOnUnreachableProject = { id: "e6", projectId: "p9", leadId: "l1" };
    expect(canAccessEstimate(LEADS_ONLY, convertedOnUnreachableProject)).toBe(false);
    expect(whereAdmits(estimateScopeWhere(LEADS_ONLY), convertedOnUnreachableProject)).toBe(false);
    // ...while a purely lead-owned estimate still is reachable.
    expect(canAccessEstimate(LEADS_ONLY, { id: "e4", projectId: null, leadId: "l1" })).toBe(true);
});

test("FINANCE is scoped to its projects for estimates, unlike company-wide reports", () => {
    const onP1 = { id: "e1", projectId: "p1", leadId: null };
    expect(canAccessEstimate(FINANCE_ON_P1, onP1)).toBe(true);
    expect(canAccessEstimate(FINANCE_NO_ACCESS, onP1)).toBe(false);
    expect(whereAdmits(estimateScopeWhere(FINANCE_NO_ACCESS), onP1)).toBe(false);
});

test("ADMIN and MANAGER see every attached estimate", () => {
    for (const admin of [ADMIN, MANAGER]) {
        for (const [label, row] of ROWS) {
            const expected = !!(row.projectId || row.leadId);
            expect(whereAdmits(estimateScopeWhere(admin), row), `${admin.role} / ${label}`).toBe(expected);
        }
    }
});

test("a missing user is treated as no access, never as full access", () => {
    for (const noUser of [null, undefined, {} as any]) {
        const where = estimateScopeWhere(noUser);
        for (const [label, row] of ROWS) {
            expect(whereAdmits(where, row), `absent user must not see ${label}`).toBe(false);
        }
    }
});

test("accessibleProjectIds stays the set form of canAccessProject", () => {
    for (const [label, user] of USERS) {
        const ids = accessibleProjectIds(user);
        for (const projectId of ["p1", "p2", "p9"]) {
            const fromSet = ids === "ALL" || ids.includes(projectId);
            expect(fromSet, `${label} / ${projectId}`).toBe(canAccessProject(user, projectId));
        }
    }
});
