// Verifies get_estimate (read) against a real estimate.
import { estimateToPhases } from "../src/lib/gpt-estimate";

async function main() {
    const checks: [string, boolean][] = [];

    // Commercial Siding EST-00145: 4 sections, 6 line items (incl. East/Rear wall).
    const read = await estimateToPhases("EST-00145");
    if (!read.ok) throw new Error(read.error);
    const lineCount = read.phases.reduce((s, p) => s + p.items.length, 0);
    checks.push(["reads by code", read.code === "EST-00145"]);
    checks.push(["4 phases / 6 items", read.phases.length === 4 && lineCount === 6]);
    checks.push(["items carry unit costs", read.phases.every(p => p.items.every(i => typeof i.unitCost === "number"))]);
    checks.push(["case-insensitive", (await estimateToPhases("est-00145")).ok]);
    checks.push(["reads by id", (await estimateToPhases(read.estimateId)).ok]);
    checks.push(["unknown code errors", !(await estimateToPhases("EST-99999")).ok]);

    let failed = 0;
    for (const [label, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
    console.log(`\nEST-00145: ${read.phases.length} phases, ${lineCount} items`);
    for (const p of read.phases) console.log(`  ${p.phaseName}${p.phaseCode ? ` [${p.phaseCode}]` : ""}: ${p.items.map(i => i.name).join(", ")}`);
    if (failed) throw new Error(`${failed} checks failed`);
    console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
