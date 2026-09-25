"use server";

/**
 * A thin, SEPARATE, AUTHORIZED wrapper for the folder-suggestion buttons
 * only. `setReceiptIntakeJob` (src/lib/actions.ts) is reused UNCHANGED for
 * the normal Set job control, and this file never edits it — its tests pin
 * exact line numbers (build brief). The write-time re-check itself lives in
 * suggestion-core.ts (no "use server", injected loaders), so it is
 * unit-testable without a database; this file's only job is to authorize the
 * caller and then hand off to that core with the real, Prisma-backed
 * loaders.
 *
 * AUTHORIZATION (checker, PR #555 round 3): the moment a file starts with
 * "use server", every export becomes a Server Action with a GLOBAL, PUBLIC
 * id — dispatchable by anyone who can name it, whether or not any UI button
 * ever calls it (tests/server-action-gates.test.ts). This export used to
 * read the receipt row and the open-job list before checking who was asking.
 * The check now runs FIRST, before any database read, and is the same one
 * setReceiptIntakeJob itself is gated by (assertReceiptQueueAccess in
 * src/lib/actions.ts: getCurrentUserWithPermissions + hasPermission
 * "financialReports"), plus canAccessProject for the chosen project. It is
 * duplicated inline rather than imported, because assertReceiptQueueAccess is
 * not exported — exporting it from actions.ts, itself a "use server" module,
 * would add a second dispatchable action id, which is exactly the class of
 * hole this fix closes (see tests/server-action-gates.test.ts: "the gate
 * helper is not itself a dispatchable action"). Every rejection returns the
 * same generic message, so an unauthorized caller learns nothing about which
 * check failed.
 */
import { prisma } from "@/lib/prisma";
import { setReceiptIntakeJob } from "@/lib/actions";
import { getCurrentUserWithPermissions, hasPermission, canAccessProject } from "@/lib/permissions";
import { fetchJobOptions } from "@/app/automation/receipts-data";
import { decideReceiptIntakeJobFromSuggestion } from "@/lib/receipt-intake/suggestion-core";

export async function setReceiptIntakeJobFromSuggestion(
    id: string,
    projectId: string,
    expectedState: string,
    expectedUpdatedAt: string,
) {
    const user = await getCurrentUserWithPermissions();
    if (
        !user
        || !hasPermission(user, "financialReports")
        || typeof projectId !== "string"
        || !projectId
        || !canAccessProject(user, projectId)
    ) {
        throw new Error("Forbidden");
    }

    return decideReceiptIntakeJobFromSuggestion(id, projectId, expectedState, expectedUpdatedAt, {
        loadIntake: (intakeId) => prisma.receiptIntake.findUnique({ where: { id: intakeId }, select: { sourceFolder: true } }),
        loadOpenJobs: fetchJobOptions,
        setJob: setReceiptIntakeJob,
    });
}
