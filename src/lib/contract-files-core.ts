import { prisma } from "@/lib/prisma";

// Session-free core of the executed-contract file lookup, shared by the
// permission-gated `getExecutedContractPdf` server action in actions.ts and by
// the client portal page (src/app/portal/contracts/[id]/page.tsx), which has no
// staff session at all — it proves access with the contract's `accessToken`
// magic link or a portal session resolving to the owning Client, upstream via
// getContractForPortal.
//
// actions.ts is a server-action module, so every export there is an
// individually invokable POST endpoint. Auth-free logic must live HERE, not
// there, or the portal would have to be forced through a staff session gate it
// can never satisfy — the same reasoning as src/lib/contract-creation-core.ts
// and src/lib/lead-conversion-core.ts. (This file deliberately carries no
// server-action directive.)
//
// The body below is moved verbatim from actions.ts. The one behavioural change
// lives at the CALLER: the exported action now resolves the owner and title
// from the database by contract id instead of trusting the descriptor it was
// handed, so a caller can no longer name another job's scope. This core still
// takes a descriptor because its two callers have each already established, by
// different means, which contract they are allowed to be looking at.

/** What the lookup needs to know about a contract. */
export type ExecutedContractDescriptor = {
    id: string;
    title: string;
    projectId: string | null;
    leadId: string | null;
};

/**
 * Returns the executed PDF ProjectFile for a specific contract.
 *
 * Files written by the finalize route set `ProjectFile.name` to the exact string
 * `Executed_Contract_{contractId}.pdf` (no timestamp prefix — the timestamp only
 * appears in the storage path, not the DB `name` column). We use exact equality
 * for airtight lookup.
 *
 * Legacy fallback: files written before the contractId naming convention used
 * `Executed_Contract_{safeTitle}.pdf`. If exact-match returns nothing we retry
 * with the title-based prefix as a best-effort courtesy for old data. Same-title
 * collisions on legacy data are accepted as a known limitation — new data is
 * unambiguous.
 */
export async function executedContractPdfFor(contract: ExecutedContractDescriptor) {
    const where: any = contract.projectId
        ? { projectId: contract.projectId }
        : contract.leadId
            ? { leadId: contract.leadId }
            : null;
    if (!where) return null;

    // Preferred: exact-match on the contract-id-embedded filename.
    const exactName = `Executed_Contract_${contract.id}.pdf`;
    const byContractId = await prisma.projectFile.findFirst({
        where: {
            ...where,
            name: exactName,
            mimeType: "application/pdf",
        },
        orderBy: { createdAt: "desc" },
    });
    if (byContractId) return byContractId;

    // Legacy fallback — title-prefixed files from before the contractId naming change.
    const legacyPrefix = `Executed_Contract_${contract.title.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    return prisma.projectFile.findFirst({
        where: {
            ...where,
            name: { startsWith: legacyPrefix },
            mimeType: "application/pdf",
        },
        orderBy: { createdAt: "desc" },
    });
}
