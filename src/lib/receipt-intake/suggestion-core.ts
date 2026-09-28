/**
 * The write-time re-check for a folder-suggestion tap — split out of
 * suggestion-actions.ts (a "use server" module, not import-safe for a plain
 * unit test) into a plain module with INJECTED loaders, so the decision
 * itself is testable without a database (checker, PR #555 round 3: the prior
 * shape had no test that failed when this logic was reverted or deleted).
 *
 * A suggestion button is rendered from a SNAPSHOT of the open-job list taken
 * when the page loaded. By the time someone taps it, the tapped job may have
 * closed, or the folder-to-job rule may no longer consider it a match (a
 * namesake opened, or the job was renamed). Neither of those is a fact
 * `setReceiptIntakeJob`'s own checks can see — it only knows the job still
 * EXISTS and that the receipt row is still in the state and version
 * rendered. So this re-derives both facts, "still open" and "still a
 * candidate", from the loaders at write time, and refuses with a plain
 * message — WITHOUT EVER CALLING `setJob` — before ever reaching
 * setReceiptIntakeJob if either has changed. It does not check the
 * receipt's row again itself — setReceiptIntakeJob's own compare-and-set
 * still owns that, unchanged.
 */
import { isFolderCandidate } from "./folder";
import { JOB_OPTIONS_TAKE } from "@/app/automation/receipts-filters";

export type SuggestionJobOption = { id: string; name: string };

export type SuggestionDependencies = {
    /** Loads just the folder this receipt was filed under (or none). */
    loadIntake: (id: string) => Promise<{ sourceFolder: string | null } | null>;
    /** The CURRENT open-job list — never the page's stale snapshot. */
    loadOpenJobs: () => Promise<ReadonlyArray<SuggestionJobOption>>;
    /** setReceiptIntakeJob (src/lib/actions.ts), or a test double. */
    setJob: (id: string, projectId: string, expectedState: string, expectedUpdatedAt: string) => Promise<{ ok: true } | { ok: false; message: string }>;
};

export async function decideReceiptIntakeJobFromSuggestion(
    id: string,
    projectId: string,
    expectedState: string,
    expectedUpdatedAt: string,
    deps: SuggestionDependencies,
): Promise<{ ok: true } | { ok: false; message: string }> {
    const row = await deps.loadIntake(id);
    if (!row?.sourceFolder) {
        throw new Error("This receipt no longer has a folder to suggest from. Refresh and use Set job.");
    }
    // loadOpenJobs is expected to be scoped to open jobs (the real
    // fetchJobOptions is, to OPEN_PROJECT_STATUSES), so a job that closed
    // since the page loaded simply will not be in this list — that IS the
    // "still open" check.
    const jobs = await deps.loadOpenJobs();
    const stillACandidate = isFolderCandidate(row.sourceFolder, jobs, JOB_OPTIONS_TAKE, projectId);
    if (!stillACandidate) {
        throw new Error("That job is no longer open or no longer matches this receipt's folder. Refresh and use Set job.");
    }
    const result = await deps.setJob(id, projectId, expectedState, expectedUpdatedAt);
    // setReceiptIntakeJob returns `{ ok: false, message }` for a refusal it
    // anticipated (stale expectedState/expectedUpdatedAt, a vanished job, a bad
    // cost code) instead of throwing. The suggestion buttons in
    // receipt-row-actions.tsx call through the plain useAction wrapper, which
    // treats "did not throw" as success -- so that refusal has to be converted
    // into a thrown error here, or a real failure would toast "Job set.".
    if (!result.ok) throw new Error(result.message);
    return result;
}
