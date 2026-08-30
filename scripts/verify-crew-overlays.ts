// E2E checks for PB-pipeline-002: estimate→schedule generation, crew
// assignment/conflicts, and money/hours overlays (src/lib/schedule-core.ts).
// Creates its own fixtures (far-future 2030 dates, "DELETE ME" names) and
// cleans them all up. Mirrors scripts/verify-company-schedule.ts. Run AFTER
// scripts/apply-schedule-provenance-schema.mjs has been applied.
//
// NOTE: concurrency behavior (FOR UPDATE serialization) is not reproducible
// from a single-threaded script; it is covered by the same lock family as P1.
import fs from "node:fs";
import { prisma } from "../src/lib/prisma";
import {
    generateScheduleFromEstimate,
    setProjectCrew,
    getCrewConflicts,
    getCalendarOverlays,
    getCompanyDashboardData,
} from "../src/lib/schedule-core";
import { importEstimateToSchedule } from "../src/lib/actions";

const DAY = 86_400_000;
const base = Date.UTC(2030, 0, 1); // 2030-01-01 UTC — far-future, no real data
const TEAM = { type: "TEAM" as const, name: "Verify UI" };

async function main() {
    const checks: [string, boolean][] = [];
    const iso = (ms: number) => new Date(ms).toISOString();

    // ── Fixtures ──
    const client = await prisma.client.create({ data: { name: "CREW VERIFY DELETE ME", initials: "CV" } });
    const userA = await prisma.user.create({
        data: { email: "crew-verify-a@example.invalid", name: "Crew Verify Alice", role: "FIELD_CREW", status: "ACTIVATED" },
    });
    const userB = await prisma.user.create({
        data: { email: "crew-verify-b@example.invalid", name: "Crew Verify Bob", role: "FIELD_CREW", status: "PENDING" },
    });
    const userC = await prisma.user.create({
        data: { email: "crew-verify-c@example.invalid", name: "Crew Verify Carol", role: "FIELD_CREW", status: "DISABLED" },
    });

    const projectG = await prisma.project.create({
        data: { name: "Crew verify gen — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base) },
    });
    const estimateG = await prisma.estimate.create({
        data: { title: "Crew verify estimate G", projectId: projectG.id, code: "EST-CREW-VERIFY-G", status: "Approved", totalAmount: 3000, balanceDue: 3000 },
    });
    const phaseA = await prisma.estimateItem.create({
        data: { estimateId: estimateG.id, name: "Phase Alpha", type: "Material", quantity: 1, total: 0, order: 0 },
    });
    const childA1 = await prisma.estimateItem.create({
        data: { estimateId: estimateG.id, name: "Framing labor", type: "Labor", quantity: 10, budgetUnit: "hours", total: 2000, order: 1, parentId: phaseA.id },
    });
    const childA2 = await prisma.estimateItem.create({
        data: { estimateId: estimateG.id, name: "Lumber", type: "Material", quantity: 1, total: 500, order: 2, parentId: phaseA.id },
    });
    const phaseB = await prisma.estimateItem.create({
        data: { estimateId: estimateG.id, name: "Phase Beta", type: "Material", quantity: 1, total: 0, order: 3 },
    });
    const childB1 = await prisma.estimateItem.create({
        data: { estimateId: estimateG.id, name: "Cleanup labor", type: "Labor", quantity: 5, budgetUnit: "hrs", total: 500, order: 4, parentId: phaseB.id },
    });
    const eps1 = await prisma.estimatePaymentSchedule.create({
        data: { estimateId: estimateG.id, name: "Deposit", percentage: 30, amount: 150, dueDate: null, status: "Pending", order: 0 },
    });
    const eps2 = await prisma.estimatePaymentSchedule.create({
        data: { estimateId: estimateG.id, name: "Final", percentage: 70, amount: 200, dueDate: new Date(base + 50 * DAY), status: "Pending", order: 1 },
    });
    const eps3 = await prisma.estimatePaymentSchedule.create({
        data: { estimateId: estimateG.id, name: "Settled fee", percentage: null, amount: 75, dueDate: null, status: "Paid", order: 2 },
    });
    const invoiceG = await prisma.invoice.create({
        data: { code: "INV-CREW-VERIFY-G", projectId: projectG.id, clientId: client.id, estimateId: estimateG.id, status: "Issued", totalAmount: 350, balanceDue: 350 },
    });
    const c1a = await prisma.paymentSchedule.create({
        data: { invoiceId: invoiceG.id, sourceScheduleId: eps1.id, name: "Deposit", amount: 100, status: "Pending", dueDate: null },
    });
    const c1b = await prisma.paymentSchedule.create({
        data: { invoiceId: invoiceG.id, sourceScheduleId: eps1.id, name: "Deposit (QB)", amount: 50, status: "Pending", dueDate: null, qbInvoiceId: "qb-crew-verify-1" },
    });
    const c2 = await prisma.paymentSchedule.create({
        data: { invoiceId: invoiceG.id, sourceScheduleId: eps2.id, name: "Final", amount: 200, status: "Pending", dueDate: null },
    });
    // Overlay fixtures (right-UTC-day sums; Received by paymentDate).
    const expenseG = await prisma.expense.create({
        data: { estimateId: estimateG.id, amount: 123.45, vendor: "VerifyVendor", date: new Date(base + 5 * DAY), status: "Pending" },
    });
    const timeG = await prisma.timeEntry.create({
        data: { userId: userA.id, projectId: projectG.id, startTime: new Date(base + 6 * DAY), durationHours: 3.5, laborCost: 100, burdenCost: 20 },
    });

    // Mixed-weight phases (labor-heavy vs zero-labor) — largest-remainder case.
    const projectM = await prisma.project.create({
        data: { name: "Crew verify mixed — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base), endDate: new Date(base + 8 * DAY) },
    });
    const estimateM = await prisma.estimate.create({
        data: { title: "Crew verify estimate M", projectId: projectM.id, code: "EST-CREW-VERIFY-M", status: "Approved", totalAmount: 2900, balanceDue: 2900 },
    });
    const phaseL1 = await prisma.estimateItem.create({ data: { estimateId: estimateM.id, name: "Phase L1", type: "Material", quantity: 1, total: 0, order: 0 } });
    await prisma.estimateItem.create({ data: { estimateId: estimateM.id, name: "L1 labor", type: "Labor", quantity: 4, budgetUnit: "hours", total: 1000, order: 1, parentId: phaseL1.id } });
    const phaseL2 = await prisma.estimateItem.create({ data: { estimateId: estimateM.id, name: "Phase L2", type: "Material", quantity: 1, total: 0, order: 2 } });
    await prisma.estimateItem.create({ data: { estimateId: estimateM.id, name: "L2 labor", type: "Labor", quantity: 4, budgetUnit: "hours", total: 1000, order: 3, parentId: phaseL2.id } });
    const phaseZ = await prisma.estimateItem.create({ data: { estimateId: estimateM.id, name: "Phase Z", type: "Material", quantity: 1, total: 0, order: 4 } });
    await prisma.estimateItem.create({ data: { estimateId: estimateM.id, name: "Z materials", type: "Material", quantity: 1, total: 900, order: 5, parentId: phaseZ.id } });

    // Phase-less, taskCount > windowDays (packing).
    const projectF = await prisma.project.create({
        data: { name: "Crew verify flat — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base), endDate: new Date(base + 3 * DAY) },
    });
    const estimateF = await prisma.estimate.create({
        data: { title: "Crew verify estimate F", projectId: projectF.id, code: "EST-CREW-VERIFY-F", status: "Approved", totalAmount: 500, balanceDue: 500 },
    });
    for (let i = 0; i < 5; i++) {
        await prisma.estimateItem.create({
            data: { estimateId: estimateF.id, name: `Flat item ${i + 1}`, type: i === 0 ? "Labor" : "Material", quantity: i === 0 ? 8 : 1, budgetUnit: i === 0 ? "hours" : null, total: 100, order: i },
        });
    }

    // Phase-less, non-divisible window (5 tasks / 42 days — finding 2).
    const projectF2 = await prisma.project.create({
        data: { name: "Crew verify flat2 — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base) },
    });
    const estimateF2 = await prisma.estimate.create({
        data: { title: "Crew verify estimate F2", projectId: projectF2.id, code: "EST-CREW-VERIFY-F2", status: "Approved", totalAmount: 500, balanceDue: 500 },
    });
    for (let i = 0; i < 5; i++) {
        await prisma.estimateItem.create({
            data: { estimateId: estimateF2.id, name: `Flat2 item ${i + 1}`, type: "Material", quantity: 1, total: 100, order: i },
        });
    }

    // Importer round-trip fixture (h).
    const projectH = await prisma.project.create({
        data: { name: "Crew verify import — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base) },
    });
    const estimateH = await prisma.estimate.create({
        data: { title: "Crew verify estimate H", projectId: projectH.id, code: "EST-CREW-VERIFY-H", status: "Approved", totalAmount: 100, balanceDue: 100 },
    });
    await prisma.estimateItem.create({ data: { estimateId: estimateH.id, name: "Only line", type: "Material", quantity: 1, total: 100, order: 0 } });

    // Conflict fixtures (e). C2/C3 carry ONLY project-level crew membership
    // (no ScheduleTask, no TaskAssignment) — the "on job crew, no task" soft
    // signal, which must never itself manufacture a conflict. C4 gets a real
    // overlapping TaskAssignment against projectG's taskA1 to prove the
    // task-based rule still fires.
    const projectC2 = await prisma.project.create({
        data: { name: "Crew verify C2 — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base + 10 * DAY), crew: { connect: { id: userA.id } } },
    });
    const projectC3 = await prisma.project.create({
        data: { name: "Crew verify C3 — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base + 60 * DAY), crew: { connect: { id: userA.id } } },
    });
    const projectC4 = await prisma.project.create({
        data: { name: "Crew verify C4 — delete me", clientId: client.id, status: "Waiting to Start", startDate: new Date(base) },
    });

    const allProjectIds = [projectG.id, projectM.id, projectF.id, projectF2.id, projectH.id, projectC2.id, projectC3.id, projectC4.id];

    try {
        // ── (a) generation: structure, dates, provenance, links; merge idempotent ──
        const gen1 = await generateScheduleFromEstimate({ estimateId: estimateG.id, mode: "merge", actor: TEAM });
        checks.push(["(a) generation returns estimate code", gen1.estimateCode === "EST-CREW-VERIFY-G"]);
        checks.push(["(a) 8 tasks created (2 phases + 3 children + 3 milestones)", gen1.created.length === 8]);
        const tasksG = await prisma.scheduleTask.findMany({ where: { projectId: projectG.id }, orderBy: { order: "asc" } });
        const parentA = tasksG.find(t => t.estimateItemId === phaseA.id)!;
        const parentB = tasksG.find(t => t.estimateItemId === phaseB.id)!;
        checks.push(["(a) phase A window [base, base+33)", parentA.startDate.getTime() === base && parentA.endDate.getTime() === base + 33 * DAY]);
        checks.push(["(a) phase B window [base+33, base+42)", parentB.startDate.getTime() === base + 33 * DAY && parentB.endDate.getTime() === base + 42 * DAY]);
        const taskA1 = tasksG.find(t => t.estimateItemId === childA1.id)!;
        const taskA2 = tasksG.find(t => t.estimateItemId === childA2.id)!;
        const taskB1 = tasksG.find(t => t.estimateItemId === childB1.id)!;
        checks.push(["(a) children linked under phase parent", taskA1.parentId === parentA.id && taskA2.parentId === parentA.id && taskB1.parentId === parentB.id]);
        checks.push(["(a) child A1 window [base, base+16)", taskA1.startDate.getTime() === base && taskA1.endDate.getTime() === base + 16 * DAY]);
        checks.push(["(a) child hours from hour-like budgetUnit", taskA1.estimatedHours === 10 && taskB1.estimatedHours === 5 && taskA2.estimatedHours === null]);
        checks.push(["(a) provenance on every generated task", tasksG.every(t => t.generatedFromEstimateId === estimateG.id)]);
        const milestonesG = tasksG.filter(t => t.type === "milestone");
        checks.push(["(a) 3 milestone tasks", milestonesG.length === 3]);

        const taskCountBefore = tasksG.length;
        const gen2 = await generateScheduleFromEstimate({ estimateId: estimateG.id, mode: "merge", actor: TEAM });
        const tasksGAfter2 = await prisma.scheduleTask.findMany({ where: { projectId: projectG.id } });
        checks.push(["(a) merge re-run creates nothing", gen2.created.length === 0 && tasksGAfter2.length === taskCountBefore]);
        checks.push(["(a) merge re-run reports skips", gen2.skipped > 0]);

        // ── (b) milestone canonical-date rule + mirror initialization/linking ──
        const mTask1 = milestonesG.find(t => t.name === "Deposit")!;
        const mTask2 = milestonesG.find(t => t.name === "Final")!;
        const mTask3 = milestonesG.find(t => t.name === "Settled fee")!;
        checks.push(["(b) percentage-derived milestone date (30% of 42d → base+13)", mTask1.startDate.getTime() === base + 13 * DAY]);
        checks.push(["(b) existing EPS dueDate wins (base+50)", mTask2.startDate.getTime() === base + 50 * DAY]);
        checks.push(["(b) unordered/paid row lands at window end", mTask3.startDate.getTime() === base + 42 * DAY]);
        const eps1After = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: eps1.id } });
        const eps2After = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: eps2.id } });
        const eps3After = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: eps3.id } });
        const c1aAfter = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: c1a.id } });
        const c1bAfter = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: c1b.id } });
        const c2AfterB = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: c2.id } });
        checks.push(["(b) null EPS dueDate initialized (Pending only)", eps1After.dueDate?.getTime() === base + 13 * DAY]);
        checks.push(["(b) existing EPS dueDate untouched", eps2After.dueDate?.getTime() === base + 50 * DAY]);
        checks.push(["(b) Paid EPS row never rewritten", eps3After.dueDate === null]);
        checks.push(["(b) non-QB Pending clone initialized", c1aAfter.dueDate?.getTime() === base + 13 * DAY]);
        checks.push(["(b) QB clone keeps empty local date", c1bAfter.dueDate === null]);
        checks.push(["(b) QB-pushed clone reported in notes", gen1.notes.some(n => /quickbooks/i.test(n))]);
        checks.push(["(b) scheduleTaskId on EPS + ALL unpaid clones incl. QB-flagged",
            eps1After.scheduleTaskId === mTask1.id &&
            c1aAfter.scheduleTaskId === mTask1.id &&
            c1bAfter.scheduleTaskId === mTask1.id &&
            c2AfterB.scheduleTaskId === mTask2.id]);
        const overlaysB = await getCalendarOverlays(new Date(base - 7 * DAY), new Date(base + 90 * DAY));
        const incomeC1b = overlaysB.income.find(i => i.id === c1b.id);
        checks.push(["(b) QB null-date clone is projected income on its task date", incomeC1b?.effectiveDueDate === iso(base + 13 * DAY)]);

        // ── (b2) regenerate eligibility: protected subtree kept whole ──
        const manualLookalike = await prisma.scheduleTask.create({
            data: { projectId: projectG.id, name: "Phase Alpha", startDate: new Date(base), endDate: new Date(base + 5 * DAY) },
        });
        await prisma.taskComment.create({ data: { taskId: taskA1.id, text: "protect me", subcontractorName: "verify" } });
        const oldMilestoneTaskId = mTask1.id;
        const regen = await generateScheduleFromEstimate({ estimateId: estimateG.id, mode: "regenerate", actor: TEAM });
        const tasksAfterRegen = await prisma.scheduleTask.findMany({ where: { projectId: projectG.id } });
        const keptA = tasksAfterRegen.find(t => t.id === parentA.id);
        checks.push(["(b2) protected phase subtree kept whole (parent + both children keep ids)",
            !!keptA && tasksAfterRegen.some(t => t.id === taskA1.id) && tasksAfterRegen.some(t => t.id === taskA2.id)]);
        const rebuiltB = tasksAfterRegen.find(t => t.estimateItemId === phaseB.id);
        checks.push(["(b2) untouched phase subtree rebuilt with new ids", !!rebuiltB && rebuiltB.id !== parentB.id]);
        checks.push(["(b2) rebuilt phase B window unchanged", rebuiltB!.startDate.getTime() === base + 33 * DAY && rebuiltB!.endDate.getTime() === base + 42 * DAY]);
        checks.push(["(b2) manual lookalike survives", tasksAfterRegen.some(t => t.id === manualLookalike.id)]);
        checks.push(["(b2) kept subtree reported in notes", regen.notes.some(n => /kept/i.test(n))]);
        const eps1Regen = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: eps1.id } });
        checks.push(["(b2) EPS re-linked to rebuilt milestone task",
            eps1Regen.scheduleTaskId !== null && eps1Regen.scheduleTaskId !== oldMilestoneTaskId &&
            tasksAfterRegen.some(t => t.id === eps1Regen.scheduleTaskId)]);
        checks.push(["(b2) initialized dueDate not overwritten on regenerate", eps1Regen.dueDate?.getTime() === base + 13 * DAY]);

        // ── (c) mixed-weight phases + phase-less packing ──
        await generateScheduleFromEstimate({ estimateId: estimateM.id, mode: "merge", actor: TEAM });
        const tasksM = await prisma.scheduleTask.findMany({ where: { projectId: projectM.id }, orderBy: { order: "asc" } });
        const tL1 = tasksM.find(t => t.estimateItemId === phaseL1.id)!;
        const tL2 = tasksM.find(t => t.estimateItemId === phaseL2.id)!;
        const tZ = tasksM.find(t => t.estimateItemId === phaseZ.id)!;
        checks.push(["(c) labor-heavy L1 gets 4 of 8 days (floor + largest remainder, tie by order)",
            tL1.startDate.getTime() === base && tL1.endDate.getTime() === base + 4 * DAY]);
        checks.push(["(c) L2 gets 3 days, adjacent", tL2.startDate.getTime() === base + 4 * DAY && tL2.endDate.getTime() === base + 7 * DAY]);
        checks.push(["(c) zero-labor phase keeps its reserved day", tZ.startDate.getTime() === base + 7 * DAY && tZ.endDate.getTime() === base + 8 * DAY]);
        checks.push(["(c) slices cover the window exactly",
            tL1.startDate.getTime() === base && tZ.endDate.getTime() === base + 8 * DAY &&
            tL1.endDate.getTime() === tL2.startDate.getTime() && tL2.endDate.getTime() === tZ.startDate.getTime()]);

        await generateScheduleFromEstimate({ estimateId: estimateF.id, mode: "merge", actor: TEAM });
        const tasksF = await prisma.scheduleTask.findMany({ where: { projectId: projectF.id }, orderBy: { order: "asc" } });
        // Packed (5 tasks / 3 days): proportional start offsets floor(k·3/5), each end
        // clamped to start + 1 day (one-day minimum — proportional ends would coincide).
        const expectedStarts = [0, 0, 1, 1, 2].map(d => base + d * DAY);
        const expectedEnds = [1, 1, 2, 2, 3].map(d => base + d * DAY);
        checks.push(["(c) phase-less: 5 flat tasks packed over 3 days (shared start days), order preserved",
            tasksF.length === 5 && tasksF.every((t, i) => t.startDate.getTime() === expectedStarts[i] && t.endDate.getTime() === expectedEnds[i])]);
        checks.push(["(c) packed slices still span the window", tasksF[0].startDate.getTime() === base && tasksF[4].endDate.getTime() === base + 3 * DAY]);
        checks.push(["(c) packed tasks all have >= 1 day duration", tasksF.every(t => t.endDate.getTime() - t.startDate.getTime() >= DAY)]);
        checks.push(["(c) flat labor line gets hours from budgetUnit", tasksF[0].estimatedHours === 8 && tasksF[1].estimatedHours === null]);

        // Non-divisible window (finding 2): 5 tasks / 42 days must cover exactly.
        await generateScheduleFromEstimate({ estimateId: estimateF2.id, mode: "merge", actor: TEAM });
        const tasksF2 = await prisma.scheduleTask.findMany({ where: { projectId: projectF2.id }, orderBy: { order: "asc" } });
        const exp2Starts = [0, 8, 16, 25, 33].map(d => base + d * DAY);
        const exp2Ends = [8, 16, 25, 33, 42].map(d => base + d * DAY);
        checks.push(["(c) non-divisible window: proportional boundaries",
            tasksF2.length === 5 && tasksF2.every((t, i) => t.startDate.getTime() === exp2Starts[i] && t.endDate.getTime() === exp2Ends[i])]);
        checks.push(["(c) non-divisible: exact coverage, last task ends at window end",
            tasksF2.length === 5 && tasksF2[0].startDate.getTime() === base &&
            tasksF2[tasksF2.length - 1].endDate.getTime() === base + 42 * DAY &&
            tasksF2.every((t, i) => i === 0 || t.startDate.getTime() === tasksF2[i - 1].endDate.getTime())]);

        // ── (d) setProjectCrew diff + ACTIVATED validation + picker filter ──
        const crewSet1 = await setProjectCrew({ projectId: projectG.id, userIds: [userA.id], actor: TEAM });
        checks.push(["(d) crew set", crewSet1.crew.length === 1 && crewSet1.crew[0].id === userA.id]);
        let rejected = false;
        try {
            await setProjectCrew({ projectId: projectG.id, userIds: [userA.id, userB.id], actor: TEAM });
        } catch (e: any) {
            rejected = /ACTIVATED/i.test(String(e?.message));
        }
        checks.push(["(d) non-ACTIVATED member rejected", rejected]);
        const crewAfterReject = await prisma.project.findUniqueOrThrow({ where: { id: projectG.id }, select: { crew: { select: { id: true } } } });
        checks.push(["(d) rejected replace left crew unchanged", crewAfterReject.crew.length === 1 && crewAfterReject.crew[0].id === userA.id]);
        const crewSet2 = await setProjectCrew({ projectId: projectG.id, userIds: [userA.id], actor: TEAM });
        checks.push(["(d) idempotent re-set", crewSet2.crew.length === 1 && crewSet2.crew[0].id === userA.id]);
        const dashAdminForPicker = await getCompanyDashboardData({ role: "ADMIN" }, "2030-01");
        checks.push(["(d) picker list is ACTIVATED-filtered",
            (dashAdminForPicker.teamMembers ?? []).some(u => u.id === userA.id) && !(dashAdminForPicker.teamMembers ?? []).some(u => u.id === userB.id)]);

        // ── (e) crew conflicts — TaskAssignment windows ONLY, never project-crew membership ──
        // C2/C3 share userA on project-level crew with projectG, with NO task
        // assignment anywhere on them — the auto-crew rule puts every
        // dispatchable user on every In Progress project, so treating that
        // membership itself as a scheduling window would flag the whole
        // roster whenever two active projects' date ranges merely overlap.
        const taskC4 = await prisma.scheduleTask.create({
            data: { projectId: projectC4.id, name: "C4 overlapping task", startDate: new Date(base + 5 * DAY), endDate: new Date(base + 20 * DAY) },
        });
        await prisma.taskAssignment.create({ data: { taskId: taskA1.id, userId: userA.id } });
        await prisma.taskAssignment.create({ data: { taskId: taskC4.id, userId: userA.id } });

        const conflicts = await getCrewConflicts(new Date(base), new Date(base + 90 * DAY));
        const conflictA = conflicts.find(c => c.userId === userA.id);
        checks.push(["(e) two projects sharing a crew member with NO task assignments produce zero conflicts",
            !conflicts.some(c => c.pairs.some(pr =>
                [pr.projectA.id, pr.projectB.id].includes(projectC2.id) ||
                [pr.projectA.id, pr.projectB.id].includes(projectC3.id)))]);
        checks.push(["(e) overlapping TaskAssignment windows on different projects flagged",
            !!conflictA && conflictA.pairs.some(pr =>
                (pr.projectA.id === projectG.id && pr.projectB.id === projectC4.id) ||
                (pr.projectA.id === projectC4.id && pr.projectB.id === projectG.id))]);
        checks.push(["(e) flagged conflict pair carries taskA/taskB (task-based, no fallback pairs exist)",
            !!conflictA && conflictA.pairs.every(pr => !!pr.taskA && !!pr.taskB)]);

        // ── (d2) inactive assigned crew member is a removable picker entry ──
        await prisma.project.update({ where: { id: projectH.id }, data: { crew: { connect: [{ id: userA.id }, { id: userC.id }] } } });
        const dashInactive = await getCompanyDashboardData({ role: "ADMIN" }, "2030-01");
        const rowH = [...dashInactive.pipeline.waitingToStart, ...dashInactive.pipeline.scheduled, ...dashInactive.pipeline.inProgress]
            .find(r => r.id === projectH.id);
        const inactiveEntry = rowH?.crew.find(c => c.id === userC.id);
        checks.push(["(d2) DISABLED member appears as an assigned-inactive entry", !!inactiveEntry && inactiveEntry.status !== "ACTIVATED"]);
        checks.push(["(d2) picker list excludes the DISABLED member", !(dashInactive.teamMembers ?? []).some(u => u.id === userC.id)]);
        const crewFix = await setProjectCrew({ projectId: projectH.id, userIds: [userA.id], actor: TEAM });
        checks.push(["(d2) save with the inactive id omitted succeeds and removes them",
            crewFix.crew.length === 1 && crewFix.crew[0].id === userA.id]);

        // ── (f) overlays + strip semantics ──
        // c2 becomes Paid with a paymentDate INSIDE the month and a dueDate OUTSIDE —
        // Received must bucket by paymentDate, never dueDate.
        await prisma.paymentSchedule.update({ where: { id: c2.id }, data: { status: "Paid", paymentDate: new Date(base + 7 * DAY) } });
        const overlays = await getCalendarOverlays(new Date(Date.UTC(2029, 11, 31)), new Date(Date.UTC(2030, 1, 11)));
        const expenseSum = overlays.expenses.filter(e => e.date.slice(0, 10) === iso(base + 5 * DAY).slice(0, 10)).reduce((s, e) => s + e.amount, 0);
        const hoursSum = overlays.hours.filter(h => h.startTime.slice(0, 10) === iso(base + 6 * DAY).slice(0, 10)).reduce((s, h) => s + h.durationHours, 0);
        checks.push(["(f) expense summed on its UTC day", Math.abs(expenseSum - 123.45) < 0.005]);
        checks.push(["(f) hours summed on their UTC day", Math.abs(hoursSum - 3.5) < 0.005]);
        const incomeC1bOv = overlays.income.find(i => i.id === c1b.id);
        checks.push(["(f) income layer uses effectiveDueDate for QB null-date clone", incomeC1bOv?.effectiveDueDate === iso(base + 13 * DAY)]);

        const dashAdmin = await getCompanyDashboardData({ role: "ADMIN" }, "2030-01");
        const stripG = (dashAdmin.strip ?? []).find(r => r.projectId === projectG.id);
        checks.push(["(f) strip exists for ADMIN with the project row", !!stripG]);
        checks.push(["(f) Income due by effectiveDueDate (incl. projected QB clone)", Math.abs((stripG?.incomeDue ?? 0) - 150) < 0.005]);
        checks.push(["(f) Received by paymentDate not dueDate", Math.abs((stripG?.received ?? 0) - 200) < 0.005]);
        checks.push(["(f) Expenses in strip", Math.abs((stripG?.expenses ?? 0) - 123.45) < 0.005]);
        checks.push(["(f) burdened Labor = laborCost + burdenCost", Math.abs((stripG?.laborBurdened ?? 0) - 120) < 0.005]);
        checks.push(["(f) Hours actual vs estimated", Math.abs((stripG?.hoursActual ?? 0) - 3.5) < 0.005 && Math.abs((stripG?.hoursEstimated ?? 0) - 15) < 0.005]);
        checks.push(["(f) Net = Received − Expenses − burdened Labor", Math.abs((stripG?.net ?? 0) - (200 - 123.45 - 120)) < 0.005]);
        // effectiveDueDate parity: the same date drives the income layer AND the strip.
        checks.push(["(f) effectiveDueDate identical in income layer and strip",
            incomeC1bOv?.effectiveDueDate === iso(base + 13 * DAY) &&
            (dashAdmin.overlays?.income.find(i => i.id === c1b.id)?.effectiveDueDate ?? null) === incomeC1bOv?.effectiveDueDate &&
            Math.abs((stripG?.incomeDue ?? 0) - 150) < 0.005]);

        // ── (g) getCompanyDashboardData role matrix ──
        const dashManager = await getCompanyDashboardData({ role: "MANAGER" }, "2030-01");
        const dashFinance = await getCompanyDashboardData({ role: "FINANCE" }, "2030-01");
        checks.push(["(g) ADMIN gets overlays + strip + cashflow", !!dashAdmin.overlays && !!dashAdmin.strip && !!dashAdmin.cashflow]);
        checks.push(["(g) MANAGER gets NO overlays/strip/cashflow", !dashManager.overlays && !dashManager.strip && !dashManager.cashflow]);
        checks.push(["(g) MANAGER still gets picker list + conflicts", !!dashManager.teamMembers && !!dashManager.crewConflicts]);
        checks.push(["(g) FINANCE gets NO overlays/strip/cashflow/picker/conflicts",
            !dashFinance.overlays && !dashFinance.strip && !dashFinance.cashflow && !dashFinance.teamMembers && !dashFinance.crewConflicts]);

        // ── (h) rewired importer delegates to the core ──
        let importerRan = false;
        let importerErr = "";
        try {
            const createdRows = await importEstimateToSchedule(projectH.id, estimateH.id);
            importerRan = true;
            checks.push(["(h) importer returns created rows (shape preserved)", Array.isArray(createdRows)]);
        } catch (e: any) {
            importerErr = String(e?.message ?? e);
            if (importerErr.includes("static generation store")) importerRan = true; // ran; revalidate threw post-commit
        }
        if (importerRan) {
            const tasksH = await prisma.scheduleTask.findMany({ where: { projectId: projectH.id } });
            checks.push(["(h) importer created tasks via core (provenance)", tasksH.length === 1 && tasksH[0].generatedFromEstimateId === estimateH.id]);
        } else {
            // Server-action auth wall in a plain script context — fall back to a
            // static delegation proof (the rewired body routes through the core).
            const authWalled = /outside a request scope|Unauthorized/i.test(importerErr);
            const src = fs.readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
            const bodyStart = src.indexOf("export async function importEstimateToSchedule");
            const body = src.slice(bodyStart, src.indexOf("\n}\n", bodyStart));
            checks.push(["(h) importer delegates to generateScheduleFromEstimate (static proof)",
                body.includes("generateScheduleFromEstimate") && !body.includes("TYPE_COLORS")]);
            checks.push(["(h) runtime round trip blocked only by script auth wall", authWalled]);
            console.log(`(h) runtime round trip skipped — server-action auth wall (${importerErr.slice(0, 60)}…)`);
        }
    } finally {
        // Full cleanup, parent rows last (FK constraints).
        await prisma.activityLog.deleteMany({ where: { projectId: { in: allProjectIds } } });
        await prisma.paymentSchedule.deleteMany({ where: { invoiceId: invoiceG.id } });
        await prisma.invoice.delete({ where: { id: invoiceG.id } });
        await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId: { in: [estimateG.id, estimateM.id, estimateF.id, estimateF2.id, estimateH.id] } } });
        await prisma.estimateItem.deleteMany({ where: { estimateId: { in: [estimateG.id, estimateM.id, estimateF.id, estimateF2.id, estimateH.id] } } });
        await prisma.expense.delete({ where: { id: expenseG.id } });
        await prisma.timeEntry.delete({ where: { id: timeG.id } });
        await prisma.taskComment.deleteMany({ where: { task: { projectId: { in: allProjectIds } } } });
        await prisma.scheduleTask.deleteMany({ where: { projectId: { in: allProjectIds } } });
        await prisma.estimate.deleteMany({ where: { id: { in: [estimateG.id, estimateM.id, estimateF.id, estimateF2.id, estimateH.id] } } });
        await prisma.project.deleteMany({ where: { id: { in: allProjectIds } } });
        await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id, userC.id] } } });
        await prisma.client.delete({ where: { id: client.id } });
        console.log("cleanup done");
    }

    let failed = 0;
    for (const [label, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
    if (failed) throw new Error(`${failed} checks failed`);
    console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
