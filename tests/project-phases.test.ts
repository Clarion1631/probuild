/**
 * Rules for the crew's clock-in phase list (src/lib/project-phases.ts) — the
 * ONE place the picker route (/api/projects/[id]/cost-codes) and the clock-in
 * validation (/api/time-entries POST) both get their answer from, so what the
 * crew is shown and what the server accepts cannot drift apart.
 *
 * Pure/DI style — no database (mirrors tests/phase-options.test.ts and
 * tests/mobile-phases-route.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    composeProjectPhases,
    isCostCodeAllowedForProject,
    resolveProjectPhaseCodes,
    shouldIncludeSafetyPhase,
    PHASE_ELIGIBLE_ESTIMATE_STATUSES,
    SAFETY_COST_CODE,
    type PhaseCostCode,
    type PhaseDataSource,
} from "../src/lib/project-phases";
import { requiresPhaseForClockIn } from "../src/lib/logistics-time-entry";

const DEMO: PhaseCostCode = { id: "cc-demo", code: "01-DEMO", name: "Demolition" };
const FRAME: PhaseCostCode = { id: "cc-frame", code: "02-FRAME", name: "Framing" };
const SAFETY: PhaseCostCode = { id: "cc-safety", code: SAFETY_COST_CODE, name: "Safety Meeting" };

/**
 * A fake PhaseDataSource. `estimatesByProject` models the DB rows so the test
 * can assert the eligible-estimate FILTER itself, not just a pre-filtered list.
 */
function createDataSource(options: {
    status?: string | null;
    projectExists?: boolean;
    /** Raw estimate rows, so the eligibility predicate is exercised here. */
    estimates?: Array<{ status: string; archivedAt: Date | null; costCodes: PhaseCostCode[] }>;
    safetySeeded?: boolean;
}): PhaseDataSource {
    const estimates = options.estimates ?? [];
    return {
        async getProject(projectId) {
            if (options.projectExists === false) return null;
            return { id: projectId, status: options.status ?? "In Progress" };
        },
        async getEstimateCostCodes() {
            const eligible = estimates.filter(
                (e) =>
                    (PHASE_ELIGIBLE_ESTIMATE_STATUSES as readonly string[]).includes(e.status) &&
                    e.archivedAt === null
            );
            const byId = new Map<string, PhaseCostCode>();
            for (const estimate of eligible) for (const cc of estimate.costCodes) byId.set(cc.id, cc);
            return [...byId.values()];
        },
        async getSafetyCostCode() {
            return options.safetySeeded === false ? null : SAFETY;
        },
    };
}

// ── eligible-estimate filtering ─────────────────────────────────────────────

test("only Approved/Invoiced/Partially Paid/Paid, non-archived estimates contribute phases", async () => {
    const dataSource = createDataSource({
        status: "Substantial Completion", // keeps safety out, isolating the filter
        estimates: [
            { status: "Approved", archivedAt: null, costCodes: [DEMO] },
            { status: "Paid", archivedAt: null, costCodes: [FRAME] },
            { status: "Draft", archivedAt: null, costCodes: [{ id: "cc-draft", code: "03-DRAFT", name: "Draft only" }] },
            { status: "Sent", archivedAt: null, costCodes: [{ id: "cc-sent", code: "04-SENT", name: "Sent only" }] },
            {
                status: "Approved",
                archivedAt: new Date(),
                costCodes: [{ id: "cc-arch", code: "05-ARCH", name: "Archived" }],
            },
        ],
    });
    const phases = await resolveProjectPhaseCodes(dataSource, "p1");
    assert.deepEqual(
        phases.map((p) => p.code),
        ["01-DEMO", "02-FRAME"]
    );
});

test("an unknown project has no phases at all", async () => {
    const dataSource = createDataSource({ projectExists: false });
    assert.deepEqual(await resolveProjectPhaseCodes(dataSource, "nope"), []);
});

// ── safety phase: In Progress only ──────────────────────────────────────────

test("shouldIncludeSafetyPhase is true only for In Progress", () => {
    assert.equal(shouldIncludeSafetyPhase("In Progress"), true);
    for (const status of ["Waiting to Start", "Substantial Completion", "Closed Complete", "Closed Lost", null, undefined]) {
        assert.equal(shouldIncludeSafetyPhase(status), false, `expected false for ${String(status)}`);
    }
});

test("the Safety Meeting phase is appended on an In Progress project", async () => {
    const dataSource = createDataSource({
        status: "In Progress",
        estimates: [{ status: "Approved", archivedAt: null, costCodes: [DEMO] }],
    });
    const phases = await resolveProjectPhaseCodes(dataSource, "p1");
    assert.deepEqual(
        phases.map((p) => p.code),
        ["01-DEMO", SAFETY_COST_CODE]
    );
});

test("the Safety Meeting phase is absent on every non-In-Progress status", async () => {
    for (const status of ["Waiting to Start", "Substantial Completion", "Closed Complete", "Closed Lost"]) {
        const dataSource = createDataSource({
            status,
            estimates: [{ status: "Approved", archivedAt: null, costCodes: [DEMO] }],
        });
        const phases = await resolveProjectPhaseCodes(dataSource, "p1");
        assert.deepEqual(phases.map((p) => p.code), ["01-DEMO"], `leaked safety phase on ${status}`);
    }
});

test("an In Progress project with no eligible estimate still offers the safety phase alone", async () => {
    const dataSource = createDataSource({ status: "In Progress", estimates: [] });
    const phases = await resolveProjectPhaseCodes(dataSource, "p1");
    assert.deepEqual(phases.map((p) => p.code), [SAFETY_COST_CODE]);
});

test("an unseeded safety cost code degrades to an empty/estimate-only list, not a crash", async () => {
    const dataSource = createDataSource({ status: "In Progress", safetySeeded: false, estimates: [] });
    assert.deepEqual(await resolveProjectPhaseCodes(dataSource, "p1"), []);
});

test("an estimate that already carries the safety line does not produce a duplicate row", () => {
    const phases = composeProjectPhases({
        estimateCostCodes: [SAFETY, DEMO],
        projectStatus: "In Progress",
        safetyCostCode: SAFETY,
    });
    assert.deepEqual(phases.map((p) => p.code), ["01-DEMO", SAFETY_COST_CODE]);
});

test("phases come back sorted by code", () => {
    const phases = composeProjectPhases({
        estimateCostCodes: [FRAME, DEMO],
        projectStatus: "Closed Complete",
        safetyCostCode: SAFETY,
    });
    assert.deepEqual(phases.map((p) => p.code), ["01-DEMO", "02-FRAME"]);
});

// ── clock-in validation (the same helper the picker route uses) ─────────────

test("clock-in accepts a cost code that IS one of the project's phases", async () => {
    const dataSource = createDataSource({
        status: "In Progress",
        estimates: [{ status: "Approved", archivedAt: null, costCodes: [DEMO] }],
    });
    assert.equal(await isCostCodeAllowedForProject(dataSource, "p1", DEMO.id), true);
});

test("clock-in REJECTS a cost code that exists globally but is not on this project", async () => {
    const dataSource = createDataSource({
        status: "In Progress",
        estimates: [{ status: "Approved", archivedAt: null, costCodes: [DEMO] }],
    });
    // FRAME is a perfectly real CostCode — just not one of this job's phases.
    assert.equal(await isCostCodeAllowedForProject(dataSource, "p1", FRAME.id), false);
});

test("clock-in REJECTS a code that only appears on a draft/archived estimate", async () => {
    const dataSource = createDataSource({
        status: "In Progress",
        estimates: [
            { status: "Draft", archivedAt: null, costCodes: [FRAME] },
            { status: "Approved", archivedAt: new Date(), costCodes: [DEMO] },
        ],
    });
    assert.equal(await isCostCodeAllowedForProject(dataSource, "p1", FRAME.id), false);
    assert.equal(await isCostCodeAllowedForProject(dataSource, "p1", DEMO.id), false);
});

test("clock-in accepts the safety code on an In Progress project", async () => {
    const dataSource = createDataSource({ status: "In Progress", estimates: [] });
    assert.equal(await isCostCodeAllowedForProject(dataSource, "p1", SAFETY.id), true);
});

test("clock-in REJECTS the safety code on a non-In-Progress project", async () => {
    for (const status of ["Waiting to Start", "Substantial Completion", "Closed Complete", "Closed Lost"]) {
        const dataSource = createDataSource({ status, estimates: [] });
        assert.equal(
            await isCostCodeAllowedForProject(dataSource, "p1", SAFETY.id),
            false,
            `safety code accepted on ${status}`
        );
    }
});

test("what the picker shows and what clock-in accepts are the same set", async () => {
    const dataSource = createDataSource({
        status: "In Progress",
        estimates: [{ status: "Invoiced", archivedAt: null, costCodes: [DEMO, FRAME] }],
    });
    const shown = await resolveProjectPhaseCodes(dataSource, "p1");
    for (const phase of shown) {
        assert.equal(await isCostCodeAllowedForProject(dataSource, "p1", phase.id), true, `${phase.code} shown but rejected`);
    }
});

// ── logistics projects keep clocking in with no phase at all ────────────────

test("a logistics project still clocks in with no phase (PHASE_REQUIRED untouched)", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: true, hasCostCode: false, hasEstimateItem: false }),
        false
    );
    // ...while a normal project without one is still refused.
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: false, hasEstimateItem: false }),
        true
    );
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: true, hasEstimateItem: false }),
        false
    );
});
