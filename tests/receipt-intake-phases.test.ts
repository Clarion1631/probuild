/**
 * loadPhases must offer the model ONLY the phases the job actually has.
 *
 * The regression: it returned every active cost code company-wide, so the model
 * was shown phases the project does not have, confidently suggested one, and
 * booking then threw that suggestion away (isCostCodeAllowedForProject). The
 * visible symptom was receipts arriving uncoded for no stated reason. The real
 * cost is subtler: a plausible-but-wrong phase is exactly the kind of thing a
 * reviewer accepts without checking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveProjectPhaseCodes, type PhaseDataSource } from "../src/lib/project-phases";

function source(over: Partial<PhaseDataSource> = {}): PhaseDataSource {
    return {
        getProject: async () => ({ id: "p1", status: "In Progress" }),
        getEstimateCostCodes: async () => [
            { id: "cc-demo", code: "01-DEMO", name: "Demolition", isActive: true },
        ],
        getSafetyCostCode: async () => null,
        ...over,
    } as PhaseDataSource;
}

/** Mirrors the worker's adapter exactly. */
async function loadPhases(projectId: string | null, ds: PhaseDataSource) {
    if (!projectId) return [];
    const phases = await resolveProjectPhaseCodes(ds, projectId);
    return phases.map(p => ({ id: p.id, code: p.code, name: p.name }));
}

test("a known project returns only ITS phase-eligible codes", async () => {
    const phases = await loadPhases("p1", source());
    assert.deepEqual(phases.map(p => p.code), ["01-DEMO"]);
});

test("a project with NO eligible phases returns an empty list, not a fallback", async () => {
    // This is the case the old code papered over. An empty list is a real
    // answer: nothing on this job is a valid phase, so the model must suggest
    // nothing rather than reach for a company-wide code that booking will
    // discard.
    const phases = await loadPhases("p1", source({ getEstimateCostCodes: async () => [] }));
    assert.deepEqual(phases, []);
});

test("an unknown project returns empty rather than everything", async () => {
    const phases = await loadPhases("nope", source({ getProject: async () => null }));
    assert.deepEqual(phases, []);
});

test("a row with no project gets no phases at all", async () => {
    // Suggesting one from the whole company would be a guess with nothing
    // behind it — and NEEDS_JOB rows are exactly the ones a human is about to
    // assign, so a stale suggestion is worse than none.
    let called = false;
    await loadPhases(null, source({ getProject: async () => { called = true; return null; } }));
    assert.equal(called, false, "the resolver is not even consulted");
});

test("the Safety phase is included when the project status allows it", async () => {
    // Proof this really is the shared resolver and not a reimplementation:
    // Safety is a phase no estimate lists, and only the resolver knows to add it.
    const phases = await loadPhases("p1", source({
        getSafetyCostCode: async () => ({ id: "cc-safety", code: "00-SAFETY", name: "Safety Meeting", isActive: true }),
    }));
    assert.ok(phases.some(p => p.code === "00-SAFETY"));
});
