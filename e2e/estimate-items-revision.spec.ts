import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Real-Postgres coverage for the `Estimate.itemsRevision` optimistic-concurrency guard — see
 * docs/specs/estimate-item-optimistic-concurrency.md REVISION 2.
 *
 * tests/estimate-item-upsert.test.ts only exercises a hand-written fake `tx`, which proves the
 * create/update routing but nothing about real compare-and-set or rollback semantics (a fake
 * `updateMany` just returns whatever a test tells it to). This spec runs the actual CAS
 * statement and an actual rolled-back transaction against the throwaway CI Postgres container
 * (data.setup.ts refuses to run against Supabase/prod — see docs/TESTING.md).
 *
 * No `page` fixture is used — this never touches the browser, only the database — but it still
 * lives in e2e/ so it inherits the "data" + "setup" project dependency chain in
 * playwright.config.ts, which is what gives it the prod-DB guard for free.
 */

const IDS = {
    client: "eir-e2e-client",
    lead: "eir-e2e-lead",
    estimate: "eir-e2e-estimate",
    item: "eir-e2e-item-1",
};

const prisma = new PrismaClient();

test.describe("Estimate.itemsRevision compare-and-set (real DB)", () => {
    test.beforeAll(async () => {
        await prisma.client.upsert({
            where: { id: IDS.client },
            update: {},
            create: { id: IDS.client, name: "ItemsRevision Drill Client", initials: "IR" },
        });
        await prisma.lead.upsert({
            where: { id: IDS.lead },
            update: {},
            create: { id: IDS.lead, name: "ItemsRevision Drill Lead", clientId: IDS.client, stage: "Estimate Sent" },
        });
        await prisma.estimate.upsert({
            where: { id: IDS.estimate },
            update: { itemsRevision: 0 },
            create: {
                id: IDS.estimate,
                title: "ItemsRevision Drill",
                code: "EST-EIRTEST",
                leadId: IDS.lead,
                status: "Draft",
                totalAmount: 100,
                balanceDue: 100,
                itemsRevision: 0,
            },
        });
        await prisma.estimateItem.upsert({
            where: { id: IDS.item },
            update: {},
            create: {
                id: IDS.item,
                estimateId: IDS.estimate,
                name: "Original Item",
                type: "Material",
                quantity: 1,
                unitCost: 100,
                total: 100,
                order: 0,
            },
        });
    });

    test.afterAll(async () => {
        try {
            await prisma.estimateItem.deleteMany({ where: { estimateId: IDS.estimate } });
            await prisma.estimate.deleteMany({ where: { id: IDS.estimate } });
            await prisma.lead.deleteMany({ where: { id: IDS.lead } });
            await prisma.client.deleteMany({ where: { id: IDS.client } });
        } finally {
            await prisma.$disconnect();
        }
    });

    test("a stale itemsRevision CAS matches zero rows; the fresh one matches exactly one and increments", async () => {
        const before = await prisma.estimate.findUniqueOrThrow({
            where: { id: IDS.estimate },
            select: { itemsRevision: true },
        });
        const freshRevision = before.itemsRevision;

        // A competing write bumps the revision first — exactly what a second editor tab's save
        // does. This "session"'s in-memory `freshRevision` is now stale.
        await prisma.estimate.update({
            where: { id: IDS.estimate },
            data: { itemsRevision: { increment: 1 } },
        });
        const afterCompetingWrite = await prisma.estimate.findUniqueOrThrow({
            where: { id: IDS.estimate },
            select: { itemsRevision: true },
        });
        expect(afterCompetingWrite.itemsRevision).toBe(freshRevision + 1);

        // The exact statement saveEstimate runs, with the now-stale revision this "session"
        // still believes is current.
        const staleCas = await prisma.estimate.updateMany({
            where: { id: IDS.estimate, itemsRevision: freshRevision },
            data: { itemsRevision: { increment: 1 } },
        });
        expect(staleCas.count).toBe(0);

        const afterStaleCas = await prisma.estimate.findUniqueOrThrow({
            where: { id: IDS.estimate },
            select: { itemsRevision: true },
        });
        // A failed CAS must not move the counter.
        expect(afterStaleCas.itemsRevision).toBe(freshRevision + 1);

        // The same statement with the actually-current revision matches and increments.
        const freshCas = await prisma.estimate.updateMany({
            where: { id: IDS.estimate, itemsRevision: afterCompetingWrite.itemsRevision },
            data: { itemsRevision: { increment: 1 } },
        });
        expect(freshCas.count).toBe(1);

        const afterFreshCas = await prisma.estimate.findUniqueOrThrow({
            where: { id: IDS.estimate },
            select: { itemsRevision: true },
        });
        expect(afterFreshCas.itemsRevision).toBe(freshRevision + 2);
    });

    test("a transaction that throws after writing an item leaves the items table untouched", async () => {
        const before = await prisma.estimateItem.findMany({
            where: { estimateId: IDS.estimate },
            select: { id: true },
            orderBy: { id: "asc" },
        });

        const doomedId = "eir-e2e-item-doomed";
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.estimateItem.create({
                    data: {
                        id: doomedId,
                        estimateId: IDS.estimate,
                        name: "Should Never Persist",
                        type: "Material",
                        quantity: 1,
                        unitCost: 1,
                        total: 1,
                        order: 99,
                    },
                });
                throw new Error("simulated post-write failure (mirrors EstimateStaleSaveError rolling back saveEstimate)");
            }),
        ).rejects.toThrow("simulated post-write failure");

        const after = await prisma.estimateItem.findMany({
            where: { estimateId: IDS.estimate },
            select: { id: true },
            orderBy: { id: "asc" },
        });
        expect(after).toEqual(before);

        const doomed = await prisma.estimateItem.findUnique({ where: { id: doomedId } });
        expect(doomed).toBeNull();
    });
});
