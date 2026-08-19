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
 * USAGE
 *   node scripts/suggest-expense-cost-codes.mjs              # dry run + report
 *   node scripts/suggest-expense-cost-codes.mjs --apply      # write matches
 *   node scripts/suggest-expense-cost-codes.mjs --csv out.csv
 */
import { PrismaClient } from "@prisma/client";
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

/**
 * Specialty vendors that do exactly one trade. A match here is strong evidence
 * on its own — unlike a general retailer, these firms don't sell anything else.
 */
const VENDOR_RULES = [
    // Specialty trade firms and suppliers. Each does ONE thing, so the vendor
    // name alone is sufficient evidence. Kept narrow on purpose — a bare
    // /cabinet/ or /plumbing/ would also match a general retailer that merely
    // has the word in a line item.
    { re: /summit plumbing|\bplumbing\b(?!.*supply)/i, code: "03-PLUMB" },
    { re: /redpoint electric|red ?point electric|newman electric/i, code: "04-ELEC" },
    { re: /k ?& ?s countertops/i, code: "12-COUNTER" },
    { re: /rta.?store/i, code: "11-CABINET" },
    { re: /builders ?first ?source|shur-?way|parr lumber/i, code: "02-FRAME" },
    { re: /columbia resource|\bcrc\b/i, code: "20-CLEAN" },
    { re: /ferguson/i, code: "03-PLUMB" },
];

/**
 * Material keywords read out of the itemised receipt text the pipeline's Gemini
 * step extracts into `description` ("... | Lines: ..."). Ordered: the first hit
 * wins, so put the least ambiguous first.
 */
const LINE_RULES = [
    { re: /circuit brea|breaker|romex|wire nut|receptacle|gfci|electrical panel/i, code: "04-ELEC" },
    { re: /douglas fir|hem ?fir|treated #2|stud\b|joist|lvl\b|osb|sheathing|framing/i, code: "02-FRAME" },
    { re: /drywall|sheetrock|joint compound|mud\b|drywall screw/i, code: "07-DRYWALL" },
    { re: /\bpaint\b|primer|caulk|sherwin|behr/i, code: "08-PAINT" },
    { re: /\btile\b|thinset|grout|backer ?board/i, code: "10-TILE" },
    { re: /toilet|vanity|faucet|shower valve|p-?trap|pex|abs pipe/i, code: "03-PLUMB" },
    { re: /cabinet|catalina toffee/i, code: "11-CABINET" },
    { re: /countertop|quartz|granite slab/i, code: "12-COUNTER" },
    { re: /siding|hardie|hz10|trim board/i, code: "16-SIDING" },
    { re: /window|patio door/i, code: "14-DOOR" },
    { re: /insulation|batt\b|r-?13|r-?21/i, code: "06-INSUL" },
    // Cleanup/disposal is about HAULING WASTE AWAY — dump fees, debris runs.
    // Deliberately NOT "excavator": a mini-excavator rental is sitework/
    // excavation, not cleanup. Matching it to 20-CLEAN mis-booked a $3,317.78
    // Mesplay equipment rental in the first dry run.
    { re: /dump fee|debris|disposal|haul away|junk removal|msw\b/i, code: "20-CLEAN" },
    { re: /excavator|skid ?steer|trencher|bobcat|equipment rental/i, code: "23-SITEWORK" },
    { re: /concrete|rebar|quikrete/i, code: "17-CONCRETE" },
    { re: /roof|shingle|underlayment/i, code: "15-ROOF" },
    { re: /flooring|lvp|laminate|carpet/i, code: "09-FLOOR" },
];

/**
 * Decide a phase for one expense. Returns {code, why} or null when the evidence
 * is not strong enough — null is a legitimate, deliberate answer here.
 */
export function suggestCode(expense) {
    const vendor = expense.vendor || "";
    const desc = expense.description || "";

    for (const r of VENDOR_RULES) {
        if (r.re.test(vendor)) return { code: r.code, why: `vendor ~ ${r.re.source.slice(0, 28)}` };
    }
    // Only read the itemised portion; the prefix is boilerplate.
    const lines = desc.includes("Lines:") ? desc.slice(desc.indexOf("Lines:")) : desc;
    for (const r of LINE_RULES) {
        if (r.re.test(lines)) return { code: r.code, why: `lines ~ ${r.re.source.slice(0, 28)}` };
    }
    return null;
}

async function main() {
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
        await prisma.expense.update({ where: { id: m.id }, data: { costCodeId: codeId.get(m.code) } });
        n++;
    }
    console.log(`\napplied ${n} cost code(s). ${unmatched.length} rows left NULL for human review.`);
}

main()
    .catch((e) => { console.error("FAILED:", e); process.exit(1); })
    .finally(() => prisma.$disconnect());
