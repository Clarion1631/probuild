"use server";

/**
 * A thin, SEPARATE wrapper for the folder-suggestion buttons only.
 *
 * `setReceiptIntakeJob` (src/lib/actions.ts) is reused UNCHANGED for the
 * normal Set job control, and this file never edits it — its tests pin exact
 * line numbers (build brief). A suggestion button is different: it was
 * rendered from a SNAPSHOT of the open-job list, taken when the page loaded.
 * By the time someone taps it, the tapped job may have closed, or the
 * folder-to-job rule may no longer consider it a match (a namesake opened, a
 * job was renamed). Neither of those is a fact `setReceiptIntakeJob`'s own
 * checks can see — it only knows the job still EXISTS and that the RECEIPT
 * row is still in the state and version rendered.
 *
 * So this re-derives both facts, "still open" and "still a candidate", from
 * the database at write time, and refuses with a plain message before ever
 * reaching setReceiptIntakeJob if either has changed. It does not check the
 * receipt's row again itself — setReceiptIntakeJob's own compare-and-set
 * still owns that, unchanged.
 */
import { prisma } from "@/lib/prisma";
import { setReceiptIntakeJob } from "@/lib/actions";
import { suggestJobsForFolder } from "@/lib/receipt-intake/folder";
import { fetchJobOptions } from "@/app/automation/receipts-data";
import { JOB_OPTIONS_TAKE } from "@/app/automation/receipts-filters";

export async function setReceiptIntakeJobFromSuggestion(
    id: string,
    projectId: string,
    expectedState: string,
    expectedUpdatedAt: string,
) {
    const row = await prisma.receiptIntake.findUnique({ where: { id }, select: { sourceFolder: true } });
    if (!row?.sourceFolder) {
        throw new Error("This receipt no longer has a folder to suggest from. Refresh and use Set job.");
    }
    // fetchJobOptions is already scoped to OPEN_PROJECT_STATUSES, so a job
    // that closed since the page loaded simply will not be in this list —
    // that IS the "still open" check.
    const jobs = await fetchJobOptions();
    const suggestions = suggestJobsForFolder(row.sourceFolder, jobs, JOB_OPTIONS_TAKE);
    const stillACandidate = (suggestions.kind === "exact" || suggestions.kind === "prefix")
        && suggestions.jobs.some(job => job.id === projectId);
    if (!stillACandidate) {
        throw new Error("That job is no longer open or no longer matches this receipt's folder. Refresh and use Set job.");
    }
    return setReceiptIntakeJob(id, projectId, expectedState, expectedUpdatedAt);
}
