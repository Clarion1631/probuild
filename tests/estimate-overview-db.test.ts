/**
 * Project Overview / Vision cover page through the MCP connector, against a REAL database.
 *
 * Drives the same functions the get_estimate and update_estimate tools call
 * (estimateToPhases, updateEstimateFromPhases) on a seeded test estimate: create the
 * overview, show it, edit it, clear it, read it back. After every step it checks that
 * nothing else on the estimate moved (prices, line items, milestones, memo, terms, status,
 * sharing). It then renders the real estimate PDF (generateEstimatePdf) and checks the
 * overview is page 1 with the priced detail starting on page 2.
 *
 * Opt-in by URL, like the other DB tests here: a normal unit run must never be able to
 * touch a developer database. The migrations CI job supplies the URL. The functions under
 * test use the app's prisma singleton, so DATABASE_URL must point at the same database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

const OVERVIEW_TEXT_1 = "We are opening the kitchen to the family room and moving the sink to the island.";
const OVERVIEW_TEXT_2 = "Phase one is demolition and framing.";
const ITEM_NAMES = ["Cabinet install labor", "Quartz countertop allowance"];
const MILESTONE_NAMES = ["Deposit", "Final payment"];

type Seeded = { clientId: string; projectId: string; estimateId: string; code: string; approvedId: string; approvedCode: string };

async function seed(db: PrismaClient, tag: string): Promise<Seeded> {
    const client = await db.client.create({ data: { name: `Overview Client ${tag}`, initials: "OC", email: `overview-${tag}@example.test` } });
    const project = await db.project.create({ data: { name: `Overview Job ${tag}`, clientId: client.id } });
    const code = `EST-OVT-${tag}`;
    const estimate = await db.estimate.create({
        data: {
            title: `Overview Kitchen ${tag}`,
            code,
            projectId: project.id,
            status: "Sent",
            privacy: "Shared",
            sentAt: new Date("2026-10-20T17:00:00Z"),
            totalAmount: 10840,
            balanceDue: 10840,
            taxRateName: "Vancouver",
            taxRatePercent: 8.4,
            memo: "Customer memo stays put.",
            termsAndConditions: "<p>Terms stay put.</p>",
            itemsRevision: 3,
        },
    });
    const section = await db.estimateItem.create({
        data: { estimateId: estimate.id, name: "Kitchen", type: "Section", quantity: 1, unitCost: 0, total: 0, order: 0 },
    });
    await db.estimateItem.create({
        data: { estimateId: estimate.id, parentId: section.id, name: ITEM_NAMES[0], type: "Labor", quantity: 1, baseCost: 3000, markupPercent: 25, unitCost: 4000, total: 4000, order: 1 },
    });
    await db.estimateItem.create({
        data: { estimateId: estimate.id, parentId: section.id, name: ITEM_NAMES[1], type: "Allowance", quantity: 1, baseCost: 4500, markupPercent: 25, unitCost: 6000, total: 6000, order: 2 },
    });
    await db.estimatePaymentSchedule.create({ data: { estimateId: estimate.id, name: MILESTONE_NAMES[0], percentage: 50, amount: 5420, order: 0 } });
    await db.estimatePaymentSchedule.create({ data: { estimateId: estimate.id, name: MILESTONE_NAMES[1], percentage: 50, amount: 5420, order: 1 } });

    const approvedCode = `EST-OVA-${tag}`;
    const approved = await db.estimate.create({
        data: {
            title: `Signed Kitchen ${tag}`,
            code: approvedCode,
            projectId: project.id,
            status: "Approved",
            approvedAt: new Date("2026-10-21T17:00:00Z"),
            totalAmount: 1000,
            balanceDue: 1000,
        },
    });
    return { clientId: client.id, projectId: project.id, estimateId: estimate.id, code, approvedId: approved.id, approvedCode };
}

async function cleanup(db: PrismaClient, s: Seeded) {
    const drop = (run: () => Promise<unknown>) => run().catch(() => {});
    await drop(() => db.estimatePaymentSchedule.deleteMany({ where: { estimateId: { in: [s.estimateId, s.approvedId] } } }));
    await drop(() => db.estimateItem.deleteMany({ where: { estimateId: { in: [s.estimateId, s.approvedId] }, parentId: { not: null } } }));
    await drop(() => db.estimateItem.deleteMany({ where: { estimateId: { in: [s.estimateId, s.approvedId] } } }));
    await drop(() => db.estimate.deleteMany({ where: { id: { in: [s.estimateId, s.approvedId] } } }));
    await drop(() => db.project.deleteMany({ where: { id: s.projectId } }));
    await drop(() => db.client.deleteMany({ where: { id: s.clientId } }));
}

/** Everything on the estimate the overview tool must never move, in comparable form. */
async function protectedState(db: PrismaClient, estimateId: string) {
    const e = await db.estimate.findUniqueOrThrow({
        where: { id: estimateId },
        include: {
            items: { orderBy: { order: "asc" } },
            paymentSchedules: { orderBy: { order: "asc" } },
        },
    });
    const rest: Record<string, unknown> = { ...e };
    for (const key of ["overviewEnabled", "overviewTitle", "overviewBody", "itemsRevision"]) delete rest[key];
    return JSON.parse(JSON.stringify(rest));
}

async function revision(db: PrismaClient, estimateId: string): Promise<number> {
    return (await db.estimate.findUniqueOrThrow({ where: { id: estimateId }, select: { itemsRevision: true } })).itemsRevision;
}

async function pdfPages(buffer: Buffer): Promise<string[]> {
    const mod: any = await import("pdf-parse");
    const PDFParse = mod.PDFParse ?? mod.default?.PDFParse;
    const parser = new PDFParse({ data: buffer });
    try {
        const result = await parser.getText();
        return (result.pages as { text: string }[]).map(p => p.text.replace(/\s+/g, " "));
    } finally {
        await parser.destroy?.();
    }
}

test("overview create, show, edit, clear and read back through the connector functions, touching nothing else", { skip }, async () => {
    // The functions under test write through the app singleton (DATABASE_URL) while seeding uses
    // PAYROLL_LOCK_TEST_URL: they must be the same server and database, options aside.
    const where = (u: string) => { const p = new URL(u); return `${p.hostname}:${p.port || "5432"}${p.pathname}`; };
    assert.equal(where(process.env.DATABASE_URL ?? "postgresql://unset/"), where(databaseUrl!), "DATABASE_URL must point at the PAYROLL_LOCK_TEST_URL database");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { estimateToPhases, updateEstimateFromPhases } = await import("../src/lib/gpt-estimate");
    const { generateEstimatePdf } = await import("../src/lib/pdf");
    const tag = `${Date.now()}`;
    const s = await seed(db, tag);
    try {
        const before = await protectedState(db, s.estimateId);
        const assertUntouched = async (step: string) =>
            assert.deepEqual(await protectedState(db, s.estimateId), before, `${step}: a non-overview field moved`);

        // Read: a fresh estimate has no cover page.
        let read = await estimateToPhases(s.code);
        assert.ok(read.ok);
        assert.equal(read.overviewEnabled, false);
        assert.equal(read.overviewTitle, null);
        assert.equal(read.overviewBody, null);
        assert.equal(read.overviewOnCoverPage, false);

        // Create: text only. The toggle is NOT flipped for the caller, and it says so.
        let res = await updateEstimateFromPhases({ estimate: s.code, overviewBody: `${OVERVIEW_TEXT_1}\n\n${OVERVIEW_TEXT_2}` });
        assert.ok(res.ok, JSON.stringify(res));
        assert.deepEqual(res.changed, ["overview text"]);
        assert.equal(res.overviewOnCoverPage, false);
        assert.ok(res.warnings.some(w => /hidden: overviewEnabled is false/.test(w)), "warns that the text is hidden");
        assert.ok(!res.warnings.some(w => /Nothing was emailed/.test(w)), "hidden text changes nothing the customer sees");
        assert.equal(await revision(db, s.estimateId), 4, "an overview change bumps itemsRevision so a stale editor tab cannot revert it");
        await assertUntouched("create");

        // Show + retitle: the omitted body is left alone.
        res = await updateEstimateFromPhases({ estimate: s.code, overviewEnabled: true, overviewTitle: "Project Vision" });
        assert.ok(res.ok, JSON.stringify(res));
        assert.deepEqual(res.changed, ["overview shown", "overview title"]);
        assert.equal(res.overviewOnCoverPage, true);
        assert.ok(res.warnings.some(w => /portal.*Nothing was emailed/.test(w)), "a shared, sent estimate: the customer sees it now");
        read = await estimateToPhases(s.code);
        assert.ok(read.ok);
        assert.equal(read.overviewBody, `<p>${OVERVIEW_TEXT_1}</p><p>${OVERVIEW_TEXT_2}</p>`);
        await assertUntouched("show");

        // Re-sending current values writes nothing and does not bump the revision.
        const rev = await revision(db, s.estimateId);
        res = await updateEstimateFromPhases({ estimate: s.code, overviewEnabled: true, overviewTitle: "Project Vision" });
        assert.ok(res.ok);
        assert.deepEqual(res.changed, []);
        assert.equal(await revision(db, s.estimateId), rev);

        // ...including a legacy plain-text body echoed back exactly as get_estimate returned it,
        // which normalization alone would have rewritten as HTML.
        await db.estimate.update({ where: { id: s.estimateId }, data: { overviewBody: "Legacy plain text  " } });
        const legacyRev = await revision(db, s.estimateId);
        read = await estimateToPhases(s.code);
        assert.ok(read.ok);
        res = await updateEstimateFromPhases({ estimate: s.code, overviewBody: read.overviewBody, overviewTitle: read.overviewTitle });
        assert.ok(res.ok);
        assert.deepEqual(res.changed, []);
        assert.equal(await revision(db, s.estimateId), legacyRev);

        // Edit with editor HTML: replaces the body only.
        const html = `<h2>The plan</h2><p>${OVERVIEW_TEXT_1}</p><ul><li>${OVERVIEW_TEXT_2}</li></ul>`;
        res = await updateEstimateFromPhases({ estimate: s.code, overviewBody: html });
        assert.ok(res.ok, JSON.stringify(res));
        assert.deepEqual(res.changed, ["overview text"]);
        read = await estimateToPhases(s.code);
        assert.ok(read.ok);
        assert.deepEqual(
            { enabled: read.overviewEnabled, title: read.overviewTitle, body: read.overviewBody, onCover: read.overviewOnCoverPage },
            { enabled: true, title: "Project Vision", body: html, onCover: true },
        );
        assert.equal(read.totalAmount, 10840);
        await assertUntouched("edit");

        // The PDF: the overview is page 1, the priced detail starts on page 2.
        let pages = await pdfPages(await generateEstimatePdf(s.estimateId));
        assert.ok(pages.length >= 2, `expected a cover page plus detail, got ${pages.length} page(s)`);
        assert.match(pages[0], /Project Vision/);
        assert.match(pages[0], /The plan/);
        assert.match(pages[0], /opening the kitchen to the family room/);
        for (const name of [...ITEM_NAMES, ...MILESTONE_NAMES]) {
            assert.ok(!pages[0].includes(name), `page 1 must carry no pricing, found "${name}"`);
            assert.ok(pages.slice(1).some(p => p.includes(name)), `"${name}" missing from the rest of the estimate`);
        }
        assert.ok(pages.slice(1).some(p => /10,840\.00/.test(p)), "the total is still on the estimate");

        // Clear with null: no cover page, the toggle is left as it was, and the caller is told.
        res = await updateEstimateFromPhases({ estimate: s.code, overviewBody: null });
        assert.ok(res.ok, JSON.stringify(res));
        assert.deepEqual(res.changed, ["overview text cleared"]);
        assert.equal(res.overviewOnCoverPage, false);
        assert.ok(res.warnings.some(w => /no cover page shows until overviewBody is set/.test(w)));
        read = await estimateToPhases(s.code);
        assert.ok(read.ok);
        assert.equal(read.overviewBody, null);
        assert.equal(read.overviewEnabled, true);
        assert.equal(read.overviewTitle, "Project Vision");
        await assertUntouched("clear");

        pages = await pdfPages(await generateEstimatePdf(s.estimateId));
        assert.ok(!pages[0].includes("Project Vision"), "a cleared overview leaves no cover page");
        assert.ok(pages[0].includes(ITEM_NAMES[0]), "without a cover page the line items start on page 1");

        // Clear with an empty string and reset the title the same way.
        await updateEstimateFromPhases({ estimate: s.code, overviewBody: "Back again." });
        res = await updateEstimateFromPhases({ estimate: s.code, overviewBody: "", overviewTitle: "" });
        assert.ok(res.ok, JSON.stringify(res));
        assert.deepEqual(res.changed, ["overview title", "overview text cleared"]);
        read = await estimateToPhases(s.code);
        assert.ok(read.ok);
        assert.equal(read.overviewBody, null);
        assert.equal(read.overviewTitle, null);
        await assertUntouched("clear with empty strings");

        // A signed estimate is refused and left exactly as it was.
        const approvedBefore = await db.estimate.findUniqueOrThrow({ where: { id: s.approvedId } });
        const refused = await updateEstimateFromPhases({ estimate: s.approvedCode, overviewEnabled: true, overviewBody: "Should not land." });
        assert.equal(refused.ok, false);
        assert.match((refused as { error: string }).error, /signed\/approved/);
        assert.deepEqual(
            JSON.parse(JSON.stringify(await db.estimate.findUniqueOrThrow({ where: { id: s.approvedId } }))),
            JSON.parse(JSON.stringify(approvedBefore)),
        );
    } finally {
        await cleanup(db, s);
        await db.$disconnect();
    }
});
