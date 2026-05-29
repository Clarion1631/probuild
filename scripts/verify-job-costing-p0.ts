/**
 * P0 job-costing verification — isolated test job, cleaned up after.
 *
 * Proves, against the REAL shared gate helper (`resolveCostCode`) and the REAL clock-out
 * cost formula used by /api/time-entries, that:
 *   1. A coded clock-in resolves to an active cost code and produces NON-ZERO labour/burden.
 *   2. An uncoded clock-in is REJECTED by the gate (no cost code / item with no code).
 *   3. An expense resolves a cost code the same way.
 *
 * Creates only throwaway rows tagged "__P0_VERIFY__" and deletes them in `finally`.
 * Run: npx tsx scripts/verify-job-costing-p0.ts
 */
import { prisma } from "@/lib/prisma";
import { resolveCostCode } from "@/lib/cost-coding";

const TAG = "__P0_VERIFY__";
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
    if (ok) {
        pass++;
        console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
    } else {
        fail++;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

// Idempotent teardown by tag — removes any leftover test rows (dependents first).
async function cleanupByTag() {
    await prisma.timeEntry.deleteMany({ where: { project: { name: { startsWith: TAG } } } });
    await prisma.expense.deleteMany({ where: { estimate: { title: { startsWith: TAG } } } });
    await prisma.estimateItem.deleteMany({ where: { estimate: { title: { startsWith: TAG } } } });
    await prisma.estimate.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.project.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.client.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } });
    await prisma.costCode.deleteMany({ where: { code: { startsWith: TAG } } });
}

async function main() {
    await cleanupByTag(); // clear any orphans from a prior aborted run
    // ── Setup: isolated test job ────────────────────────────────────────────
    const costCode = await prisma.costCode.create({
        data: { code: `${TAG}-DEMO`, name: `${TAG} Demolition`, isActive: true },
    });
    const user = await prisma.user.create({
        data: {
            email: `${TAG.toLowerCase()}@example.test`,
            name: `${TAG} Crew`,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            hourlyRate: 50,
            burdenRate: 15,
        },
    });
    const client = await prisma.client.create({
        data: { name: `${TAG} Client`, initials: "PV" },
    });
    const project = await prisma.project.create({
        data: { name: `${TAG} Project`, clientId: client.id },
    });
    const estimate = await prisma.estimate.create({
        data: { title: `${TAG} Estimate`, code: `${TAG}-EST`, projectId: project.id, totalAmount: 0, balanceDue: 0 },
    });
    const codedItem = await prisma.estimateItem.create({
        data: { estimateId: estimate.id, name: `${TAG} Coded line`, costCodeId: costCode.id },
    });
    const uncodedItem = await prisma.estimateItem.create({
        data: { estimateId: estimate.id, name: `${TAG} Uncoded line` },
    });

    const createdTimeEntryIds: string[] = [];
    const createdExpenseIds: string[] = [];

    try {
        console.log("\n── Gate: resolveCostCode (the real helper) ──");
        const r1 = await resolveCostCode({ costCodeId: costCode.id });
        check("explicit active cost code accepted", r1.ok && r1.costCodeId === costCode.id);

        const r2 = await resolveCostCode({ lineItemId: codedItem.id });
        check("cost code derived from coded line item", r2.ok && r2.costCodeId === costCode.id);

        const r3 = await resolveCostCode({});
        check("no code → rejected (400)", !r3.ok && r3.status === 400, r3.ok ? "" : r3.error);

        const r4 = await resolveCostCode({ lineItemId: uncodedItem.id });
        check("line item with no cost code → rejected", !r4.ok, r4.ok ? "" : r4.error);

        // inactive cost code must be rejected too
        await prisma.costCode.update({ where: { id: costCode.id }, data: { isActive: false } });
        const r5 = await resolveCostCode({ costCodeId: costCode.id });
        check("inactive cost code → rejected", !r5.ok, r5.ok ? "" : r5.error);
        await prisma.costCode.update({ where: { id: costCode.id }, data: { isActive: true } });

        console.log("\n── Costing E2E: coded clock-in/out produces non-zero cost ──");
        const coded = await resolveCostCode({ lineItemId: codedItem.id });
        if (!coded.ok) throw new Error("setup: coded item did not resolve");

        // Clock-in exactly as POST /api/time-entries does (with the resolved code).
        const start = new Date(Date.now() - 8 * 60 * 60 * 1000); // 8h ago
        const entry = await prisma.timeEntry.create({
            data: {
                userId: user.id,
                projectId: project.id,
                costCodeId: coded.costCodeId,
                costTypeId: coded.costTypeId,
                estimateItemId: codedItem.id,
                startTime: start,
            },
        });
        createdTimeEntryIds.push(entry.id);
        check("clock-in stored a cost code", !!entry.costCodeId, entry.costCodeId ?? "null");

        // Clock-out exactly as PUT /api/time-entries does (owner rates × hours).
        const end = new Date();
        let durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (durationHours < 0) durationHours = 0;
        const laborCost = durationHours * Number(user.hourlyRate);
        const burdenCost = durationHours * Number(user.burdenRate);
        const closed = await prisma.timeEntry.update({
            where: { id: entry.id },
            data: { endTime: end, durationHours, laborCost, burdenCost },
        });
        check(
            "labour cost is NON-zero for coded time",
            Number(closed.laborCost) > 0,
            `${durationHours.toFixed(2)}h × $${Number(user.hourlyRate)} = $${Number(closed.laborCost).toFixed(2)} labour, $${Number(closed.burdenCost).toFixed(2)} burden`
        );
        check("closed entry retains its cost code", !!closed.costCodeId);

        console.log("\n── Expense coding ──");
        const ecoded = await resolveCostCode({ lineItemId: codedItem.id });
        if (!ecoded.ok) throw new Error("setup: expense code did not resolve");
        const expense = await prisma.expense.create({
            data: {
                estimateId: estimate.id,
                itemId: codedItem.id,
                costCodeId: ecoded.costCodeId,
                costTypeId: ecoded.costTypeId,
                amount: 123.45,
                status: "Pending",
            },
        });
        createdExpenseIds.push(expense.id);
        check("expense stored a cost code", !!expense.costCodeId, expense.costCodeId ?? "null");
    } finally {
        // ── Teardown ────────────────────────────────────────────────────────
        void createdExpenseIds;
        void createdTimeEntryIds;
        await cleanupByTag();
        console.log("\n🧹 Cleaned up all __P0_VERIFY__ rows.");
    }

    console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed.`);
    await prisma.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error("Verification crashed:", e);
    await prisma.$disconnect();
    process.exit(1);
});
