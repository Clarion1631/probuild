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
 * Suggest ProBuild cost codes (phases) for expenses that have none.
 *
 * WHY THIS EXISTS
 *   555 of 562 expenses carry no costCodeId, so ProBuild's phase-level job
 *   costing is blind. ProBuild — not QuickBooks — owns job costing and
 *   receipts (QBO keeps the books: COGS vs overhead is classified there), so
 *   the fix belongs here.
 *
 * SCOPE (Justin's call)
 *   Active customer jobs ONLY. "Shop" is the company overhead bucket by
 *   design (gtr-money-map: no-customer purchases land there as [Overhead]) and
 *   is excluded, as are closed jobs. Overhead does not get a job phase.
 *
 * PHILOSOPHY — why rules and not "best guess for every row"
 *   A wrong cost code is worse than an absent one: it silently corrupts job
 *   costing, and TRUST is one of the four product rules. So this only assigns
 *   a code when the evidence is unambiguous (a specialty vendor, or explicit
 *   material keywords in the itemised receipt lines). Everything else is
 *   deliberately left NULL and reported for a human. Vendor alone is never
 *   enough for a general retailer: 134 rows are Lowe's, which sells framing
 *   lumber, drywall, paint and toilets alike.
 *
 * The rules themselves moved to src/lib/expense-cost-suggest.ts (Phase 3) so
 * the QBO sync and scripts/backfill-expense-attribution.ts run the SAME ones.
 * This script keeps its own scope and reporting; it no longer owns the regexes.
 *
 * RUNTIME: this file imports TypeScript from src/, so it needs a TS loader.
 *   node --import=tsx scripts/...
 * Plain `node` works on this machine (Node 24 strips types) and FAILS on CI's
 * Node 20 and on anything older — which is exactly where a one-shot data script
 * gets run in a hurry. `--import=tsx` is the same loader the test suite uses,
 * so there is one answer rather than a version-dependent one.
 *
 * USAGE
 *   node --import=tsx scripts/suggest-expense-cost-codes.ts               # report
 *   node --import=tsx scripts/suggest-expense-cost-codes.ts --csv out.csv
 *
 * READ-ONLY. There is no --apply and there must not be one: writing cost codes
 * belongs to scripts/backfill-expense-attribution.ts, which is the only path
 * with the per-expense lock, the compare-and-set on the row version, the
 * re-plan under that lock, and the project-scoped phase check. This script
 * kept a second, weaker writer alive for the same columns — two ways to code an
 * expense, one of them unaware of every guarantee the other was given.
 */
import { PrismaClient } from "@prisma/client";
import { suggestCode } from "../src/lib/expense-cost-suggest";
import { expenseNotOnProjectWhere, resolveExpenseProjectId } from "../src/lib/expense-attribution";
import { OVERHEAD_PROJECT_ID } from "../src/lib/overhead-project";
import { PHASE_ELIGIBLE_ESTIMATE_WHERE } from "../src/lib/project-phases";
import { csvCell, csvNumber } from "../src/lib/csv-safe";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

// CONSTRUCTED LAZILY, inside main and after the --help branch. Building it at
// module scope threw on any machine without DATABASE_URL — including CI, where
// --help is the smoke test that this file still loads at all.
let prisma: PrismaClient | null = null;

const csvIdx = process.argv.indexOf("--csv");
const CSV = csvIdx > -1 ? process.argv[csvIdx + 1] : null;

// The overhead bucket is excluded BY ID via the canonical constant. Matching
// on the name "Shop" stopped being true the day the project could be renamed,
// and this report is read as evidence.

const num = (v) => (v == null ? 0 : Number(v));
const money = (v) => `$${num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const HELP = `Report cost-code suggestions for uncoded expenses (rule-based, not a model).

  node --import=tsx scripts/suggest-expense-cost-codes.ts               # report
  node --import=tsx scripts/suggest-expense-cost-codes.ts --csv out.csv

READ-ONLY: this script never writes. Use
scripts/backfill-expense-attribution.ts --apply to actually code expenses — it
is the only writer with the per-expense lock, the row-version CAS and the
project-scoped phase check.

The --import=tsx loader is required: this script imports TypeScript from src/.`;

async function main() {
    // Works with no database and no env — and doubles as the CI check that this
    // file still LOADS under the documented runtime.
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(HELP);
        return;
    }

    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const codes = await prisma!.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true } });
    const codeId = new Map(codes.map((c) => [c.code, c.id]));

    // Attribution resolved the ONE way, and the overhead bucket excluded by id.
    // A row re-attributed to a live job used to be invisible here (its estimate
    // still named the old one), so the report understated the work to be done.
    const rows = await prisma!.expense.findMany({
        where: {
            costCodeId: null,
            ...expenseNotOnProjectWhere(OVERHEAD_PROJECT_ID),
        },
        select: {
            id: true, amount: true, vendor: true, description: true, projectId: true,
            project: { select: { id: true, name: true, status: true } },
            estimate: { select: { projectId: true, project: { select: { id: true, name: true, status: true } } } },
        },
        orderBy: { amount: "desc" },
    });

    // The PROJECT'S OWN PHASES, same rule the writer applies. A suggestion the
    // job could never accept is not a suggestion, and listing it as one sends a
    // bookkeeper to check something that was never on the table.
    const phaseRows = await prisma!.estimateItem.findMany({
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

    const inProgress = (row) =>
        (row.projectId ? row.project?.status : row.estimate?.project?.status) === "In Progress";

    const matched = [];
    const unmatched = [];
    for (const r of rows) {
        if (!inProgress(r)) continue;
        const projectId = resolveExpenseProjectId(r);
        const s = suggestCode(r);
        const suggestedId = s ? codeId.get(s.code) : undefined;
        const allowed = projectId ? allowedCodesByProject.get(projectId) : undefined;
        // Reported as a match only if the WRITER would accept it.
        if (s && suggestedId && allowed && allowed.has(suggestedId)) matched.push({ ...r, ...s });
        else unmatched.push(r);
    }

    const projectName = (row) =>
        (row.projectId ? row.project?.name : row.estimate?.project?.name) ?? "";

    const sum = (a) => a.reduce((t, r) => t + num(r.amount), 0);
    console.log(`scope: In Progress customer jobs (overhead project ${OVERHEAD_PROJECT_ID} excluded)`);
    console.log("READ-ONLY report. Use backfill-expense-attribution.ts --apply to write.");
    console.log(`uncoded rows: ${rows.length}  ${money(sum(rows))}`);
    console.log(`  confident match: ${matched.length}  ${money(sum(matched))}`);
    console.log(`  NEEDS HUMAN:     ${unmatched.length}  ${money(sum(unmatched))}\n`);

    const byCode = new Map();
    for (const m of matched) {
        const c = byCode.get(m.code) || { n: 0, sum: 0 };
        c.n++; c.sum += num(m.amount);
        byCode.set(m.code, c);
    }
    console.log("suggested phases:");
    for (const [c, v] of [...byCode.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
        console.log(`  ${c.padEnd(14)} ${String(v.n).padStart(4)} rows  ${money(v.sum).padStart(13)}`);
    }

    if (CSV) {
        // csv-safe: vendor and description are OCR output, so a leading `=`
        // reaches the reader's spreadsheet as a formula.
        const cell = (v) => csvCell(String(v ?? "").replace(/\s+/g, " ").slice(0, 160));
        const out = [["expense_id", "project", "amount", "vendor", "suggested_code", "why", "description"].join(",")];
        for (const m of matched) {
            out.push([cell(m.id), cell(projectName(m)), csvNumber(num(m.amount)), cell(m.vendor), cell(m.code), cell(m.why), cell(m.description)].join(","));
        }
        for (const u of unmatched) {
            out.push([cell(u.id), cell(projectName(u)), csvNumber(num(u.amount)), cell(u.vendor), cell(""), cell("NEEDS_HUMAN"), cell(u.description)].join(","));
        }
        writeFileSync(CSV, out.join("\n"));
        console.log(`\nwrote ${CSV} (${out.length - 1} rows)`);
    }

    console.log("\nREPORT ONLY — nothing was written. To apply:");
    console.log("  node --import=tsx scripts/backfill-expense-attribution.ts          # dry run");
    console.log("  node --import=tsx scripts/backfill-expense-attribution.ts --apply  # write");
}

main()
    .catch((e) => { console.error("FAILED:", e); process.exit(1); })
    // Nothing to disconnect when --help returned before the client was built.
    .finally(() => prisma?.$disconnect());
