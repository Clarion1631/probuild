// "IS THIS COST CODE A PHASE OF THIS JOB?" AS A TRANSACTIONAL INVARIANT.
//
// Five writers ask that question and then act on the answer: the receipt
// booking, the manual expense PATCH, the two-step finalize, the QBO cost-code
// suggester, and the attribution backfill. Every one of them used to ask it
// through the global Prisma client, outside whatever transaction it was about
// to write in — so the answer was true when it was given and nothing kept it
// true until the write landed.
//
// The facts it depends on live on four tables and any of them can move:
//
//   * `Project`     — the job itself can be deleted.
//   * `Estimate`    — can be ARCHIVED, moved to another project, or dropped out
//                     of the eligible statuses (a "Rejected" revision is not
//                     committed work).
//   * `EstimateItem`— the line that carries the code can be deleted or recoded.
//   * `CostCode`    — can be DEACTIVATED company-wide.
//
// So the check locks all four FOR SHARE, in one fixed order, and only then
// answers. FOR SHARE blocks an UPDATE or DELETE of those rows until the
// caller's transaction commits, while leaving other readers (including another
// caller of this helper) free — the answer cannot go stale between here and the
// write, and two callers cannot deadlock against each other because the order
// never varies.
//
// Those scans lock what EXISTS when they run, which under READ COMMITTED is not
// the same set the verdict is read from — a row inserted and committed after
// them is visible to the next statement and held by nothing. So the query that
// actually answers the question locks its own rows too (`FOR SHARE OF ei, e`),
// which is the only way the row that PROVED membership is guaranteed to still
// prove it at commit.
//
// It is deliberately NOT a Prisma query. The whole point is that it runs on the
// CALLER'S transaction client, so it sees, and holds, the same snapshot the
// write will use. A helper that quietly reached for the global client would
// reintroduce the bug it exists to close.
import {
    PHASE_ELIGIBLE_ESTIMATE_STATUSES,
    SAFETY_COST_CODE,
    shouldIncludeSafetyPhase,
} from "@/lib/project-phases";

/** The structural subset of a Prisma transaction client this needs. */
export interface PhaseTxClient {
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/** Why a code is not a phase of a job — the reason, not just "no". */
export type PhaseRejection =
    | "no-project"
    | "project-missing"
    | "not-a-phase"
    | "code-inactive";

export type PhaseVerdict =
    | { ok: true }
    | { ok: false; reason: PhaseRejection };

/**
 * Read LAZILY, not at module load. Several unit tests patch
 * `@/lib/project-phases` at require time and hand back only the export they
 * care about; a module-level `.map` over a constant that is absent from the
 * stub crashes the whole import for tests that never call this function.
 */
function eligibleEstimateStatuses(): string[] {
    return (PHASE_ELIGIBLE_ESTIMATE_STATUSES ?? []).map((status) => status);
}

/**
 * Take the four share locks, in the ONE order every caller uses.
 *
 * Exported so a caller that needs the job's whole phase list held still (the
 * attribution backfill re-reads it under the lock) can take the same locks in
 * the same order rather than inventing a second ordering to deadlock against.
 */
export async function lockPhaseRowsForShare(
    tx: PhaseTxClient,
    projectId: string | null,
    costCodeId?: string | null,
): Promise<void> {
    if (!projectId) return;
    // 1. The job.
    await tx.$queryRawUnsafe(`SELECT id FROM "Project" WHERE id = $1 FOR SHARE`, projectId);
    // 2. Its estimates. Ordered, so two holders acquire them the same way.
    await tx.$queryRawUnsafe(
        `SELECT id FROM "Estimate" WHERE "projectId" = $1 ORDER BY id FOR SHARE`,
        projectId,
    );
    // 3. The line items that carry the codes. `FOR SHARE OF ei` keeps the lock
    //    off the joined estimate rows, which step 2 already holds.
    await tx.$queryRawUnsafe(
        `SELECT ei.id FROM "EstimateItem" ei
           JOIN "Estimate" e ON e.id = ei."estimateId"
          WHERE e."projectId" = $1
          ORDER BY ei.id
            FOR SHARE OF ei`,
        projectId,
    );
    // 4. The cost code itself, when the caller named one: `isActive` is a
    //    company-wide switch that has nothing to do with this job.
    if (costCodeId) {
        await tx.$queryRawUnsafe(`SELECT id FROM "CostCode" WHERE id = $1 FOR SHARE`, costCodeId);
    }
}

/**
 * Lock, then answer: is `costCodeId` a phase of `projectId` RIGHT NOW, and will
 * it still be when this transaction commits?
 *
 * Mirrors `resolveProjectPhaseCodes` exactly, in SQL:
 *   * the estimate must belong to this project, be un-archived, and be in one
 *     of the eligible statuses (committed work, not a draft or a rejection);
 *   * the cost code must be active;
 *   * the company Safety phase is allowed on an In Progress project without an
 *     estimate item, because it is appended to the list rather than discovered
 *     from one.
 *
 * A null `costCodeId` is vacuously fine — there is nothing to check — and no
 * locks are taken for it.
 */
export async function assertPhaseOfProjectTx(
    tx: PhaseTxClient,
    projectId: string | null,
    costCodeId: string | null,
): Promise<PhaseVerdict> {
    if (!costCodeId) return { ok: true };
    if (!projectId) return { ok: false, reason: "no-project" };

    await lockPhaseRowsForShare(tx, projectId, costCodeId);

    const project = (await tx.$queryRawUnsafe(
        `SELECT id, status FROM "Project" WHERE id = $1`,
        projectId,
    )) as { id: string; status: string | null }[];
    if (!project?.length) return { ok: false, reason: "project-missing" };

    const code = (await tx.$queryRawUnsafe(
        `SELECT id, code, "isActive" FROM "CostCode" WHERE id = $1`,
        costCodeId,
    )) as { id: string; code: string; isActive: boolean }[];
    // An unknown code and a deactivated one are the same answer to the caller:
    // it is not a phase anybody may post money to.
    if (!code?.length || !code[0].isActive) return { ok: false, reason: "code-inactive" };

    // The Safety phase is company-wide and never appears on an estimate, so it
    // is checked before the estimate join rather than through it.
    if (code[0].code === SAFETY_COST_CODE && shouldIncludeSafetyPhase(project[0].status)) {
        return { ok: true };
    }

    return (await provePhaseMembershipTx(tx, projectId, costCodeId))
        ? { ok: true }
        : { ok: false, reason: "not-a-phase" };
}

/**
 * THE QUERY THAT ANSWERS, AND LOCKS WHAT IT ANSWERED FROM.
 *
 * Split out of `assertPhaseOfProjectTx` so the lock it takes can be tested for
 * what it actually is — the ONE thing standing between a verdict and a phantom
 * row. `tests/phase-invariant-db.test.ts` drives it against a real Postgres
 * after letting a concurrent insert land, which is not expressible while it is
 * welded to the four scans that run before it.
 *
 * `true` means: an un-archived, eligible-status estimate of this project
 * carries this cost code on a line item, and both of those rows are share-locked
 * for the rest of the caller's transaction.
 */
export async function provePhaseMembershipTx(
    tx: PhaseTxClient,
    projectId: string,
    costCodeId: string,
): Promise<boolean> {
    const statuses = eligibleEstimateStatuses();
    const statusParams = statuses.map((_, index) => `$${index + 3}`).join(", ");
    // THE PROOF QUERY TAKES ITS OWN LOCK (Codex round 32).
    //
    // `lockPhaseRowsForShare` locks the rows that EXIST when it runs. Under
    // READ COMMITTED that is not the whole story: a concurrent transaction can
    // INSERT an EstimateItem — or an Estimate — and commit it between those
    // scans and this query, and this query WILL see it (each statement takes a
    // fresh snapshot). A verdict resting on a row nobody locked is exactly the
    // stale answer this module exists to prevent: the row can be deleted, or
    // its estimate archived or reassigned, before the caller's expense write
    // commits.
    //
    // `FOR SHARE OF ei, e` locks the exact pair that ANSWERS the question, so
    // whatever proved membership is still true at commit. Lock order is
    // unchanged: every row this can reach that already existed is held by the
    // Estimate/EstimateItem scans, and re-acquiring a share lock this
    // transaction owns is free — a PHANTOM is the only row it can block on, and
    // a phantom is by definition not part of anybody's acquisition order.
    //
    // `LIMIT 1` before the locking clause is deliberate: Postgres locks only
    // the row it returns. If that row is concurrently updated out of the
    // predicate, READ COMMITTED re-checks it and the query yields nothing — a
    // "not-a-phase" verdict. That is fail-CLOSED, which is the safe direction
    // for a money write.
    const onProject = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok
           FROM "EstimateItem" ei
           JOIN "Estimate" e ON e.id = ei."estimateId"
          WHERE e."projectId" = $1
            AND ei."costCodeId" = $2
            AND e."archivedAt" IS NULL
            AND e.status IN (${statusParams})
          LIMIT 1
            FOR SHARE OF ei, e`,
        projectId,
        costCodeId,
        ...statuses,
    )) as unknown[];

    return Boolean(onProject?.length);
}
