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

/** Everything an attribution transaction may need held still. */
export interface AttributionLockTargets {
    /** The job the decision is being made about. */
    projectId?: string | null;
    /**
     * SEVERAL jobs at once — a re-attribution touches the one it is leaving and
     * the one it is joining (round 43, item 2). Locking them with two calls
     * would walk Project A, Estimates A, Items A, Project B: the table order
     * broken between the calls, which is the whole thing this helper exists to
     * prevent.
     */
    projectIds?: readonly (string | null | undefined)[];
    /** A SPECIFIC estimate the caller reads or writes the attribution pair from. */
    estimateId?: string | null;
    /** SEVERAL specific estimates — the source's and the target's. */
    estimateIds?: readonly (string | null | undefined)[];
    /** A SPECIFIC line item the caller links the expense to. */
    itemId?: string | null;
    /** The cost code being proposed. */
    costCodeId?: string | null;
}

/** Unique, non-empty, ascending — the acquisition order WITHIN a table. */
function idSet(
    single: string | null | undefined,
    many: readonly (string | null | undefined)[] | undefined,
): string[] {
    const all = [single, ...(many ?? [])].filter((id): id is string => !!id);
    return [...new Set(all)].sort();
}

/**
 * THE ONE PLACE THE ATTRIBUTION LOCK SET IS ACQUIRED (round 37, item 3).
 *
 * THE GLOBAL ORDER, for every writer that touches expense attribution:
 *
 *     Project -> Estimate -> EstimateItem -> CostCode -> Expense
 *
 * ...with ascending `id` WITHIN each table, the same rule
 * `lockMoneyParentsMany` uses, so a scan here and a money-path transaction
 * cannot invert against each other inside the Estimate table.
 *
 * WHY IT HAD TO BECOME ONE CALL. Every live writer took the set in TWO pieces
 * and got the order backwards between them: `lockEstimateAttribution` and
 * `resolveExpenseProjectUnderLock` share-lock the ESTIMATE first, to re-read
 * the attribution pair, and only afterwards does `assertPhaseOfProjectTx`
 * reach for the PROJECT. That is Estimate -> Project inside one transaction —
 * the exact inversion the order above exists to prevent, in the four writers
 * (`api/expenses` POST, `time-expense-core`, `api/integrations/receipt-ingest`,
 * the QBO cost-code suggester) and the two expense edit handlers. Against a
 * Project-first writer — a job editor holding its Project row FOR UPDATE and
 * then reaching for an estimate — that is a cycle, and Postgres breaks a cycle
 * by killing one side with 40P01, half the time the person's save rather than
 * the background pass. The backfill's own deadlock test claimed the system did
 * not have that cycle; it only proved the backfill did not.
 *
 * So a writer calls this ONCE, at the top of its transaction, naming
 * everything it might touch. The narrower helpers still take their own locks
 * afterwards; re-acquiring a share lock this transaction already holds is
 * free, so they become assertions rather than acquisitions and the order is
 * fixed here whatever sequence they run in.
 *
 * A caller passes the project id it resolved BEFORE the transaction. If the
 * re-read under the lock disagrees (a fallback-attributed row whose estimate
 * moved), the caller must REFUSE rather than continue: reaching for the new
 * project's row now would be the same Estimate -> Project inversion again, one
 * job over.
 *
 * FOR SHARE, not FOR UPDATE — none of these rows is modified here, they only
 * have to hold still. Two callers of this helper therefore never block each
 * other at all; the order only matters against something taking these rows
 * exclusively.
 *
 * KNOWN, PRE-EXISTING TENSION, recorded so the next reader does not think it
 * was missed. `createInvoiceFromEstimate` (src/lib/billing-core.ts) and
 * `restoreEstimateItemAssociations` (src/lib/actions.ts) deliberately take
 * Estimate FOR UPDATE *before* Project FOR UPDATE, for reasons documented at
 * both sites, so they and this family can still invert. That predates this
 * helper and is not widened by it — `lockPhaseRowsForShare` has led with
 * Project since it was written — and both of those callers run under
 * `withTxRetry`, which re-runs a cleanly rolled-back 40P01. Do not "fix" it by
 * flipping this helper: Project -> Estimate is also the order a `Project`
 * cascade delete takes, and the order tests/phase-invariant-db.test.ts pins.
 */
export async function lockAttributionParents(
    tx: PhaseTxClient,
    targets: AttributionLockTargets,
): Promise<void> {
    const projectId = targets.projectId ?? null;
    const estimateId = targets.estimateId ?? null;
    const itemId = targets.itemId ?? null;
    const costCodeId = targets.costCodeId ?? null;
    // EVERY project first, EVERY estimate next, EVERY item after that — one
    // statement per TABLE, never one pass per target (round 43, item 2).
    const projectIds = idSet(projectId, targets.projectIds);
    const estimateIds = idSet(estimateId, targets.estimateIds);

    // 1. The jobs, ascending.
    if (projectIds.length) {
        await tx.$queryRawUnsafe(
            `SELECT id FROM "Project" WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE`,
            projectIds,
        );
    }
    // 2. The estimates: the job's, AND any the caller named, in ONE ordered
    //    statement. One statement rather than two, because a separate lock on
    //    the named estimate would put it ahead of the job's ascending-id scan
    //    and two callers naming different estimates of the same job would then
    //    walk the table in different orders.
    const estimateClauses: string[] = [];
    const estimateParams: unknown[] = [];
    if (projectIds.length) {
        estimateParams.push(projectIds);
        estimateClauses.push(`"projectId" = ANY($${estimateParams.length}::text[])`);
    }
    if (estimateIds.length) {
        estimateParams.push(estimateIds);
        estimateClauses.push(`id = ANY($${estimateParams.length}::text[])`);
    }
    if (estimateClauses.length) {
        await tx.$queryRawUnsafe(
            `SELECT id FROM "Estimate" WHERE ${estimateClauses.join(" OR ")} ORDER BY id FOR SHARE`,
            ...estimateParams,
        );
    }
    // 3. The line items that carry the codes. `FOR SHARE OF ei` keeps the lock
    //    off the joined estimate rows, which step 2 already holds.
    const itemClauses: string[] = [];
    const itemParams: unknown[] = [];
    if (projectIds.length) {
        itemParams.push(projectIds);
        itemClauses.push(`e."projectId" = ANY($${itemParams.length}::text[])`);
    }
    if (itemId) {
        itemParams.push(itemId);
        itemClauses.push(`ei.id = $${itemParams.length}`);
    }
    if (itemClauses.length) {
        await tx.$queryRawUnsafe(
            `SELECT ei.id FROM "EstimateItem" ei
           JOIN "Estimate" e ON e.id = ei."estimateId"
          WHERE ${itemClauses.join(" OR ")}
          ORDER BY ei.id
            FOR SHARE OF ei`,
            ...itemParams,
        );
    }
    // 4. The cost code itself, when the caller named one: `isActive` is a
    //    company-wide switch that has nothing to do with this job.
    if (costCodeId) {
        await tx.$queryRawUnsafe(`SELECT id FROM "CostCode" WHERE id = $1 FOR SHARE`, costCodeId);
    }
}

/**
 * Take the four share locks, in the ONE order every caller uses.
 *
 * Exported so a caller that needs the job's whole phase list held still (the
 * attribution backfill re-reads it under the lock) can take the same locks in
 * the same order rather than inventing a second ordering to deadlock against.
 *
 * A thin projection of `lockAttributionParents` — the project-scoped shape of
 * the same acquisition — so the order has exactly ONE definition.
 */
export async function lockPhaseRowsForShare(
    tx: PhaseTxClient,
    projectId: string | null,
    costCodeId?: string | null,
): Promise<void> {
    if (!projectId) return;
    await lockAttributionParents(tx, { projectId, costCodeId });
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
