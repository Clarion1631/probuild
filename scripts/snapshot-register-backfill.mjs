// READ-ONLY snapshot of everything today's register backfills touched.
// Writes JSON to the path given as argv[2]. Makes no writes of any kind.
import { PrismaClient } from "@prisma/client";
import { writeFileSync, existsSync, readFileSync } from "node:fs";

// Same env resolution as scripts/backfill-review-evidence.mjs:37-43
if (!process.env.DATABASE_URL) {
    for (const file of [".env", ".env.local"]) {
        if (!existsSync(file)) continue;
        const m = readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (m) { process.env.DATABASE_URL = m[1]; break; }
    }
}

const out = process.argv[2];
if (!out) {
    console.error("usage: node scripts/snapshot-register-backfill.mjs <output.json>");
    process.exit(1);
}

const prisma = new PrismaClient();

try {
    // Expenses created by today's classification backfill run.
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const recentExpenses = await prisma.expense.findMany({
        where: { createdAt: { gte: since }, qbPurchaseId: { not: null } },
        select: {
            id: true, qbPurchaseId: true, qbSyncToken: true, qbSyncedAt: true,
            estimateId: true, amount: true, vendor: true, date: true,
            description: true, receiptUrl: true, status: true, createdAt: true,
        },
        orderBy: { createdAt: "asc" },
    });

    const classifications = await prisma.qboPurchaseClassification.findMany({
        select: {
            qbPurchaseId: true, classification: true, reason: true,
            qbSyncToken: true, classifiedAt: true, updatedAt: true,
        },
    });

    const byClassification = classifications.reduce((acc, c) => {
        acc[c.classification] = (acc[c.classification] || 0) + 1;
        return acc;
    }, {});

    // AutomationEvent rows whose typed evidence columns the evidence backfill populated.
    const promotedEvents = await prisma.automationEvent.findMany({
        where: { OR: [{ qbPurchaseId: { not: null } }, { driveFileId: { not: null } }] },
        select: {
            id: true, kind: true, stage: true, status: true, docNumber: true,
            qbPurchaseId: true, driveFileId: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
    });

    const snapshot = {
        takenAt: new Date().toISOString(),
        note: "Read-only snapshot after the 2026-08-03 unified-register backfills. "
            + "recentExpenses = candidates created by the classification backfill "
            + "(imported 27 / updated 0 / removed 0 per its own report). "
            + "promotedEvents = AutomationEvent rows whose typed evidence columns were filled "
            + "from data already present in their own detail JSON (reversible by nulling both columns).",
        counts: {
            recentExpenses: recentExpenses.length,
            classifications: classifications.length,
            byClassification,
            promotedEvents: promotedEvents.length,
        },
        recentExpenses,
        classifications,
        promotedEvents,
    };

    writeFileSync(out, JSON.stringify(snapshot, null, 2));
    console.log(`snapshot written: ${out}`);
    console.log(`  expenses created in last 6h with a qbPurchaseId: ${recentExpenses.length}`);
    console.log(`  classifications: ${classifications.length}`, byClassification);
    console.log(`  automation events with promoted evidence columns: ${promotedEvents.length}`);
} finally {
    await prisma.$disconnect();
}
