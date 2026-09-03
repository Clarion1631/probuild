// @ts-nocheck
//
// These one-shot operational scripts were `.mjs` until the rename that made
// `node --import=tsx` able to resolve their named imports from src/. They have
// never been typechecked, and this marker keeps that true rather than quietly
// changing what CI enforces in the same commit that changed the file
// extension. `tsconfig.json` excludes `scripts/`; the only reason tsc sees this
// file at all is that a test imports it.
//
// Worth typing properly — but as its own change, where a type error is a
// finding rather than rebase noise.
/**
 * Backfill Expense attribution (Receipt Pipeline v2, Phase 3 —
 * docs/plans/PHASE-3-ATTRIBUTION-SPEC.md §6).
 *
 * Three passes, in order:
 *   (a) projectId from the owning estimate, where it is still NULL. Belt and
 *       braces: scripts/apply-expense-attribution.mjs already ran the same
 *       UPDATE. This reports the count so a non-zero here is a signal that the
 *       apply script was skipped or that new rows arrived uncoded.
 *   (b) item fallback: an uncoded expense linked to a CODED estimate item
 *       copies that item's cost code (source "backfill"). Production expects
 *       ~0 rows today — expenses rarely carry an itemId — and it becomes live
 *       the moment item-level capture starts.
 *   (c) the rule suggester (src/lib/expense-cost-suggest.ts) for everything
 *       left, scoped to In Progress customer jobs with the overhead bucket
 *       excluded BY ID, not by name.
 *
 * DRY RUN IS THE DEFAULT and it is not decoration. The rules have a proven
 * failure mode: a $3,317.78 Mesplay excavator rental was matched to 20-CLEAN
 * and caught only because a human read the dry-run table. Nothing here writes
 * without --apply, and the table it prints is what Justin reviews.
 *
 * TWO THINGS IT MUST NEVER DO, both in the update predicate rather than in the
 * loop's discipline: overwrite an existing cost code, and overwrite a HUMAN's
 * (costCodeSource "capture", "manual" or "manual-none" — HUMAN_COST_CODE_SOURCES).
 *
 * RUNTIME: this file imports TypeScript from src/, so it needs a TS loader.
 *   node --import=tsx scripts/...
 * Plain `node` works on this machine (Node 24 strips types) and FAILS on CI's
 * Node 20 and on anything older — which is exactly where a one-shot data script
 * gets run in a hurry. `--import=tsx` is the same loader the test suite uses,
 * so there is one answer rather than a version-dependent one.
 *
 * USAGE
 *   node --import=tsx scripts/backfill-expense-attribution.ts                # dry run
 *   node --import=tsx scripts/backfill-expense-attribution.ts --csv out.csv  # + remainder CSV
 *   node --import=tsx scripts/backfill-expense-attribution.ts --apply        # write
 *
 * A re-run after --apply must report 0 planned changes. That is the proof, and
 * it is the same rule scripts/backfill-estimate-item-cost-codes.mjs follows.
 */
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
// The SHARED target guard — the same module scripts/apply-expense-attribution.mjs
// imports, so the two scripts cannot check different things (round 48, item 5).
import { resolveTargetOrRefuse, verifyTargetIdentity } from "./lib/apply-target.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { suggestCode } from "../src/lib/expense-cost-suggest";
import {
    HUMAN_COST_CODE_SOURCES,
    notHumanCodedExpenseWhere,
    resolveExpenseCostCodeId,
    resolveExpenseProjectId,
} from "../src/lib/expense-attribution";
import { OVERHEAD_PROJECT_ID } from "../src/lib/overhead-project";
import { lockExpense } from "../src/lib/expense-lock";
import { lockAttributionParents, provePhaseMembershipTx } from "../src/lib/phase-invariant";
import { PHASE_ELIGIBLE_ESTIMATE_WHERE } from "../src/lib/project-phases";
import { csvCell, csvNumber } from "../src/lib/csv-safe";

/**
 * Both current tiers clear this (0.9 vendor, 0.75 line), so it changes nothing
 * today. It exists so that ADDING a weaker tier later is a deliberate act:
 * without a floor, a future 0.4 rule would start writing to the books silently.
 */
export const MIN_CONFIDENCE = 0.7;

const num = v => (v == null ? 0 : Number(v));
const money = v =>
    `$${num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

/**
 * Coverage on the variance report's own basis: ABSOLUTE dollars.
 *
 * `Expense.amount` is signed — refunds and credit memos are normal — so netting
 * could drive the denominator toward zero and report "100% attributed" on data
 * that was 0% attributed. Magnitude of money moved is the honest base, and it
 * is the same choice computeProjectVariance makes (job-variance.ts).
 */
/**
 * Build the per-expense item lookup the VARIANCE REPORT would use.
 *
 * The variance report resolves an item link only within the project's own item
 * pool (job-variance-db.ts), so an expense pointing at another job's line item
 * is unattributed there. A single global id->code map does not model that: it
 * counted cross-job dollars as covered, which is the one direction this
 * metric must not flatter.
 *
 * KEYED BY `projectId:itemId`, not by item id alone (Codex round 21, item 4).
 *
 * A bare item-id key made the map say "item I resolves to code C" as a global
 * fact, and it is not one: the entry is admitted only after checking that the
 * link does not cross jobs, and then any OTHER row pointing at item I — a
 * corrupt cross-job expense on a different project, exactly the row the scoping
 * exists to exclude — read the same entry back and was counted as covered. The
 * compound key makes the scope part of the lookup rather than part of a check
 * done once, so a false positive is unrepresentable rather than merely avoided.
 */
export function coverageKey(projectId, itemId) {
    return projectId && itemId ? `${projectId}:${itemId}` : null;
}

export function scopedItemCostCodes(rows, items, allowedCodesByProject) {
    const scoped = new Map();
    for (const row of rows) {
        if (!row.itemId) continue;
        const item = items.get(row.itemId);
        if (!item || !item.costCodeId) continue;
        const projectId = resolveExpenseProjectId(row);
        // The cross-job gate is unconditional: a link to another job's line
        // item resolves to nothing on the variance page and must resolve to
        // nothing here.
        if (!projectId || item.projectId !== projectId) continue;
        // The PHASE gate is optional (round 48, item 3). It is the WRITE rule
        // — an active code carried by a committed estimate — and belongs to
        // callers deciding what this script may write. A caller MEASURING what
        // the variance report shows passes null, because that report keeps
        // draft/archived attribution-only items and never checks `isActive`;
        // applying the write rule there reported money as unattributed that the
        // page itself attributes.
        if (allowedCodesByProject) {
            const allowed = allowedCodesByProject.get(projectId);
            if (!allowed || !allowed.has(item.costCodeId)) continue;
        }
        scoped.set(coverageKey(projectId, row.itemId), item.costCodeId);
    }
    return scoped;
}

export function measureCoverage(rows, itemCostCodeById = new Map()) {
    let attributed = 0;
    let unattributed = 0;
    let codedCount = 0;
    for (const row of rows) {
        const amount = Math.abs(num(row.amount));
        // THE SAME RESOLVER AND THE SAME ITEM UNIVERSE the variance report uses.
        //
        // Counting only `costCodeId` overstated the improvement twice over: a
        // row already resolvable through its `itemId` was counted as
        // unattributed BEFORE, then copying that same code counted as new
        // coverage AFTER. The headline was measuring the backfill's activity,
        // not the report's coverage.
        //
        // The item half is looked up under the row's OWN job, so a row pointing
        // at another job's line item resolves to nothing here — which is what
        // the variance report itself does with it.
        const key = coverageKey(resolveExpenseProjectId(row), row.itemId ?? null);
        const resolved = resolveExpenseCostCodeId(
            {
                costCodeId: row.costCodeId ?? null,
                itemId: key,
                // A person's explicit "no phase" suppresses the item fallback
                // (round 42, item 2), so the coverage table counts the row as
                // unattributed -- which is what the variance report now says.
                costCodeSource: row.costCodeSource ?? null,
            },
            itemCostCodeById,
        );
        if (resolved) {
            attributed += amount;
            codedCount += 1;
        } else {
            unattributed += amount;
        }
    }
    const total = attributed + unattributed;
    return { attributed, unattributed, total, codedCount, count: rows.length };
}

/**
 * Decide every write WITHOUT touching the database, so the dry run can show the
 * exact same set the apply would perform. Pure and unit-tested.
 *
 * @param expenses rows with { id, estimateId, projectId, estimate:{projectId},
 *   costCodeId, costCodeSource, itemId, amount, vendor, description, date }
 * @param items item id -> { estimateId, projectId, costCodeId } for every CODED
 *   estimate item, so the link can be checked before it is trusted
 * @param costCodeIdByCode "03-PLUMB" -> cost code id
 * @param scopedProjectIds the In Progress, non-overhead jobs the suggester may touch
 * @param allowedCodesByProject project id -> the cost code ids that are actually
 *   PHASES OF THAT JOB. "The cost code exists" is not a permission
 *   (src/lib/cost-coding.ts SCOPE note), and a rule that fires on a vendor name
 *   knows nothing about which phases the job has.
 */
export function planBackfill({
    expenses,
    items,
    costCodeIdByCode,
    scopedProjectIds,
    allowedCodesByProject = new Map(),
}) {
    const inScope = new Set(scopedProjectIds);
    const projectFills = [];
    const codeFills = [];
    const remainder = [];
    const add = (expense, reason) => remainder.push({ ...expense, reason });

    for (const expense of expenses) {
        const resolvedProjectId = resolveExpenseProjectId(expense);
        if (expense.projectId === null && resolvedProjectId) {
            projectFills.push({
                id: expense.id,
                projectId: resolvedProjectId,
                // The estimate this project was DERIVED from. `projectId IS
                // NULL` alone does not say the derivation is still valid: an
                // expense re-pointed at a different estimate has a different
                // project, and filling it from the old one would attribute the
                // money to a job it was moved off.
                expectedEstimateId: expense.estimateId,
            });
        }

        // NEVER re-code a row that already has a code, and never touch a
        // human's. The same two conditions are repeated in the update
        // predicate — this one keeps the dry-run table honest, that one keeps
        // the write safe, and neither is allowed to be the only guard.
        if (expense.costCodeId) continue;
        // Read off HUMAN_COST_CODE_SOURCES rather than naming the values here:
        // this line used to spell out "capture" and "manual", and when
        // "manual-none" joined them (round 36, item 3) the update predicate
        // below learned about it through notHumanCodedExpenseWhere() while this
        // one did not. A dry-run table that lists a row the write then refuses
        // is the mildest version of that bug; the loud one is the reverse.
        if ((HUMAN_COST_CODE_SOURCES as readonly string[]).includes(expense.costCodeSource ?? "")) continue;

        // (b) ITEM FALLBACK — and the link has to be checked before it is
        // trusted (Codex round 1, blocker 3).
        //
        // `Expense.itemId` is `ON DELETE SET NULL` and has never been scoped to
        // the expense's own estimate on any historical write path, so a stored
        // itemId can point at a line item on somebody else's job. Copying its
        // cost code would move a phase across jobs and call the result
        // "backfill" — a wrong code is worse than an absent one, and this is
        // exactly the kind of wrong that no one would notice.
        //
        // THE TEST IS THE PROJECT, and only the project (Codex round 2). An
        // earlier version also accepted `item.estimateId === expense.estimateId`
        // as a shortcut. That shortcut is unsound in the one case it uniquely
        // covers: a shared estimate whose own `projectId` is NULL or has moved
        // means two rows can agree on an estimate while the expense resolves to
        // a different job — and the shortcut would accept exactly then, because
        // the project check had already failed. Same-estimate is a SUBSET of
        // same-project whenever both are known, so dropping it loses nothing
        // real and removes the branch where the two disagree.
        const item = expense.itemId ? items.get(expense.itemId) : undefined;
        // OWNERSHIP FIRST, ELIGIBILITY SECOND (round 44, item 3).
        //
        // These used to be one condition: a link only got checked for crossing
        // jobs if its item ALSO had a usable code, because the map was filtered
        // to those. So a cross-job link whose code was null or retired looked
        // like a link to a missing item, fell through to regex suggestion, and
        // was never reported for a human to fix. Whether the link crosses jobs
        // has nothing to do with what code the item carries, and it is now
        // asked first and on its own.
        if (item) {
            const sameProject =
                resolvedProjectId !== null &&
                item.projectId !== null &&
                item.projectId === resolvedProjectId;
            if (!sameProject) {
                add(expense, "item-outside-estimate");
                continue;
            }
        }
        if (expense.itemId && !item) {
            // A link to an item that is GONE (deleted, or never existed): no
            // answer either way, so fall through to the rules below.
        } else if (item && item.costCodeId) {
            // The item link proves the job; it does NOT prove the code is a
            // live phase of that job. An item on a draft estimate can carry a
            // code the job never committed to, so the same phase gate the
            // suggester passes through applies here too.
            const allowedForItem = allowedCodesByProject.get(resolvedProjectId);
            if (!allowedForItem || allowedForItem.size === 0) {
                add(expense, "no-phases");
                continue;
            }
            if (!allowedForItem.has(item.costCodeId)) {
                add(expense, "phase-not-on-project");
                continue;
            }
            codeFills.push({
                id: expense.id,
                costCodeId: item.costCodeId,
                costCodeSource: "backfill",
                costCodeConfidence: null,
                why: "item cost code (same project)",
                expectedProjectId: resolvedProjectId,
                expectedUpdatedAt: expense.updatedAt ?? null,
                expense,
            });
            continue;
        }

        // (c) the rules, only on active customer jobs.
        if (!resolvedProjectId) {
            add(expense, "no-project");
            continue;
        }
        if (!inScope.has(resolvedProjectId)) {
            add(expense, "out-of-scope");
            continue;
        }
        const suggestion = suggestCode(expense);
        const costCodeId = suggestion ? costCodeIdByCode.get(suggestion.code) : undefined;
        // A phase the job does not have is not an answer, however confident the
        // regex was. Same rule the clock-in route enforces via
        // isCostCodeAllowedForProject — applied here too, because an automated
        // write has less standing to invent a phase than a human does, not more.
        //
        // FAILS CLOSED. An earlier version wrote `allowed && !allowed.has(...)`,
        // which skipped the rejection entirely when the map had no entry for
        // the project — and it has no entry in exactly one case: the job has no
        // coded estimate items at all, i.e. the job whose phases we know the
        // LEAST about. That is the one where a global code match is most likely
        // to be wrong, so it now needs a positive answer, not the absence of a
        // negative one.
        if (costCodeId) {
            const allowed = allowedCodesByProject.get(resolvedProjectId);
            if (!allowed || allowed.size === 0) {
                add(expense, "no-phases");
                continue;
            }
            if (!allowed.has(costCodeId)) {
                add(expense, "phase-not-on-project");
                continue;
            }
        }
        if (suggestion && costCodeId && suggestion.confidence >= MIN_CONFIDENCE) {
            codeFills.push({
                id: expense.id,
                costCodeId,
                costCodeSource: "ai",
                costCodeConfidence: suggestion.confidence,
                why: suggestion.why,
                // The attribution the decision was scoped by, as it will be
                // AFTER pass (a) has run — which is the state the write
                // actually meets.
                expectedProjectId: resolvedProjectId,
                expectedUpdatedAt: expense.updatedAt ?? null,
                expense,
            });
        } else {
            add(expense, suggestion ? "unknown-code" : "no-rule-match");
        }
    }

    return { projectFills, codeFills, remainder };
}

/** Coverage as it WOULD be after the planned code fills — the dry run's whole point. */
export function projectedRows(expenses, codeFills) {
    const byId = new Map(codeFills.map(fill => [fill.id, fill.costCodeId]));
    return expenses.map(expense => ({
        ...expense,
        costCodeId: expense.costCodeId ?? byId.get(expense.id) ?? null,
    }));
}

/**
 * One cell of free text, collapsed to a single line and capped.
 *
 * The collapse and the cap are this script's own presentation choice — a
 * 4,000-character receipt description makes the CSV unreadable. The QUOTING and
 * the formula neutralization are NOT: they come from src/lib/csv-safe.ts, the
 * same helper the tax report uses. This used to be a private `csvEscape` that
 * only quoted, which left every vendor and description in this file executable
 * when Marge opened it — and vendor names here are OCR output.
 */
function textCell(value) {
    return csvCell(String(value ?? "").replace(/\s+/g, " ").slice(0, 160));
}

export function remainderCsv(remainder, projectNameById) {
    const lines = [["expense_id", "project", "date", "vendor", "amount", "reason", "description"].join(",")];
    for (const expense of remainder) {
        lines.push([
            textCell(expense.id),
            textCell(projectNameById.get(resolveExpenseProjectId(expense)) ?? ""),
            textCell(expense.date ? new Date(expense.date).toISOString().slice(0, 10) : ""),
            textCell(expense.vendor),
            csvNumber(num(expense.amount)),
            // WHY it is here. "item-outside-estimate" in particular is not
            // "we could not guess" — it is "this row claims a line item on
            // another job", which is a data problem a human should look at.
            textCell(expense.reason),
            textCell(expense.description),
        ].join(","));
    }
    return lines.join("\n");
}

/**
 * The whole run, with every external effect injected so
 * tests/backfill-expense-attribution.test.ts can drive it with a prisma-shaped
 * stub and assert that a dry run makes ZERO write calls.
 */
/**
 * Run one write inside a transaction that first takes the shared per-expense
 * advisory lock, so this script is ORDERED against the QBO sync, the tax PATCH
 * and the booking fill rather than racing them.
 *
 * Falls back to a bare call when the injected client has no `$transaction` —
 * the unit tests drive a plain stub, and requiring one there would test the
 * stub rather than the script.
 */
export async function writeUnderExpenseLock(db, expenseId, run) {
    return writeUnderAttributionLocks(db, { expenseId }, run);
}

/**
 * SHARE-LOCK THE ROWS A DECISION IS DERIVED FROM, in one fixed order.
 *
 * `FOR SHARE` blocks anyone trying to UPDATE or DELETE these rows until this
 * transaction commits, while letting other readers through. That is exactly the
 * shape of the hazard: the expense's own row is protected by the per-expense
 * advisory lock and by compare-and-set predicates, but the FACTS the write is
 * derived from live on OTHER rows — the estimate whose `projectId` supplies
 * the attribution, the estimate item whose `costCodeId` is copied, and the
 * job's phase rows that decide whether a code is even allowed. A predicate can
 * catch a row that moved BEFORE the write; it cannot stop it moving DURING the
 * read sequence that decides what to write.
 *
 * The acquisition itself is `lockAttributionParents` in
 * src/lib/phase-invariant.ts — the ONE definition of the order, shared with
 * every live writer, so this script and a bookkeeper's save cannot walk these
 * tables in opposite directions. This file deliberately owns NO scan of its
 * own: a local one would be a second definition of the order, which is how the
 * inversion below got written in the first place.
 */
// The job's phase rows are held by the SHARED helper in expense-lock.ts, which
// the receipt booking takes too — one statement, one lock order, so the two
// writers of a cost code cannot deadlock against each other.

/**
 * One transaction: the derived-from rows are share-locked FIRST, then the
 * per-expense advisory lock, then the caller reads and writes. Locks before
 * reads, always — a read taken before its lock describes a moment that the lock
 * then fails to preserve.
 *
 * Falls back to a bare call when the injected client has no `$transaction`:
 * some unit tests drive a plain stub, and requiring one there would test the
 * stub rather than the script.
 */
export async function writeUnderAttributionLocks(db, locks, run) {
    const {
        expenseId,
        estimateIds = [],
        estimateItemIds = [],
        phaseProjectId = null,
        costCodeId = null,
    } = locks;
    if (typeof db.$transaction !== "function") return run(db);
    return db.$transaction(async tx => {
        // THE WHOLE UNION, IN ONE CALL (round 46, item 2).
        //
        // This used to be four calls: the job's phase rows through
        // `lockPhaseRowsForShare`, then the named Estimates, then the named
        // EstimateItems, then the CostCode. Hoisting the job-scoped scan to
        // the front fixed the ordering of the tables it covers and left a
        // hole one row wide behind it: the planner names estimates and items
        // the project-scoped scan never saw — an expense whose estimate
        // belongs to no job, or to a DIFFERENT job (that is what
        // `estimateIds` is for). For those, statement 2 locked an Estimate
        // AFTER statement 3 had already locked EstimateItems of the scanned
        // job — EstimateItem -> Estimate, the inversion, one job over from
        // where anyone was looking.
        //
        // Passing the complete set to `lockAttributionParents` makes it emit
        // exactly ONE statement per table, in the global order, with every id
        // ascending inside it. There is no second scan left to get wrong.
        await lockAttributionParents(tx, {
            projectId: phaseProjectId,
            estimateIds,
            itemIds: estimateItemIds,
            // THE CANDIDATE CODE ITSELF (round 20, item 5). `isActive` is a
            // company-wide switch with nothing to do with this job's phase
            // rows, so locking those did not hold it: a code retired while
            // this pass ran was still written, by the one writer with no
            // human behind it.
            costCodeId,
        });
        await lockExpense(tx, expenseId);
        return run(tx);
    });
}

/**
 * Is this cost code STILL active? Asked immediately before the update, on the
 * transaction that holds it. Retiring a code is how the company says "stop
 * putting money here", and an automated pass is exactly the writer that would
 * otherwise keep doing it for the rest of the run.
 */
export async function costCodeStillActive(tx, costCodeId) {
    if (!costCodeId) return false;
    const rows = await tx.$queryRawUnsafe(
        `SELECT "isActive" FROM "CostCode" WHERE id = $1`,
        costCodeId,
    );
    return Boolean(rows?.[0]?.isActive);
}

export async function runBackfill({
    db,
    apply = false,
    // Annotated rather than left to inference: a bare `null` default infers the
    // parameter as `null`, and every caller that passes a real path (including
    // the test) then fails to typecheck.
    // Real annotations now the file is TypeScript. They are not error-checked
    // (see @ts-nocheck at the top) but they still type the EXPORT, which is
    // what callers and tests see — a bare `= null` default would infer the
    // parameter as `null` and reject every real path.
    csvPath = null as string | null,
    writeFile = writeFileSync as (path: string, body: string) => void,
    log = console.log as (message: string) => void,
    overheadProjectId = OVERHEAD_PROJECT_ID,
}) {
    const [projects, costCodes] = await Promise.all([
        db.project.findMany({ select: { id: true, name: true, status: true } }),
        db.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true } }),
    ]);
    const projectNameById = new Map(projects.map(p => [p.id, p.name]));
    const costCodeIdByCode = new Map(costCodes.map(c => [c.code, c.id]));
    // Overhead is excluded BY ID. The original script excluded it by NAME
    // ("Shop"), which silently stops working the day the project is renamed.
    const scopedProjectIds = projects
        .filter(p => p.status === "In Progress" && p.id !== overheadProjectId)
        .map(p => p.id);

    const expenses = await db.expense.findMany({
        select: {
            id: true, estimateId: true, projectId: true, costCodeId: true, costCodeSource: true,
            itemId: true, amount: true, vendor: true, description: true, date: true,
            // The row version each planned write is judged against.
            updatedAt: true,
            estimate: { select: { projectId: true } },
        },
    });

    // OWNERSHIP FOR EVERY LINKED ITEM, WHATEVER ITS CODE (round 44, item 3).
    //
    // This map used to be filtered to items with a non-null, ACTIVE cost code,
    // which quietly made it two things at once: "who owns this item" and "is
    // its code usable". A cross-job item whose code is null or retired then
    // looked MISSING rather than foreign, the writer read that as "no answer
    // either way", and the row fell through to regex suggestion — so a link
    // that should have been reported `item-outside-estimate` for a human to
    // fix was instead quietly guessed at, and never appeared in the remainder
    // CSV at all.
    //
    // Ownership is now loaded unconditionally, and eligibility stays where it
    // already lives (`allowedCodesByProject`, built from committed estimates).
    // Scoped to the items expenses actually LINK to, so widening the filter
    // does not turn this into a full-table read.
    // ...AND THE ITEMS ONLY TIME ENTRIES POINT AT (round 48, item 3).
    //
    // The labor half of the coverage metric resolves `TimeEntry.estimateItemId`
    // through this very map, and the query below used to be scoped to the items
    // EXPENSES link to. Labor whose phase comes only from its line item —
    // exactly what the clock-in flow produces — therefore found no entry and
    // was reported as unattributed, which understated the one metric the
    // rollout is judged on. The time entries are read here, before the map,
    // rather than in the middle of the report where they used to be.
    const timeEntries = await db.timeEntry.findMany({
        where: { projectId: { in: scopedProjectIds } },
        select: {
            costCodeId: true, estimateItemId: true, laborCost: true, burdenCost: true,
            // Needed to scope the item fallback to the entry's OWN job.
            projectId: true,
        },
    });
    const linkedItemIds = [...new Set([
        ...expenses.map(e => e.itemId),
        ...timeEntries.map(t => t.estimateItemId),
    ].filter(Boolean))];
    const itemRowsRaw = linkedItemIds.length
        ? await db.estimateItem.findMany({
            where: { id: { in: linkedItemIds } },
            select: {
                id: true, costCodeId: true, estimateId: true,
                costCode: { select: { isActive: true } },
                estimate: { select: { projectId: true } },
            },
        })
        : [];
    const itemRows = itemRowsRaw.map(row => ({
        id: row.id,
        // A RETIRED code is not a usable code. Normalising it to null here
        // keeps the two questions separate: the row still says who OWNS the
        // item, and every reader of `costCodeId` gets the same answer it got
        // when the query itself did the filtering.
        costCodeId: row.costCode?.isActive ? row.costCodeId : null,
        // WHAT THE VARIANCE REPORT SEES (round 48, item 3). The report's
        // attribution pool is every coded line item on the project's estimates
        // — any status, and with no `costCode.isActive` filter (see
        // `attributionOnlyItems` in src/lib/job-variance-db.ts). Measuring
        // coverage through the WRITE-eligibility view above called those rows
        // unattributed when the page itself attributes them, so the script and
        // the page disagreed about the same seed.
        reportedCostCodeId: row.costCodeId ?? null,
        estimateId: row.estimateId,
        projectId: row.estimate?.projectId ?? null,
    }));
    const items = new Map(itemRows.map(row => [row.id, {
        costCodeId: row.costCodeId,
        estimateId: row.estimateId,
        projectId: row.projectId,
    }]));
    const itemCostCodeById = new Map(itemRows.map(row => [row.id, row.costCodeId]));
    // The same ownership, with the code the REPORT would use. Two maps rather
    // than one flag, because every reader of `items` is a WRITE decision and
    // every reader of this one is a MEASUREMENT.
    const reportingItems = new Map(itemRows.map(row => [row.id, {
        costCodeId: row.reportedCostCodeId,
        estimateId: row.estimateId,
        projectId: row.projectId,
    }]));

    // THE PHASES EACH JOB ACTUALLY HAS — the same set the app itself uses.
    //
    // An earlier version built this from `itemRows` above, which is every coded
    // estimate item on any estimate at all. That let a code from a DRAFT or
    // ARCHIVED estimate, or an INACTIVE cost code, count as "a phase of this
    // job" — so the fail-closed check was looser than it claimed, and looser
    // than the clock-in route it is supposed to mirror. This now applies
    // PHASE_ELIGIBLE_ESTIMATE_WHERE and `costCode.isActive`, exactly as
    // resolveProjectPhaseCodes does.
    //
    // The Safety phase is deliberately NOT appended: resolveProjectPhaseCodes
    // adds it for In Progress jobs, but a materials receipt is never a safety
    // meeting and this pass has no business assigning one.
    const phaseRows = await db.estimateItem.findMany({
        where: {
            costCodeId: { not: null },
            costCode: { isActive: true },
            estimate: { ...PHASE_ELIGIBLE_ESTIMATE_WHERE },
        },
        select: { costCodeId: true, estimate: { select: { projectId: true } } },
    });
    const allowedCodesByProject = new Map();
    for (const row of phaseRows) {
        const projectId = row.estimate?.projectId ?? null;
        if (!projectId || !row.costCodeId) continue;
        if (!allowedCodesByProject.has(projectId)) allowedCodesByProject.set(projectId, new Set());
        allowedCodesByProject.get(projectId).add(row.costCodeId);
    }

    // ROW-SCOPED RE-READ, for the write phase only.
    //
    // The two maps above are a SNAPSHOT taken before a loop that can run for
    // minutes. Re-planning under the lock (below) proved the row itself had not
    // moved, but it was still re-planned against those stale maps — so an
    // estimate moved to another project, or an item re-coded after the
    // snapshot, would be invisible and the pass would write a code that was
    // correct only in the past.
    //
    // This reads the same thing the snapshot did, but for ONE item, inside the
    // transaction that is about to write.
    //
    // THE PHASE LIST IS NO LONGER RE-READ HERE (round 34, item 3). It used to
    // be, with a plain `estimateItem.findMany` — an UNLOCKED query, taken
    // inside the transaction but holding nothing. That is the same phantom the
    // shared invariant module was rewritten to close in round 32: under READ
    // COMMITTED a concurrent transaction can insert an estimate and a line item
    // and commit them between this script's lock scans and this read, and this
    // read WILL see them (each statement takes a fresh snapshot). The verdict
    // then rested on a row nothing was holding, so the item could be deleted —
    // or its estimate archived or moved to another job — before this pass's own
    // UPDATE committed, and the money landed on a phase the job does not have.
    // The proof with the `FOR SHARE OF ei, e` clause is the fix, and it lives
    // in src/lib/phase-invariant.ts; it is called below, immediately before the
    // write, rather than reimplemented here.
    const readItem = async (tx, itemId) => {
        const fresh = new Map();
        if (!itemId) return fresh;
        const row = await tx.estimateItem.findUnique({
            where: { id: itemId },
            select: {
                id: true, costCodeId: true, estimateId: true,
                costCode: { select: { isActive: true } },
                estimate: { select: { projectId: true } },
            },
        });
        // OWNERSHIP SURVIVES A MISSING CODE (round 48, item 4).
        //
        // This used to return an EMPTY map when the item had no code, or a
        // retired one — which `planBackfill` cannot tell apart from "there is
        // no such item". So a cross-job link whose code had just been cleared
        // stopped being reported as `item-outside-estimate` and fell through to
        // regex inference instead: the locked re-plan reintroduced, one
        // transaction later, exactly the bug round 44 fixed in the snapshot.
        //
        // The two questions stay separate here, as they do in the snapshot: the
        // row still says who OWNS the item, and an unusable code reads as null.
        if (!row) return fresh;
        fresh.set(row.id, {
            costCodeId: row.costCode?.isActive ? row.costCodeId : null,
            estimateId: row.estimateId,
            projectId: row.estimate?.projectId ?? null,
        });
        return fresh;
    };

    const plan = planBackfill({
        expenses, items, costCodeIdByCode, scopedProjectIds, allowedCodesByProject,
    });

    // ── the table ───────────────────────────────────────────────────────────
    const scoped = new Set(scopedProjectIds);
    const inScopeExpenses = expenses.filter(e => scoped.has(resolveExpenseProjectId(e) ?? ""));
    // Project-scoped, exactly as the variance page is — but NOT phase-validated
    // (round 48, item 3). Passing `allowedCodesByProject` here applied the
    // WRITE rule (an active code on a committed estimate) to a MEASUREMENT of
    // what the report shows, and the report keeps draft/archived
    // attribution-only items and never checks `isActive`. The cross-job scope
    // stays, because the page really does drop a link to another job's item.
    const coverageItems = scopedItemCostCodes(inScopeExpenses, reportingItems, null);
    const before = measureCoverage(inScopeExpenses, coverageItems);
    const after = measureCoverage(projectedRows(inScopeExpenses, plan.codeFills), coverageItems);

    log(`scope: ${scopedProjectIds.length} In Progress customer job(s); overhead project ${overheadProjectId} excluded`);
    log("");
    log("per job (expense dollars with a resolvable cost code):");
    log(`  ${"job".padEnd(34)} ${"coded".padStart(11)} ${"total".padStart(13)}  before -> after`);
    for (const projectId of scopedProjectIds) {
        const rows = inScopeExpenses.filter(e => resolveExpenseProjectId(e) === projectId);
        if (rows.length === 0) continue;
        const b = measureCoverage(rows, coverageItems);
        const a = measureCoverage(projectedRows(rows, plan.codeFills), coverageItems);
        log(
            `  ${(projectNameById.get(projectId) ?? projectId).slice(0, 34).padEnd(34)} ` +
            `${`${a.codedCount}/${a.count}`.padStart(11)} ${money(a.total).padStart(13)}  ` +
            `${pct(b.attributed, b.total)} -> ${pct(a.attributed, a.total)}`,
        );
    }
    log("");
    log(`EXPENSE dollar coverage: ${pct(before.attributed, before.total)} -> ${pct(after.attributed, after.total)}  (${money(after.attributed)} of ${money(after.total)})`);

    // The §1.6 headline is measured on the variance page's basis, which counts
    // LABOR as well. Reporting only the expense share would flatter the number,
    // because clock-in already requires a phase.
    // PROJECT-SCOPED, exactly like the expense side. A time entry pointing at
    // another job's estimate item is unattributed on the variance page, so
    // resolving it through a global id->code map counted labor dollars as
    // covered that the report itself does not — the same flattering error the
    // expense metric had.
    const laborItems = scopedItemCostCodes(
        timeEntries.map(t => ({
            projectId: t.projectId,
            estimate: null,
            itemId: t.estimateItemId,
        })),
        reportingItems,
        null,
    );
    const laborRows = timeEntries.map(t => ({
        costCodeId: resolveExpenseCostCodeId(
            // Same compound key the map was built with — a time entry pointing
            // at another job's item must not read that job's entry back.
            { costCodeId: t.costCodeId, itemId: coverageKey(t.projectId, t.estimateItemId) },
            laborItems,
        ),
        amount: num(t.laborCost) + num(t.burdenCost),
    }));
    const labor = measureCoverage(laborRows);
    const variancedBefore = before.attributed + labor.attributed;
    const variancedAfter = after.attributed + labor.attributed;
    const variancedTotal = after.total + labor.total;
    log(`VARIANCE-BASIS coverage (labor + expenses, the §1.6 metric): ${pct(variancedBefore, variancedTotal)} -> ${pct(variancedAfter, variancedTotal)}`);
    log("");
    log(`planned writes: ${plan.projectFills.length} projectId, ${plan.codeFills.length} cost code`);
    const byCode = new Map();
    for (const fill of plan.codeFills) {
        const key = `${fill.costCodeId} (${fill.costCodeSource})`;
        const entry = byCode.get(key) ?? { n: 0, sum: 0 };
        entry.n += 1;
        entry.sum += Math.abs(num(fill.expense.amount));
        byCode.set(key, entry);
    }
    for (const [key, v] of [...byCode.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
        log(`  ${key.padEnd(40)} ${String(v.n).padStart(4)} rows  ${money(v.sum).padStart(13)}`);
    }
    log(`NEEDS HUMAN: ${plan.remainder.length} rows  ${money(plan.remainder.reduce((t, e) => t + Math.abs(num(e.amount)), 0))}`);
    const byReason = new Map();
    for (const expense of plan.remainder) {
        byReason.set(expense.reason, (byReason.get(expense.reason) ?? 0) + 1);
    }
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
        // A non-zero "item-outside-estimate" is a DATA problem, not a coding
        // gap: some expense points at a line item on another job.
        log(`  ${String(reason).padEnd(24)} ${String(n).padStart(4)} rows`);
    }

    if (csvPath) {
        writeFile(csvPath, remainderCsv(plan.remainder, projectNameById));
        log(`wrote ${csvPath} (${plan.remainder.length} rows for Marge)`);
    }

    // The measured numbers, RETURNED and not merely printed (round 48, item 3).
    // tests/backfill-coverage-parity-db.test.ts re-computes the same figures
    // with `computeProjectVariance` over the same seed and asserts they agree;
    // a metric nobody can compare against its own source is a claim, not a
    // measurement.
    const coverage = {
        expenses: { before, after },
        labor,
        varianceBasis: { before: variancedBefore, after: variancedAfter, total: variancedTotal },
    };

    if (!apply) {
        log("");
        log("DRY RUN — nothing written. Re-run with --apply once the table above is reviewed.");
        return { plan, before, after, coverage, written: { projectIds: 0, costCodes: 0 } };
    }

    // ── the writes ──────────────────────────────────────────────────────────
    let projectIdsWritten = 0;
    // Grouped by (project, estimate) rather than by project alone: the estimate
    // is half the predicate now, so rows derived from different estimates
    // cannot share one statement.
    const byProject = new Map();
    for (const fill of plan.projectFills) {
        const key = `${fill.projectId}\u0000${fill.expectedEstimateId}`;
        if (!byProject.has(key)) {
            byProject.set(key, { projectId: fill.projectId, estimateId: fill.expectedEstimateId, ids: [] });
        }
        byProject.get(key).ids.push(fill.id);
    }
    for (const { projectId, estimateId, ids } of byProject.values()) {
        // ONE EXPENSE PER TRANSACTION, under the same locks the cost pass uses.
        //
        // Batching the group into a single UPDATE was cheaper, but it could not
        // take a per-expense lock (the ids differ) and it read the estimate only
        // through the predicate. Now the estimate is share-locked for the whole
        // decision, so it cannot move while the row is being written.
        for (const id of ids) {
            const result = await writeUnderAttributionLocks(
                db,
                // `phaseProjectId` IS NOT OPTIONAL HERE (round 38, item 2).
                //
                // This pass writes `Expense.projectId`, and Postgres enforces
                // that foreign key by taking `FOR KEY SHARE` on the referenced
                // `Project` row. Omitting it from the lock set did not mean
                // "no Project lock" — it meant the Project lock was taken
                // IMPLICITLY, by the UPDATE, after this transaction already
                // held the Estimate and the Expense. That is
                // Estimate -> Expense -> Project against a job editor holding
                // its Project row FOR UPDATE, i.e. the same cycle round 36
                // fixed for the cost-code pass, hiding in the one pass whose
                // whole job is writing this column. The loser Postgres picks
                // is as likely to be the bookkeeper's save as this script.
                //
                // Naming it makes `lockPhaseRowsForShare` take the Project
                // FOR SHARE first, so the UPDATE's own key-share lock is a
                // free re-acquisition on a row already held.
                { expenseId: id, estimateIds: [estimateId], phaseProjectId: projectId },
                // BOTH halves of the derivation, re-asserted at write time even
                // though the locks are held: the lock stops the rows moving
                // from here on, the predicate covers everything that happened
                // between the plan and now, and a writer that takes no lock at
                // all is still bound by it.
                //
                // `projectId: null` says nobody has attributed the row yet;
                // `estimateId` says it is still hanging off the estimate this
                // project was READ from; and the relation filter says that
                // estimate still points at the project we are about to stamp.
                // Without the last one, an estimate moved to another job
                // between the plan and the write would stamp every one of its
                // expenses with the OLD project — a cross-job attribution
                // performed by the pass whose whole job is getting attribution
                // right.
                async tx => tx.expense.updateMany({
                    where: {
                        id, projectId: null, estimateId,
                        estimate: { is: { projectId } },
                    },
                    data: { projectId },
                }),
            );
            projectIdsWritten += result.count;
        }
    }

    // COST-CODE WRITES RUN UNDER THE SHARED PER-EXPENSE LOCK, one row at a
    // time, and each is a compare-and-set on the row version its decision was
    // made from.
    //
    // This script is the fourth writer of these columns, alongside the QBO
    // sync, the tax PATCH and the booking fill — and the only one that had been
    // left racing them. Its plan is the STALEST of the four: it is computed for
    // every row up front and then applied in a loop that can take minutes, so
    // "nothing changed since the read" is a much weaker assumption here than
    // anywhere else.
    //
    // A miss is not an error and is not retried: the row moved, so the decision
    // was made about a state that no longer exists. It is counted and reported,
    // and a re-run will plan it again against the truth.
    let costCodesWritten = 0;
    let costCodesSkipped = 0;
    for (const fill of plan.codeFills) {
        // The rows this decision is derived from, named from the PLAN — which
        // is also what the re-read below is checked against, so a row that has
        // since moved off them is skipped rather than written under locks that
        // do not cover it.
        const plannedEstimateId = fill.expense?.estimateId ?? null;
        const plannedItemId = fill.expense?.itemId ?? null;
        // THE ITEM OWNER IS PART OF THE ANSWER (round 48, item 4).
        //
        // `readItem` reads the item's estimate to decide whether the link
        // crosses jobs. That estimate is not necessarily the expense's own, and
        // it was not in the lock set — so the fact the verdict rests on could
        // move while this transaction held everything else still. Named here,
        // from the plan, so `lockAttributionParents` takes it in the canonical
        // order with the rest; the re-read below then refuses if the ownership
        // it locked is not the ownership that exists.
        const plannedItemOwnerEstimateId = plannedItemId
            ? (items.get(plannedItemId)?.estimateId ?? null)
            : null;
        const result = await writeUnderAttributionLocks(db, {
            expenseId: fill.id,
            estimateIds: [plannedEstimateId, plannedItemOwnerEstimateId],
            estimateItemIds: [plannedItemId],
            phaseProjectId: fill.expectedProjectId ?? null,
            costCodeId: fill.costCodeId,
        }, async tx => {
            // RE-READ UNDER THE LOCK, then re-plan against what is really
            // there.
            //
            // The previous version exempted rows that pass (a) had just filled
            // from the version check, because the backfill bumps `updatedAt`
            // itself. That traded one hazard for another: an exempted row had
            // NO version guard at all, so anything a concurrent writer did to
            // it between the plan and the write was invisible. And a row the
            // project pass did NOT touch could still have moved.
            //
            // Reading inside the lock removes the guesswork. The version that
            // goes into the CAS is the CURRENT one, so it names the state this
            // decision is actually being made against — including the
            // `projectId` pass (a) may have just written.
            const current = await tx.expense.findUnique({
                where: { id: fill.id },
                select: {
                    id: true, estimateId: true, projectId: true, costCodeId: true,
                    costCodeSource: true, itemId: true, vendor: true, description: true,
                    updatedAt: true, estimate: { select: { projectId: true } },
                },
            });
            if (!current) return { count: 0 };
            // THE LOCKS HAVE TO COVER THE ROWS THE ANSWER COMES FROM.
            //
            // They were taken from the plan's view of this expense. If the row
            // has since been re-pointed at a different estimate or a different
            // line item, the facts about to be re-read are ones nothing is
            // holding still — so this is not the moment to write. Skipped and
            // counted; a re-run plans it against the truth and locks the rows
            // that truth actually rests on.
            if (
                (current.estimateId ?? null) !== plannedEstimateId ||
                (current.itemId ?? null) !== plannedItemId
            ) {
                return { count: 0 };
            }

            // RE-PLAN, don't re-use.
            //
            // The plan was computed minutes ago from a snapshot. Checking that
            // the row is still ELIGIBLE is not the same as checking that the
            // same answer still follows from it: the vendor, the description
            // and the item link all feed the decision, and an edit to any of
            // them makes the planned code an answer to a question nobody asked
            // any more.
            //
            // `planBackfill` is the single copy of the rules, so it is run
            // again over this one row rather than re-implemented here.
            // The item link, RE-READ for this row inside the lock — not the
            // minutes-old snapshot. See readItem above. The phase list is NOT
            // re-read here any more; see the proof below.
            const resolvedProjectId = current.projectId ?? current.estimate?.projectId ?? null;
            const freshItems = await readItem(tx, current.itemId);
            // THE OWNERSHIP THIS WRITE LOCKED IS THE OWNERSHIP IT JUDGES.
            //
            // If the item has been moved onto a different estimate since the
            // plan, the estimate whose `projectId` decides "does this link
            // cross jobs" is one nothing here is holding. Skipped and counted,
            // like every other moved-under-us case; a re-run plans it against
            // the truth and locks what that truth rests on.
            const freshOwner = current.itemId ? freshItems.get(current.itemId) : undefined;
            if (current.itemId && (freshOwner?.estimateId ?? null) !== plannedItemOwnerEstimateId) {
                return { count: 0 };
            }
            // THE RE-PLAN PROPOSES; THE LOCKED PROOF DECIDES.
            //
            // `planBackfill`'s phase gate is a set-membership test against a
            // map, and the only map that can be handed to it here is the ONE
            // code this write is about — the code the plan chose and the
            // predicate below names. Anything the re-plan lands on that is not
            // that code voids the write on the very next line, so narrowing the
            // map cannot make the re-plan accept something the wider map would
            // have refused; what it does is stop this script deciding phase
            // membership from a list it read for itself, without a lock.
            //
            // Membership is answered by provePhaseMembershipTx instead, below.
            const candidateOnly = resolvedProjectId
                ? new Map([[resolvedProjectId, new Set([fill.costCodeId])]])
                : new Map();
            const replanned = planBackfill({
                expenses: [current],
                items: freshItems,
                costCodeIdByCode,
                scopedProjectIds,
                allowedCodesByProject: candidateOnly,
            });
            const fresh = replanned.codeFills[0];
            // No longer codeable at all, or codeable as something else — either
            // way the planned write is void. A re-run will plan it properly.
            if (!fresh || fresh.costCodeId !== fill.costCodeId) return { count: 0 };
            // IS THIS CODE A PHASE OF THIS JOB — PROVED, AND HELD (round 34,
            // item 3). The shared query answers on THIS transaction and locks
            // the exact estimate/line-item pair its answer came from
            // (`FOR SHARE OF ei, e`), so the row that proved membership is
            // still proving it when the UPDATE below commits. The four scans
            // `writeUnderAttributionLocks` already took cannot do that on
            // their own: they lock what EXISTED when they ran, and a phantom
            // committed afterwards is visible to the next statement and held
            // by nothing.
            //
            // `provePhaseMembershipTx` rather than `assertPhaseOfProjectTx`
            // on purpose. The latter also admits the company Safety phase on an
            // In Progress job with no estimate item behind it, and this pass
            // deliberately does not (see the phaseRows comment above: a
            // materials receipt is never a safety meeting). The proof query is
            // the half that answers the question this script actually asks, and
            // it is the half that carries the lock.
            if (!resolvedProjectId) return { count: 0 };
            if (!(await provePhaseMembershipTx(tx, resolvedProjectId, fresh.costCodeId))) {
                return { count: 0 };
            }
            // A RETIRED CODE IS NOT AN ANSWER, however well the re-plan agrees
            // with the plan — and the proof above does not ask: `isActive` is
            // a company-wide switch, not a fact about this job's phases. Asked
            // here, under the lock taken above, so the answer cannot change
            // between this line and the update below.
            if (!(await costCodeStillActive(tx, fresh.costCodeId))) return { count: 0 };

            return tx.expense.updateMany({
            where: {
                id: fill.id,
                // The version as READ UNDER THIS LOCK — not the one the plan
                // was built from minutes ago.
                ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
                // Everything the plan depended on, re-asserted at write time.
                // The plan is a snapshot taken before pass (a) ran and before
                // any concurrent sync or bookkeeper edit; the predicate is what
                // makes it safe to act on. A row that moved is skipped, not
                // coded on stale reasoning.
                // The RESOLVED project — i.e. the value pass (a) above has
                // just written, not the NULL this row had when the plan was
                // made. Using the pre-fill value meant every legacy row the
                // project pass touched then failed this predicate and silently
                // wrote no cost code at all: an `--apply` that reported success
                // and coded nothing.
                projectId: fill.expectedProjectId,
                costCodeId: null,
                ...notHumanCodedExpenseWhere(),
            },
            data: {
                // From the RE-PLAN, so the provenance and confidence describe
                // the decision that was actually just made.
                costCodeId: fresh.costCodeId,
                costCodeSource: fresh.costCodeSource,
                costCodeConfidence: fresh.costCodeConfidence,
            },
            });
        });
        costCodesWritten += result.count;
        if (result.count === 0) costCodesSkipped += 1;
    }

    log("");
    log(`applied ${projectIdsWritten} projectId and ${costCodesWritten} cost code(s).`);
    if (costCodesSkipped > 0) {
        // Not an error: it means a row changed between the plan and the write,
        // and the predicate did its job. Reported because a LARGE number would
        // mean the plan was stale enough to re-run.
        log(`${costCodesSkipped} planned cost code(s) skipped — the row moved after the plan was made.`);
    }
    log(`${plan.remainder.length} rows left NULL for human review. Re-run (dry) — it must report 0 planned writes.`);
    return {
        plan,
        before,
        after,
        coverage,
        // Skips are part of the outcome, not just a log line: a run that plans
        // a write and then refuses it because the row moved is the correct
        // behaviour, and a test has to be able to see the difference between
        // that and a write that never happened.
        skipped: { costCodes: costCodesSkipped },
        written: { projectIds: projectIdsWritten, costCodes: costCodesWritten },
    };
}

/** A flag's value from argv, read inside main() so import stays inert. */
function expectFlag(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const HELP = `Backfill Expense attribution (Receipt Pipeline v2, Phase 3).

  node --import=tsx scripts/backfill-expense-attribution.ts                # dry run
  node --import=tsx scripts/backfill-expense-attribution.ts --csv out.csv  # + remainder CSV
  node --import=tsx scripts/backfill-expense-attribution.ts --target prod \
      --expect-db <db> --expect-host <host> --apply                        # write

Dry run is the DEFAULT. --apply writes; re-run dry afterwards and it must
report zero planned changes.

--apply REQUIRES --target (prod or ci) plus --expect-db and --expect-host, the
same guard scripts/apply-expense-attribution.mjs uses and from the same shared
module. --target prod reads the URL from .env.production.local (an ambient
DATABASE_URL is IGNORED), requires the Supabase pooler host, requires
APPLY_EXPECT_PROJECT_REF to match the project ref in that URL, and requires the
production baseline migration to be applied. A redacted identity line is
printed before anything is written.

The --import=tsx loader is required: this script imports TypeScript from src/,
and plain node only strips types on Node 22.6+.`;

async function main() {
    // --help must work with NO database and NO env. It is also the CI smoke
    // test that this file can be LOADED under the documented runtime — an
    // import error surfaces here rather than the first time someone runs the
    // real thing against production.
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(HELP);
        return;
    }

    const __dirname = dirname(fileURLToPath(import.meta.url));
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    const apply = process.argv.includes("--apply");
    const csvIdx = process.argv.indexOf("--csv");
    const csvPath = csvIdx > -1 ? process.argv[csvIdx + 1] : null;

    // WHICH DATABASE (round 48, item 5).
    //
    // This script WRITES MONEY COLUMNS — `projectId`, `costCodeId`,
    // `costCodeSource` — and until now it took whatever `DATABASE_URL` the
    // shell happened to hold, after loading .env.local and .env. The DDL apply
    // script had already grown a target guard, a project-ref check and a
    // redacted identity line; this one had none of it, so the more dangerous of
    // the two scripts was the less guarded. Same helper, same checks, imported
    // rather than copied.
    //
    // A DRY RUN still needs no target: it only reads, and forcing a target on
    // it would push people toward `--apply` to get any output at all.
    let url = process.env.DATABASE_URL;
    let target: string | null = null;
    let from = "process.env.DATABASE_URL";
    if (apply) {
        const targeted = resolveTargetOrRefuse(process.argv);
        if (targeted.error) {
            console.error(`REFUSING: ${targeted.error}`);
            process.exitCode = 1;
            return;
        }
        ({ target, url, from } = targeted as { target: string; url: string; from: string });
        if (!expectFlag("--expect-db") || !expectFlag("--expect-host")) {
            console.error(
                "REFUSING: --apply requires --expect-db and --expect-host as well as --target.",
            );
            process.exitCode = 1;
            return;
        }
    }

    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
        if (apply && target) {
            const identity = await verifyTargetIdentity(prisma, {
                target, url, from,
                expectDb: expectFlag("--expect-db"),
                expectHost: expectFlag("--expect-host"),
            });
            console.log(identity.banner);
            if (!identity.ok) {
                console.error(identity.error);
                process.exitCode = 1;
                return;
            }
            for (const note of identity.notes ?? []) console.log(note);
        }
        await runBackfill({ db: prisma, apply, csvPath });
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error("FAILED:", error);
        process.exitCode = 1;
    });
}
