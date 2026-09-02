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
import { resolveInstalledAtCustomer } from "../src/app/api/receipts/intake/route";

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
