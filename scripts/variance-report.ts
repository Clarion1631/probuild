// READ-ONLY. Prints the variance report to the console using the SAME loader
// the /manager/variance page uses (src/lib/job-variance-db.ts), so this script
// can never drift from what the app actually shows. An earlier version
// duplicated the queries and silently missed the approved-change-order budget
// after that was fixed in the loader — hence this rewrite.
//
// Run: npx tsx scripts/variance-report.ts
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const money = (n: number) =>
    (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

async function main() {
    // Imported AFTER dotenv runs — the Prisma client reads DATABASE_URL at construction.
    const { loadProjectVariance } = await import("../src/lib/job-variance-db.js");
    const reports = await loadProjectVariance();

    for (const report of reports) {
        const v = report.variance;
        console.log("\n" + "=".repeat(78));
        console.log(report.projectName.toUpperCase());
        console.log("=".repeat(78));
        console.log(
            `  budget ${money(v.totalBudget)}   actual ${money(v.totalActual)}   variance ${money(v.variance)}` +
            `${v.percentUsed !== null ? `   (${(v.percentUsed * 100).toFixed(1)}% used)` : ""}`
        );
        console.log(
            `  labor: budget ${money(v.laborBudget)} / actual ${money(v.actualLabor)}` +
            `   materials: budget ${money(v.materialBudget)} / actual ${money(v.actualMaterial)}`
        );
        console.log(
            `  TRUST: ${Math.floor(v.coverage.attributedShare * 100)}% of dollars attributed` +
            ` | unplaced ${money(v.coverage.unattributedTotal)}` +
            ` | phase-only ${money(v.coverage.phaseOnlyActuals)}` +
            (v.coverage.malformedRows > 0 ? ` | ⚠ ${v.coverage.malformedRows} MALFORMED ROWS` : "")
        );
        if (v.uncodedBudget > 0) {
            console.log(`  estimate cleanup: ${money(v.uncodedBudget)} of budget sits on uncoded items`);
        }

        const interesting = v.phases.filter((p) => p.totalActual > 0 || p.variance < 0).slice(0, 8);
        if (interesting.length === 0) {
            console.log("  (no actuals recorded against any phase yet)");
            continue;
        }
        console.log("\n  worst phases:");
        for (const p of interesting) {
            const flags =
                (p.totalBudget === 0 && p.totalActual > 0 ? "  [NOT IN THE ESTIMATE]" : "") +
                (p.hasNegativeBudget ? "  [NEGATIVE BUDGET]" : "");
            console.log(
                `    ${p.code.padEnd(16)} budget ${money(p.totalBudget).padStart(10)}` +
                `  actual ${money(p.totalActual).padStart(10)}  var ${money(p.variance).padStart(10)}${flags}`
            );
            for (const it of p.items.filter((i) => i.actual > 0 || i.variance < 0).slice(0, 3)) {
                const floor = it.phaseHasUnassignedActuals ? "  [floor: phase has unassigned actuals]" : "";
                console.log(
                    `        · ${String(it.name).slice(0, 46).padEnd(46)}` +
                    ` budget ${money(it.budget).padStart(9)} actual ${money(it.actual).padStart(9)}${floor}`
                );
            }
        }
    }
}

main().catch((e) => {
    console.error("FAILED — treat ALL output above as void:", e);
    process.exit(1);
});
