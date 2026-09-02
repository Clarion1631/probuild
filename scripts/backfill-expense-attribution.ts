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
 * (costCodeSource "capture" or "manual").
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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { suggestCode } from "../src/lib/expense-cost-suggest";
import {
    notHumanCodedExpenseWhere,
    resolveExpenseCostCodeId,
    resolveExpenseProjectId,
} from "../src/lib/expense-attribution";
import { OVERHEAD_PROJECT_ID } from "../src/lib/overhead-project";
import { lockExpense } from "../src/lib/expense-lock";
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
 * The returned map is keyed by item id but populated ONLY with items whose
 * project matches the expense set being measured.
 */
export function scopedItemCostCodes(rows, items, allowedCodesByProject) {
    const scoped = new Map();
    for (const row of rows) {
        if (!row.itemId) continue;
        const item = items.get(row.itemId);
        if (!item || !item.costCodeId) continue;
        const projectId = resolveExpenseProjectId(row);
        // Same two gates the writer applies: the link must not cross jobs, and
        // the code must be a live phase of that job.
        if (!projectId || item.projectId !== projectId) continue;
        const allowed = allowedCodesByProject.get(projectId);
        if (!allowed || !allowed.has(item.costCodeId)) continue;
        scoped.set(row.itemId, item.costCodeId);
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
        const resolved = resolveExpenseCostCodeId(
            { costCodeId: row.costCodeId ?? null, itemId: row.itemId ?? null },
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
        if (expense.costCodeSource === "capture" || expense.costCodeSource === "manual") continue;

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
        if (expense.itemId && !item) {
            // A link to an item that is gone, or to an item with no cost code:
            // no answer either way, so fall through to the rules below.
        } else if (item && item.costCodeId) {
            const sameProject =
                resolvedProjectId !== null &&
                item.projectId !== null &&
                item.projectId === resolvedProjectId;
            if (!sameProject) {
                add(expense, "item-outside-estimate");
                continue;
            }
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
    if (typeof db.$transaction !== "function") return run(db);
    return db.$transaction(async tx => {
        await lockExpense(tx, expenseId);
        return run(tx);
    });
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

    // The item's OWN estimate and project come back with it: the fallback has
    // to prove the link does not cross jobs before it copies a code.
    const itemRowsRaw = await db.estimateItem.findMany({
        where: { costCodeId: { not: null }, costCode: { isActive: true } },
        select: {
            id: true, costCodeId: true, estimateId: true,
            estimate: { select: { projectId: true } },
        },
    });
    const itemRows = itemRowsRaw.map(row => ({
        id: row.id,
        costCodeId: row.costCodeId,
        estimateId: row.estimateId,
        projectId: row.estimate?.projectId ?? null,
    }));
    const items = new Map(itemRows.map(row => [row.id, {
        costCodeId: row.costCodeId,
        estimateId: row.estimateId,
        projectId: row.projectId,
    }]));
    const itemCostCodeById = new Map(itemRows.map(row => [row.id, row.costCodeId]));

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

    const plan = planBackfill({
        expenses, items, costCodeIdByCode, scopedProjectIds, allowedCodesByProject,
    });

    // ── the table ───────────────────────────────────────────────────────────
    const scoped = new Set(scopedProjectIds);
    const inScopeExpenses = expenses.filter(e => scoped.has(resolveExpenseProjectId(e) ?? ""));
    // Project-scoped and phase-validated, so a cross-job item link stays
    // unattributed in the metric exactly as it does on the variance page.
    const coverageItems = scopedItemCostCodes(inScopeExpenses, items, allowedCodesByProject);
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
    const timeEntries = await db.timeEntry.findMany({
        where: { projectId: { in: scopedProjectIds } },
        select: {
            costCodeId: true, estimateItemId: true, laborCost: true, burdenCost: true,
            // Needed to scope the item fallback to the entry's OWN job.
            projectId: true,
        },
    });
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
        items,
        allowedCodesByProject,
    );
    const laborRows = timeEntries.map(t => ({
        costCodeId: resolveExpenseCostCodeId(
            { costCodeId: t.costCodeId, itemId: t.estimateItemId },
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

    if (!apply) {
        log("");
        log("DRY RUN — nothing written. Re-run with --apply once the table above is reviewed.");
        return { plan, before, after, written: { projectIds: 0, costCodes: 0 } };
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
        // BOTH halves of the derivation, re-asserted at write time.
        //
        // `projectId: null` says nobody has attributed the row yet;
        // `estimateId` says it is still hanging off the estimate this project
        // was READ from. Without the second one, an expense re-pointed at a
        // different estimate between the plan and the write would be stamped
        // with the old estimate's project — a silent cross-job attribution
        // performed by the very pass that exists to get attribution right.
        const result = await db.expense.updateMany({
            where: { id: { in: ids }, projectId: null, estimateId },
            data: { projectId },
        });
        projectIdsWritten += result.count;
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
        const result = await writeUnderExpenseLock(db, fill.id, async tx => {
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
            const replanned = planBackfill({
                expenses: [current],
                items,
                costCodeIdByCode,
                scopedProjectIds,
                allowedCodesByProject,
            });
            const fresh = replanned.codeFills[0];
            // No longer codeable at all, or codeable as something else — either
            // way the planned write is void. A re-run will plan it properly.
            if (!fresh || fresh.costCodeId !== fill.costCodeId) return { count: 0 };

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
        written: { projectIds: projectIdsWritten, costCodes: costCodesWritten },
    };
}

const HELP = `Backfill Expense attribution (Receipt Pipeline v2, Phase 3).

  node --import=tsx scripts/backfill-expense-attribution.ts                # dry run
  node --import=tsx scripts/backfill-expense-attribution.ts --csv out.csv  # + remainder CSV
  node --import=tsx scripts/backfill-expense-attribution.ts --apply        # write

Dry run is the DEFAULT. --apply writes; re-run dry afterwards and it must
report zero planned changes.

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

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
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
