// E2E checks for the company start-date core (src/lib/schedule-core.ts):
//   - Waiting-to-Start move +7d shifts all job tasks by the same delta
//   - linked milestone mirror groups shift on BOTH mirrors (EstimatePaymentSchedule
//     + PaymentSchedule clones via sourceScheduleId)
//   - a group with ANY qbInvoiceId clone is skipped ENTIRELY and reported
//   - unlinked milestones are untouched
//   - In-Progress projects move the marker only (tasks untouched)
//   - closed projects are refused
//   - ActivityLog actorType is TEAM for UI calls and SYSTEM for MCP calls
//   - parseStartDateInput rejects malformed/timezone-bearing/overflowing dates
// Creates its own fixtures (far-future dates, "DELETE ME" names) and cleans
// them all up. Mirrors scripts/verify-billing-tools.ts. Run AFTER
// scripts/apply-company-schedule-schema.mjs has been applied.
//
// NOTE: concurrent-move serialization (two setProjectStartDate calls racing on
// the same project) is covered by the SELECT ... FOR UPDATE row lock at the top
// of the core's transaction — not easily testable from a single-threaded script.
import { prisma } from "../src/lib/prisma";
import { setProjectStartDate, parseStartDateInput } from "../src/lib/schedule-core";
import { createInvoiceFromEstimate } from "../src/lib/actions";

async function main() {
    const checks: [string, boolean][] = [];
    const DAY = 86_400_000;
    const base = Date.UTC(2030, 0, 1); // far-future so fixtures can't collide with real rows
    const iso = (ms: number) => new Date(ms).toISOString();

    // --- 0. Strict date parser (pure function, no DB): only YYYY-MM-DD that
    // round-trips through the UTC helpers may reach the core.
    for (const bad of ["2026-13-45", "August 5 2026", "2026-08-05T10:00:00Z"]) {
        let threw = false;
        try { parseStartDateInput(bad); } catch { threw = true; }
        checks.push([`parseStartDateInput rejects "${bad}"`, threw]);
    }
    checks.push(["parseStartDateInput accepts a real date", parseStartDateInput("2030-01-08").toISOString() === "2030-01-08T00:00:00.000Z"]);

    // --- Fixtures: client → lead (expectedStartDate) → project, created
    // directly (NOT via convertLeadToProject — that provisions Google Drive
    // folders and geocodes). Mirrors the conversion's project fields.
    const client = await prisma.client.create({ data: { name: "SCHED VERIFY DELETE ME", initials: "SV" } });
    const lead = await prisma.lead.create({
        data: {
            name: "Sched verify job — delete me",
            clientId: client.id,
            expectedStartDate: new Date(base),
            stage: "Won",
            isUnread: false,
        },
    });
    const project = await prisma.project.create({
        data: {
            name: lead.name,
            clientId: client.id,
            leadId: lead.id,
            status: "Waiting to Start",
            startDate: lead.expectedStartDate,
            type: "Verify",
        },
    });
    const inProgressProject = await prisma.project.create({
        data: { name: "Sched verify IP — delete me", clientId: client.id, status: "In Progress", startDate: new Date(base) },
    });

    const task1 = await prisma.scheduleTask.create({
        data: { projectId: project.id, name: "Verify task 1", startDate: new Date(base), endDate: new Date(base + 4 * DAY) },
    });
    const task2 = await prisma.scheduleTask.create({
        data: { projectId: project.id, name: "Verify task 2", startDate: new Date(base + 5 * DAY), endDate: new Date(base + 9 * DAY) },
    });
    const ipTask = await prisma.scheduleTask.create({
        data: { projectId: inProgressProject.id, name: "Verify IP task", startDate: new Date(base), endDate: new Date(base + 2 * DAY) },
    });

    // Milestone groups anchored to the tasks:
    //  A) QB-flagged group: EPS linked to task1 + TWO PaymentSchedule clones
    //     via sourceScheduleId, one with qbInvoiceId → whole group stays put.
    //  B) Clean group: EPS linked to task1 + one unflagged clone → all shift.
    //  C) Solo linked EPS on task2 (no clones) → EPS shifts.
    //  D) Unlinked milestone → untouched.
    const estimate = await prisma.estimate.create({
        data: { title: "Sched verify estimate", projectId: project.id, code: "EST-VERIFY-DELETE", status: "Approved", totalAmount: 1000, balanceDue: 1000 },
    });
    const epsA = await prisma.estimatePaymentSchedule.create({
        data: { estimateId: estimate.id, name: "QB group milestone", amount: 100, dueDate: new Date(base + 10 * DAY), scheduleTaskId: task1.id },
    });
    const epsB = await prisma.estimatePaymentSchedule.create({
        data: { estimateId: estimate.id, name: "Clean group milestone", amount: 200, dueDate: new Date(base + 20 * DAY), scheduleTaskId: task1.id },
    });
    const epsC = await prisma.estimatePaymentSchedule.create({
        data: { estimateId: estimate.id, name: "Solo linked milestone", amount: 300, dueDate: new Date(base + 30 * DAY), scheduleTaskId: task2.id },
    });
    const invoice = await prisma.invoice.create({
        data: { code: "INV-VERIFY-DELETE", projectId: project.id, clientId: client.id, estimateId: estimate.id, status: "Issued", totalAmount: 600, balanceDue: 600 },
    });
    const psA1 = await prisma.paymentSchedule.create({
        data: { invoiceId: invoice.id, sourceScheduleId: epsA.id, scheduleTaskId: task1.id, name: epsA.name, amount: 100, dueDate: new Date(base + 10 * DAY), qbInvoiceId: "qb-verify-123" },
    });
    const psA2 = await prisma.paymentSchedule.create({
        data: { invoiceId: invoice.id, sourceScheduleId: epsA.id, scheduleTaskId: task1.id, name: `${epsA.name} (2)`, amount: 50, dueDate: new Date(base + 11 * DAY) },
    });
    const psB = await prisma.paymentSchedule.create({
        data: { invoiceId: invoice.id, sourceScheduleId: epsB.id, scheduleTaskId: task1.id, name: epsB.name, amount: 200, dueDate: new Date(base + 20 * DAY) },
    });
    const psUnlinked = await prisma.paymentSchedule.create({
        data: { invoiceId: invoice.id, name: "Unlinked milestone", amount: 250, dueDate: new Date(base + 25 * DAY) },
    });

    // Ids of the invoice-path fixture (section 6), cleaned up in finally.
    let pathInvoiceId: string | null = null;
    let pathEstimateId: string | null = null;

    try {
        // --- 1. TEAM (UI) move: base → base+7
        // REGRESSION (post bulk-shift rewrite): the +7d move must shift exactly
        // the same rows as the original per-row implementation — both tasks,
        // epsB+psB+epsC on the milestone side, nothing else.
        const move1 = await setProjectStartDate({
            projectId: project.id,
            startDate: new Date(base + 7 * DAY),
            shiftJobTasks: true,
            actor: { type: "TEAM", name: "Verify UI" },
        });
        checks.push(["previousStartDate reported", move1.previousStartDate === iso(base)]);
        checks.push(["new startDate reported", move1.startDate === iso(base + 7 * DAY)]);
        checks.push(["2 tasks shifted", move1.shiftedTasks === 2]);
        checks.push(["3 milestone rows shifted (epsB+psB+epsC)", move1.shiftedMilestones === 3]);
        checks.push(["1 QB group skipped", move1.skippedQbMilestones.length === 1]);
        checks.push(["skip names the EPS row", move1.skippedQbMilestones[0]?.estimatePaymentScheduleId === epsA.id]);
        checks.push(["skip lists both clones", move1.skippedQbMilestones[0]?.paymentScheduleIds.length === 2]);
        checks.push(["skip is explained in notes", move1.notes.some(n => /quickbooks/i.test(n))]);

        const t1 = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: task1.id } });
        const t2 = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: task2.id } });
        checks.push(["task1 start shifted +7d", t1.startDate.getTime() === base + 7 * DAY]);
        checks.push(["task1 end shifted +7d", t1.endDate.getTime() === base + 11 * DAY]);
        checks.push(["task2 shifted +7d", t2.startDate.getTime() === base + 12 * DAY && t2.endDate.getTime() === base + 16 * DAY]);

        const epsA1 = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: epsA.id } });
        const psA1r = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: psA1.id } });
        const psA2r = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: psA2.id } });
        checks.push(["QB group EPS unchanged", epsA1.dueDate?.getTime() === base + 10 * DAY]);
        checks.push(["QB-flagged clone unchanged", psA1r.dueDate?.getTime() === base + 10 * DAY]);
        checks.push(["sibling clone in QB group unchanged", psA2r.dueDate?.getTime() === base + 11 * DAY]);

        const epsB1 = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: epsB.id } });
        const psB1 = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: psB.id } });
        checks.push(["clean group EPS shifted", epsB1.dueDate?.getTime() === base + 27 * DAY]);
        checks.push(["clean group clone shifted", psB1.dueDate?.getTime() === base + 27 * DAY]);
        const epsC1 = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: epsC.id } });
        checks.push(["solo linked EPS shifted", epsC1.dueDate?.getTime() === base + 37 * DAY]);
        const psU = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: psUnlinked.id } });
        checks.push(["unlinked milestone untouched", psU.dueDate?.getTime() === base + 25 * DAY]);

        // --- 2. SYSTEM (MCP) move: base+7 → base+14
        const move2 = await setProjectStartDate({
            projectId: project.id,
            startDate: new Date(base + 14 * DAY),
            shiftJobTasks: true,
            actor: { type: "SYSTEM", name: "ChatGPT connector" },
        });
        checks.push(["second move shifts tasks again", move2.shiftedTasks === 2]);
        const logs = await prisma.activityLog.findMany({
            where: { projectId: project.id, action: "moved_project_start" },
            orderBy: { createdAt: "asc" },
        });
        checks.push(["ActivityLog written for both moves", logs.length === 2]);
        checks.push(["UI move logged as TEAM", logs[0]?.actorType === "TEAM" && logs[0]?.actorName === "Verify UI"]);
        checks.push(["MCP move logged as SYSTEM", logs[1]?.actorType === "SYSTEM" && logs[1]?.actorName === "ChatGPT connector"]);
        const meta = JSON.parse(logs[1]?.metadata ?? "{}");
        checks.push(["metadata records dates + counts", meta.previousStartDate === iso(base + 7 * DAY) && meta.startDate === iso(base + 14 * DAY) && meta.shiftedTasks === 2]);

        // --- 3. In-Progress project: marker moves, tasks untouched
        const moveIp = await setProjectStartDate({
            projectId: inProgressProject.id,
            startDate: new Date(base + 21 * DAY),
            shiftJobTasks: true,
            actor: { type: "TEAM", name: "Verify UI" },
        });
        const ipTaskAfter = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: ipTask.id } });
        checks.push(["In-Progress marker moved", moveIp.startDate === iso(base + 21 * DAY)]);
        checks.push(["In-Progress shifts no tasks", moveIp.shiftedTasks === 0 && ipTaskAfter.startDate.getTime() === base]);

        // --- 4. Closed projects refused
        await prisma.project.update({ where: { id: inProgressProject.id }, data: { status: "Closed Complete" } });
        let refused = false;
        try {
            await setProjectStartDate({
                projectId: inProgressProject.id,
                startDate: new Date(base + 28 * DAY),
                actor: { type: "TEAM", name: "Verify UI" },
            });
        } catch {
            refused = true;
        }
        checks.push(["closed project refused", refused]);

        // --- 5. Negative delta: move base+14 → base+7 exercises the '-N days'
        // interval sign (Postgres parses it; a malformed sign would 400 here).
        const moveBack = await setProjectStartDate({
            projectId: project.id,
            startDate: new Date(base + 7 * DAY),
            shiftJobTasks: true,
            actor: { type: "SYSTEM", name: "ChatGPT connector" },
        });
        const t1Back = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: task1.id } });
        const epsBBack = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: epsB.id } });
        checks.push(["backward move shifts tasks -7d", moveBack.shiftedTasks === 2 && t1Back.startDate.getTime() === base + 7 * DAY]);
        checks.push(["backward move shifts milestones -7d", epsBBack.dueDate?.getTime() === base + 27 * DAY]);
        const epsABack = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: epsA.id } });
        checks.push(["QB group still unchanged after backward move", epsABack.dueDate?.getTime() === base + 10 * DAY && moveBack.skippedQbMilestones.length === 1]);

        // --- 6. Clone-via-invoice-path fixture: exercises the locked read+insert
        // transaction in createInvoiceFromEstimate end-to-end (the concurrency
        // race it fixes needs two simultaneous transactions — not reproducible
        // single-threaded; asserted here is that the path still produces a
        // correct mirror group and that group participates in later shifts).
        const estimate2 = await prisma.estimate.create({
            data: { title: "Sched verify estimate 2", projectId: project.id, code: "EST-VERIFY-DELETE-2", status: "Approved", totalAmount: 400, balanceDue: 400 },
        });
        pathEstimateId = estimate2.id;
        const epsPath = await prisma.estimatePaymentSchedule.create({
            data: { estimateId: estimate2.id, name: "Path clone milestone", amount: 400, dueDate: new Date(base + 40 * DAY), scheduleTaskId: task1.id },
        });
        // revalidatePath throws outside a request context (fine in scripts) —
        // swallow it and verify via lookup, same as verify-billing-tools.ts.
        const tolerantCreateInvoice = async (estId: string) => {
            try { return await createInvoiceFromEstimate(estId); } catch (e: any) {
                if (!String(e?.message).includes("static generation store")) throw e;
                const found = await prisma.invoice.findFirst({ where: { estimateId: estId }, orderBy: { createdAt: "desc" }, select: { id: true, projectId: true } });
                if (!found) throw e;
                return { id: found.id, projectId: found.projectId };
            }
        };
        const pathResult = await tolerantCreateInvoice(estimate2.id);
        pathInvoiceId = pathResult.id;
        const pathClones = await prisma.paymentSchedule.findMany({ where: { invoiceId: pathResult.id } });
        checks.push(["invoice path creates exactly one clone", pathClones.length === 1]);
        checks.push(["clone mirrors the source dueDate", pathClones[0]?.dueDate?.getTime() === base + 40 * DAY]);
        checks.push(["clone carries sourceScheduleId + scheduleTaskId", pathClones[0]?.sourceScheduleId === epsPath.id && pathClones[0]?.scheduleTaskId === task1.id]);

        // A subsequent start move shifts the path-created clone with its group.
        await setProjectStartDate({
            projectId: project.id,
            startDate: new Date(base + 14 * DAY),
            shiftJobTasks: true,
            actor: { type: "SYSTEM", name: "ChatGPT connector" },
        });
        const pathCloneAfter = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: pathClones[0]!.id } });
        checks.push(["path-created clone shifts with its group", pathCloneAfter.dueDate?.getTime() === base + 47 * DAY]);
    } finally {
        // Full cleanup, parent rows last (FK constraints).
        await prisma.activityLog.deleteMany({ where: { projectId: { in: [project.id, inProgressProject.id] } } });
        await prisma.paymentSchedule.deleteMany({ where: { invoiceId: invoice.id } });
        await prisma.invoice.delete({ where: { id: invoice.id } });
        if (pathInvoiceId) await prisma.invoice.delete({ where: { id: pathInvoiceId } }); // cascades its clones
        await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId: estimate.id } });
        await prisma.estimate.delete({ where: { id: estimate.id } });
        if (pathEstimateId) await prisma.estimate.delete({ where: { id: pathEstimateId } }); // cascades its EPS rows
        await prisma.scheduleTask.deleteMany({ where: { projectId: { in: [project.id, inProgressProject.id] } } });
        await prisma.project.deleteMany({ where: { id: { in: [project.id, inProgressProject.id] } } });
        await prisma.lead.delete({ where: { id: lead.id } });
        await prisma.client.delete({ where: { id: client.id } });
        console.log("cleanup done");
    }

    let failed = 0;
    for (const [label, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
    if (failed) throw new Error(`${failed} checks failed`);
    console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
