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
 *   node --import=tsx scripts/suggest-expense-cost-codes.ts              # dry run + report
 *   node --import=tsx scripts/suggest-expense-cost-codes.ts --apply      # write matches
 *   node --import=tsx scripts/suggest-expense-cost-codes.ts --csv out.csv
 */
import { PrismaClient } from "@prisma/client";
import { suggestCode } from "../src/lib/expense-cost-suggest";
import { notHumanCodedExpenseWhere } from "../src/lib/expense-attribution";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const APPLY = process.argv.includes("--apply");
const csvIdx = process.argv.indexOf("--csv");
const CSV = csvIdx > -1 ? process.argv[csvIdx + 1] : null;

/** Company overhead bucket — never gets a job phase. */
const OVERHEAD_PROJECTS = ["Shop"];

const num = (v) => (v == null ? 0 : Number(v));
const money = (v) => `$${num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const HELP = `Suggest cost codes for uncoded expenses (rule-based, not a model).

  node --import=tsx scripts/suggest-expense-cost-codes.ts              # dry run + report
  node --import=tsx scripts/suggest-expense-cost-codes.ts --apply      # write matches
  node --import=tsx scripts/suggest-expense-cost-codes.ts --csv out.csv

The --import=tsx loader is required: this script imports TypeScript from src/.`;

async function main() {
    // Works with no database and no env — and doubles as the CI check that this
    // file still LOADS under the documented runtime.
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(HELP);
        return;
    }

    const codes = await prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true } });
    const codeId = new Map(codes.map((c) => [c.code, c.id]));

    const rows = await prisma.expense.findMany({
        where: {
            costCodeId: null,
            estimate: { project: { status: "In Progress", name: { notIn: OVERHEAD_PROJECTS } } },
        },
        select: {
            id: true, amount: true, vendor: true, description: true,
            estimate: { select: { project: { select: { name: true } } } },
        },
        orderBy: { amount: "desc" },
    });

    const matched = [];
    const unmatched = [];
    for (const r of rows) {
        const s = suggestCode(r);
        if (s && codeId.has(s.code)) matched.push({ ...r, ...s });
        else unmatched.push(r);
    }

    const sum = (a) => a.reduce((t, r) => t + num(r.amount), 0);
    console.log(`scope: active customer jobs (overhead bucket "${OVERHEAD_PROJECTS.join(", ")}" excluded)`);
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
        const esc = (s) => `"${String(s ?? "").replace(/"/g, '""').replace(/\s+/g, " ").slice(0, 160)}"`;
        const out = [["expense_id", "project", "amount", "vendor", "suggested_code", "why", "description"].join(",")];
        for (const m of matched) {
            out.push([m.id, esc(m.estimate?.project?.name), num(m.amount), esc(m.vendor), m.code, esc(m.why), esc(m.description)].join(","));
        }
        for (const u of unmatched) {
            out.push([u.id, esc(u.estimate?.project?.name), num(u.amount), esc(u.vendor), "", "NEEDS_HUMAN", esc(u.description)].join(","));
        }
        writeFileSync(CSV, out.join("\n"));
        console.log(`\nwrote ${CSV} (${out.length - 1} rows)`);
    }

    if (!APPLY) {
        console.log("\nDRY RUN — nothing written. Re-run with --apply to save the confident matches.");
        return;
    }

    let n = 0;
    for (const m of matched) {
        // Phase 3: stamp provenance alongside the code. A row with a code and
        // no source would be indistinguishable from a human's choice, and the
        // capture/manual guard everywhere else keys on exactly that.
        const written = await prisma.expense.updateMany({
            where: { id: m.id, costCodeId: null, ...notHumanCodedExpenseWhere() },
            data: { costCodeId: codeId.get(m.code), costCodeSource: "ai", costCodeConfidence: m.confidence },
        });
        n += written.count;
    }
    console.log(`\napplied ${n} cost code(s). ${unmatched.length} rows left NULL for human review.`);
}

main()
    .catch((e) => { console.error("FAILED:", e); process.exit(1); })
    .finally(() => prisma.$disconnect());
