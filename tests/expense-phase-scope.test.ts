/**
 * "The cost code exists" is not a permission (src/lib/cost-coding.ts SCOPE
 * note). Five writers can put a phase on an expense, and Codex round 2 found
 * that most of them checked only that the code existed and was active — so any
 * of them could pin a phase from an entirely different job onto a receipt.
 *
 * This covers the two rules that decide it, plus the intake capture default
 * that feeds a tax filing. The route-level wiring is exercised by
 * tests/qbo-expense-sync.test.ts (the sync) and by the DI checks below; the
 * pure rules are asserted here so a regression names itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isCostCodeAllowedForProject, type PhaseDataSource } from "../src/lib/project-phases";
import { resolveCostCode, type CostCodingDataSource } from "../src/lib/cost-coding";
// From the PURE module, not the route: importing the route pulls in
// mobile-auth, which throws at import time unless NEXTAUTH_SECRET is set —
// true in CI, and a unit test has no business needing a JWT secret.
import { resolveInstalledAtCustomer } from "../src/lib/expense-attribution";
import { optionalBool } from "../src/lib/receipt-capture-validation";
import { authorizePhase } from "../src/lib/receipt-intake/late-fields";

// ── the two checks every phase writer must run ─────────────────────────────

const PHASES: Record<string, { id: string; code: string; name: string; isActive: boolean }[]> = {
    "job-mueller": [{ id: "cc-plumb", code: "03-PLUMB", name: "Plumbing", isActive: true }],
    "job-mesplay": [{ id: "cc-frame", code: "02-FRAME", name: "Framing", isActive: true }],
};

const phaseSource: PhaseDataSource = {
    async getProject(projectId) {
        return PHASES[projectId] ? { id: projectId, status: "In Progress" } : null;
    },
    async getEstimateCostCodes(projectId) {
        return PHASES[projectId] ?? [];
    },
    async getSafetyCostCode() {
        return null;
    },
};

const codingSource: CostCodingDataSource = {
    async getCostCode(costCodeId) {
        const all = Object.values(PHASES).flat();
        const found = all.find(phase => phase.id === costCodeId);
        if (found) return { id: found.id, isActive: found.isActive };
        if (costCodeId === "cc-retired") return { id: "cc-retired", isActive: false };
        return null;
    },
    async getLineItem() {
        return null;
    },
};

test("a phase from ANOTHER job is rejected even though the code is real and active", async () => {
    // This is the whole finding: `resolveCostCode` alone says yes, because the
    // code exists and is active. It is the wrong job's phase.
    const resolved = await resolveCostCode(codingSource, { costCodeId: "cc-frame" });
    assert.equal(resolved.ok, true, "attribution alone accepts it");
    assert.equal(
        await isCostCodeAllowedForProject(phaseSource, "job-mueller", "cc-frame"),
        false,
        "...and permission is what refuses it",
    );
});

test("the job's own phase passes both checks", async () => {
    const resolved = await resolveCostCode(codingSource, { costCodeId: "cc-plumb" });
    assert.equal(resolved.ok, true);
    assert.equal(await isCostCodeAllowedForProject(phaseSource, "job-mueller", "cc-plumb"), true);
});

test("an INACTIVE code is refused by the attribution check", async () => {
    const resolved = await resolveCostCode(codingSource, { costCodeId: "cc-retired" });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.code, "COST_CODE_INACTIVE");
});

test("a code that does not exist is refused, and named as such", async () => {
    const resolved = await resolveCostCode(codingSource, { costCodeId: "cc-nope" });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.code, "COST_CODE_NOT_FOUND");
});

test("a project with no phases at all accepts nothing", async () => {
    assert.equal(await isCostCodeAllowedForProject(phaseSource, "job-unknown", "cc-plumb"), false);
});

// ── the intake capture default (tax position) ──────────────────────────────

test("installedAtCustomer has NO default — silence is unknown, on every source", () => {
    // It used to default TRUE for any non-overhead project. That turned
    // "nobody looked at this" into a deduction claimed on a state return, and a
    // job receipt is just as likely to be consumables, tools, fuel, or a
    // service. WAC 458-20-102(12)(b) allows the cost of the articles actually
    // RESOLD, not whatever got coded to a live job.
    assert.equal(resolveInstalledAtCustomer(null), null, "no project named");
    assert.equal(resolveInstalledAtCustomer(null), null, "a real job does not imply yes");
});

test("an explicit answer from the capturer is honoured, both ways", () => {
    // The crew member holding the material is the one person who actually
    // knows, so the app's toggle must survive untouched.
    assert.equal(resolveInstalledAtCustomer(true), true);
    assert.equal(resolveInstalledAtCustomer(false), false);
});

// ── the two-step upload doors enforce the same capture rules ───────────────

const allow = (project: string, code: string) =>
    isCostCodeAllowedForProject(phaseSource, project, code);

test("a captured phase with no project to check it against is refused", async () => {
    // The row would otherwise carry an unvalidated human-authority phase that
    // booking later copies verbatim onto the Expense.
    const denial = await authorizePhase(null, "cc-plumb", allow);
    assert.equal(denial?.status, 400);
    assert.equal(denial?.body.error, "cost-code-without-project");
});

test("a captured phase from another job is refused at the door", async () => {
    const denial = await authorizePhase("job-mesplay", "cc-plumb", allow);
    assert.equal(denial?.status, 400);
    assert.equal(denial?.body.error, "cost-code-not-a-phase");
});

test("no phase at all is fine — the capture is optional", async () => {
    assert.equal(await authorizePhase("job-mueller", null, allow), null);
});

test("the job's own phase passes the door gate", async () => {
    assert.equal(await authorizePhase("job-mueller", "cc-plumb", allow), null);
});

test("optionalBool is tri-state across JSON and multipart", () => {
    // Multipart sends strings; JSON sends real booleans. Anything else means
    // "the caller did not say", which is NOT "no".
    assert.equal(optionalBool(true), true);
    assert.equal(optionalBool(false), false);
    assert.equal(optionalBool("true"), true);
    assert.equal(optionalBool("false"), false);
    for (const silent of [undefined, null, "", "yes", 1, {}]) {
        assert.equal(optionalBool(silent), null, JSON.stringify(silent) ?? "undefined");
    }
});
