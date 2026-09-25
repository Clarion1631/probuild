/**
 * decideReceiptIntakeJobFromSuggestion's write-time re-check (checker, PR
 * #555 round 3, finding 2): the prior shape had no test that failed when this
 * logic was reverted or deleted — the e2e happy path never exercised a
 * closed/renamed/ambiguous job, and the wrapper's decision lived inline in a
 * "use server" file that a plain unit test cannot import at all. This tests
 * the extracted core directly, with injected loaders standing in for Prisma
 * and a spy standing in for setReceiptIntakeJob, so a refusal that stops
 * calling the setter — or a setter that gets called anyway — fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideReceiptIntakeJobFromSuggestion, type SuggestionDependencies } from "../src/lib/receipt-intake/suggestion-core";

const jobs = (names: string[]) => names.map((name, i) => ({ id: `job-${i}`, name }));

function makeDeps(overrides: Partial<SuggestionDependencies> & { sourceFolder?: string | null; openJobs?: ReturnType<typeof jobs> } = {}) {
    const setCalls: Array<[string, string, string, string]> = [];
    const deps: SuggestionDependencies = {
        loadIntake: overrides.loadIntake ?? (async () => ({ sourceFolder: overrides.sourceFolder ?? "Oak Street" })),
        loadOpenJobs: overrides.loadOpenJobs ?? (async () => overrides.openJobs ?? jobs(["Oak Street"])),
        setJob: overrides.setJob ?? (async (id, projectId, expectedState, expectedUpdatedAt) => {
            setCalls.push([id, projectId, expectedState, expectedUpdatedAt]);
            return { ok: true };
        }),
    };
    return { deps, setCalls };
}

test("a valid tap calls the setter exactly once, with the same arguments", async () => {
    const { deps, setCalls } = makeDeps({ sourceFolder: "Oak Street", openJobs: jobs(["Oak Street"]) });
    const result = await decideReceiptIntakeJobFromSuggestion("intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z", deps);
    assert.deepEqual(setCalls, [["intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z"]]);
    assert.deepEqual(result, { ok: true });
});

test("refuses a job that closed since the page loaded (no longer in the open-jobs load) -- setter never called", async () => {
    const { deps, setCalls } = makeDeps({ sourceFolder: "Oak Street", openJobs: jobs(["Pine Avenue"]) });
    await assert.rejects(
        () => decideReceiptIntakeJobFromSuggestion("intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z", deps),
        /no longer open or no longer matches/,
    );
    assert.deepEqual(setCalls, [], "setJob must never run once the job no longer appears in the fresh open-jobs load");
});

test("refuses a job that was renamed away from the folder since the page loaded -- setter never called", async () => {
    // Same id, but the fresh load shows a name that no longer matches "Oak Street".
    const { deps, setCalls } = makeDeps({ sourceFolder: "Oak Street", openJobs: [{ id: "job-0", name: "Birch Lane" }] });
    await assert.rejects(
        () => decideReceiptIntakeJobFromSuggestion("intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z", deps),
        /no longer open or no longer matches/,
    );
    assert.deepEqual(setCalls, []);
});

test("refuses when a namesake opened, turning a unique exact match into an ambiguous same-name -- setter never called", async () => {
    const { deps, setCalls } = makeDeps({
        sourceFolder: "Oak Street",
        openJobs: [{ id: "job-0", name: "Oak Street" }, { id: "job-1", name: "oak street" }],
    });
    await assert.rejects(
        () => decideReceiptIntakeJobFromSuggestion("intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z", deps),
        /no longer open or no longer matches/,
    );
    assert.deepEqual(setCalls, []);
});

test("refuses when the receipt no longer has a folder to suggest from -- setter never called, no open-jobs load", async () => {
    let loadOpenJobsCalls = 0;
    const { deps, setCalls } = makeDeps({
        loadIntake: async () => ({ sourceFolder: null }),
        loadOpenJobs: async () => {
            loadOpenJobsCalls += 1;
            return jobs(["Oak Street"]);
        },
    });
    await assert.rejects(
        () => decideReceiptIntakeJobFromSuggestion("intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z", deps),
        /no longer has a folder/,
    );
    assert.deepEqual(setCalls, []);
    assert.equal(loadOpenJobsCalls, 0, "a folderless receipt must refuse before ever loading the open-job list");
});

test("refuses when the intake row itself no longer exists -- setter never called", async () => {
    const { deps, setCalls } = makeDeps({ loadIntake: async () => null });
    await assert.rejects(
        () => decideReceiptIntakeJobFromSuggestion("intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z", deps),
        /no longer has a folder/,
    );
    assert.deepEqual(setCalls, []);
});

test("a setJob refusal ({ ok: false, message }) is thrown, not returned -- the caller's plain useAction wrapper treats any non-throwing resolution as success", async () => {
    const { deps } = makeDeps({
        sourceFolder: "Oak Street",
        openJobs: jobs(["Oak Street"]),
        setJob: async () => ({ ok: false, message: "This receipt changed underneath you — refresh." }),
    });
    await assert.rejects(
        () => decideReceiptIntakeJobFromSuggestion("intake-1", "job-0", "NEEDS_JOB", "2026-09-24T00:00:00.000Z", deps),
        /This receipt changed underneath you — refresh\./,
    );
});
