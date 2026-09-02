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
 * USAGE
 *   node scripts/backfill-expense-attribution.mjs                    # dry run
 *   node scripts/backfill-expense-attribution.mjs --csv out.csv      # + remainder CSV
 *   node scripts/backfill-expense-attribution.mjs --apply            # write
 *
 * A re-run after --apply must report 0 planned changes. That is the proof, and
 * it is the same rule scripts/backfill-estimate-item-cost-codes.mjs follows.
 */
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { suggestCode } from "../src/lib/expense-cost-suggest.ts";
import {
    notHumanCodedExpenseWhere,
    resolveExpenseCostCodeId,
    resolveExpenseProjectId,
} from "../src/lib/expense-attribution.ts";
import { OVERHEAD_PROJECT_ID } from "../src/lib/overhead-project.ts";

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
export function measureCoverage(rows) {
    let attributed = 0;
    let unattributed = 0;
    let codedCount = 0;
    for (const row of rows) {
        const amount = Math.abs(num(row.amount));
        if (row.costCodeId) {
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
 */
export function planBackfill({ expenses, items, costCodeIdByCode, scopedProjectIds }) {
    const inScope = new Set(scopedProjectIds);
    const projectFills = [];
    const codeFills = [];
    const remainder = [];
    const add = (expense, reason) => remainder.push({ ...expense, reason });

    for (const expense of expenses) {
        const resolvedProjectId = resolveExpenseProjectId(expense);
        if (expense.projectId === null && resolvedProjectId) {
            projectFills.push({ id: expense.id, projectId: resolvedProjectId });
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
            codeFills.push({
                id: expense.id,
                costCodeId: item.costCodeId,
                costCodeSource: "backfill",
                costCodeConfidence: null,
                why: "item cost code (same project)",
                expectedProjectId: expense.projectId ?? null,
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
        if (suggestion && costCodeId && suggestion.confidence >= MIN_CONFIDENCE) {
            codeFills.push({
                id: expense.id,
                costCodeId,
                costCodeSource: "ai",
                costCodeConfidence: suggestion.confidence,
                why: suggestion.why,
                // The attribution the decision was scoped BY, so the write can
                // require it is unchanged. `null` is a real expectation: it
                // means the row was still unattributed when the plan was made.
                expectedProjectId: expense.projectId ?? null,
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

function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""').replace(/\s+/g, " ").slice(0, 160)}"`;
}

export function remainderCsv(remainder, projectNameById) {
    const lines = [["expense_id", "project", "date", "vendor", "amount", "reason", "description"].join(",")];
    for (const expense of remainder) {
        lines.push([
            expense.id,
            csvEscape(projectNameById.get(resolveExpenseProjectId(expense)) ?? ""),
            expense.date ? new Date(expense.date).toISOString().slice(0, 10) : "",
            csvEscape(expense.vendor),
            num(expense.amount).toFixed(2),
            // WHY it is here. "item-outside-estimate" in particular is not
            // "we could not guess" — it is "this row claims a line item on
            // another job", which is a data problem a human should look at.
            csvEscape(expense.reason),
            csvEscape(expense.description),
        ].join(","));
    }
    return lines.join("\n");
}

/**
 * The whole run, with every external effect injected so
 * tests/backfill-expense-attribution.test.ts can drive it with a prisma-shaped
 * stub and assert that a dry run makes ZERO write calls.
 */
export async function runBackfill({
    db,
    apply = false,
    // Annotated rather than left to inference: a bare `null` default infers the
    // parameter as `null`, and every caller that passes a real path (including
    // the test) then fails to typecheck.
    csvPath = /** @type {string | null} */ (null),
    writeFile = /** @type {(path: string, body: string) => void} */ (writeFileSync),
    log = /** @type {(message: string) => void} */ (console.log),
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
            estimate: { select: { projectId: true } },
        },
    });

    // The item's OWN estimate and project come back with it: the fallback has
    // to prove the link does not cross jobs before it copies a code.
    const itemRows = await db.estimateItem.findMany({
        where: { costCodeId: { not: null } },
        select: {
            id: true, costCodeId: true, estimateId: true,
            estimate: { select: { projectId: true } },
        },
    });
    const items = new Map(itemRows.map(row => [row.id, {
        costCodeId: row.costCodeId,
        estimateId: row.estimateId,
        projectId: row.estimate?.projectId ?? null,
    }]));
    const itemCostCodeById = new Map(itemRows.map(row => [row.id, row.costCodeId]));

    const plan = planBackfill({ expenses, items, costCodeIdByCode, scopedProjectIds });

    // ── the table ───────────────────────────────────────────────────────────
    const scoped = new Set(scopedProjectIds);
    const inScopeExpenses = expenses.filter(e => scoped.has(resolveExpenseProjectId(e) ?? ""));
    const before = measureCoverage(inScopeExpenses);
    const after = measureCoverage(projectedRows(inScopeExpenses, plan.codeFills));

    log(`scope: ${scopedProjectIds.length} In Progress customer job(s); overhead project ${overheadProjectId} excluded`);
    log("");
    log("per job (expense dollars with a resolvable cost code):");
    log(`  ${"job".padEnd(34)} ${"coded".padStart(11)} ${"total".padStart(13)}  before -> after`);
    for (const projectId of scopedProjectIds) {
        const rows = inScopeExpenses.filter(e => resolveExpenseProjectId(e) === projectId);
        if (rows.length === 0) continue;
        const b = measureCoverage(rows);
        const a = measureCoverage(projectedRows(rows, plan.codeFills));
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
        select: { costCodeId: true, estimateItemId: true, laborCost: true, burdenCost: true },
    });
    const laborRows = timeEntries.map(t => ({
        costCodeId: resolveExpenseCostCodeId(
            { costCodeId: t.costCodeId, itemId: t.estimateItemId },
            itemCostCodeById,
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
    const byProject = new Map();
    for (const fill of plan.projectFills) {
        if (!byProject.has(fill.projectId)) byProject.set(fill.projectId, []);
        byProject.get(fill.projectId).push(fill.id);
    }
    for (const [projectId, ids] of byProject) {
        // `projectId: null` in the predicate, not just in the plan: between the
        // read above and this write, a re-sync or a bookkeeper may have set it.
        const result = await db.expense.updateMany({
            where: { id: { in: ids }, projectId: null },
            data: { projectId },
        });
        projectIdsWritten += result.count;
    }

    let costCodesWritten = 0;
    let costCodesSkipped = 0;
    for (const fill of plan.codeFills) {
        const result = await db.expense.updateMany({
            where: {
                id: fill.id,
                // Everything the plan depended on, re-asserted at write time.
                // The plan is a snapshot taken before pass (a) ran and before
                // any concurrent sync or bookkeeper edit; the predicate is what
                // makes it safe to act on. A row that moved is skipped, not
                // coded on stale reasoning.
                projectId: fill.expectedProjectId,
                costCodeId: null,
                ...notHumanCodedExpenseWhere(),
            },
            data: {
                costCodeId: fill.costCodeId,
                costCodeSource: fill.costCodeSource,
                costCodeConfidence: fill.costCodeConfidence,
            },
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

async function main() {
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
