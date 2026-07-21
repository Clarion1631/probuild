// E2E verification for PB-pipeline-003 Phase 3 (CO -> schedule & cash).
// Creates uniquely named far-future fixtures, exercises spec cases (a)-(f),
// and cleans every fixture in finally. Run after apply-co-schedule-schema.mjs.
import fs from "node:fs";
import { prisma } from "../src/lib/prisma";
import { coSignedAmount } from "../src/lib/co-tax";
import {
    applyChangeOrderToSchedule,
    autoGenerateScheduleForApprovedEstimate,
    getCalendarOverlays,
    getCompanyDashboardData,
    getCrewConflicts,
    setProjectStartDate,
    setTaskCrew,
} from "../src/lib/schedule-core";
import { handleChangeOrderApproved } from "../src/lib/billing-core";

const DAY = 86_400_000;
const base = Date.UTC(2037, 0, 1);
const TEAM = { type: "TEAM" as const, name: "Phase 3 verifier" };
type Check = [label: string, ok: boolean, detail?: string];

async function main() {
    const checks: Check[] = [];
    const projectIds: string[] = [];
    const estimateIds: string[] = [];
    const invoiceIds: string[] = [];
    const changeOrderIds: string[] = [];
    const userIds: string[] = [];
    const clientIds: string[] = [];
    const tag = `${Date.now().toString(36)}-${process.pid}`;
    const at = (days: number) => new Date(base + days * DAY);
    const pass = (label: string, ok: boolean, detail?: unknown) =>
        checks.push([label, ok, detail == null ? undefined : String(detail)]);

    try {
        const client = await prisma.client.create({ data: { name: `P3 VERIFY ${tag} DELETE ME`, initials: "P3" } });
        clientIds.push(client.id);
        const active = await prisma.user.create({
            data: { email: `p3-active-${tag}@example.invalid`, name: "P3 Active", role: "FIELD_CREW", status: "ACTIVATED" },
        });
        const pending = await prisma.user.create({
            data: { email: `p3-pending-${tag}@example.invalid`, name: "P3 Pending", role: "FIELD_CREW", status: "PENDING" },
        });
        const disabled = await prisma.user.create({
            data: { email: `p3-disabled-${tag}@example.invalid`, name: "P3 Disabled", role: "FIELD_CREW", status: "DISABLED" },
        });
        userIds.push(active.id, pending.id, disabled.id);

        const makeProject = async (suffix: string, data: { status?: string; startDate?: Date | null; endDate?: Date | null } = {}) => {
            const project = await prisma.project.create({
                data: {
                    name: `P3 ${suffix} ${tag} DELETE ME`,
                    clientId: client.id,
                    status: data.status ?? "Waiting to Start",
                    startDate: data.startDate === undefined ? at(0) : data.startDate,
                    endDate: data.endDate ?? null,
                },
            });
            projectIds.push(project.id);
            return project;
        };
        const makeEstimate = async (
            projectId: string,
            suffix: string,
            data: { taxExempt?: boolean; taxRatePercent?: number; totalAmount?: number } = {},
        ) => {
            const totalAmount = data.totalAmount ?? 1_000;
            const estimate = await prisma.estimate.create({
                data: {
                    title: `P3 estimate ${suffix}`,
                    projectId,
                    code: `EST-P3-${tag}-${suffix}`,
                    status: "Approved",
                    totalAmount,
                    balanceDue: totalAmount,
                    taxExempt: data.taxExempt ?? true,
                    taxRatePercent: data.taxRatePercent,
                },
            });
            estimateIds.push(estimate.id);
            return estimate;
        };
        const makeInvoice = async (projectId: string, estimateId: string, suffix: string, totalAmount = 0) => {
            const invoice = await prisma.invoice.create({
                data: { code: `INV-P3-${tag}-${suffix}`, projectId, clientId: client.id, estimateId, status: "Issued", totalAmount, balanceDue: totalAmount },
            });
            invoiceIds.push(invoice.id);
            return invoice;
        };
        const makeCo = async (projectId: string, estimateId: string, suffix: string, totalAmount: number) => {
            const code = `CO-${tag.toUpperCase()}-${suffix}`;
            const co = await prisma.changeOrder.create({
                data: {
                    projectId, estimateId, code, title: `P3 change ${suffix}`, status: "Approved",
                    totalAmount, balanceDue: totalAmount, approvedBy: "Verifier", approvedAt: new Date(),
                },
            });
            changeOrderIds.push(co.id);
            return co;
        };

        // (a) Estimate approval auto-generation and automatic-path safety.
        const autoProject = await makeProject("auto");
        const autoEstimate = await makeEstimate(autoProject.id, "AUTO");
        await prisma.estimateItem.create({
            data: { estimateId: autoEstimate.id, name: "Auto labor", type: "Labor", quantity: 8, budgetUnit: "hours", total: 1_000 },
        });
        const auto = await autoGenerateScheduleForApprovedEstimate(autoEstimate.id);
        const autoTasks = await prisma.scheduleTask.findMany({ where: { projectId: autoProject.id } });
        pass("(a) approved + dated + empty project auto-generates", auto.generated && autoTasks.length === 1);

        const manualProject = await makeProject("manual");
        const manualEstimate = await makeEstimate(manualProject.id, "MANUAL");
        await prisma.estimateItem.create({ data: { estimateId: manualEstimate.id, name: "Should not generate", type: "Material", total: 100 } });
        const manualTask = await prisma.scheduleTask.create({ data: { projectId: manualProject.id, name: "Manual task", startDate: at(0), endDate: at(2) } });
        const manualAuto = await autoGenerateScheduleForApprovedEstimate(manualEstimate.id);
        const manualTasks = await prisma.scheduleTask.findMany({ where: { projectId: manualProject.id } });
        pass("(a) requireEmptyProject skips a manual schedule", !manualAuto.generated && manualTasks.length === 1 && manualTasks[0].id === manualTask.id);

        const failProject = await makeProject("autogen-failure");
        const failEstimate = await makeEstimate(failProject.id, "FAIL");
        await prisma.estimateItem.create({ data: { estimateId: failEstimate.id, name: "Rollback probe", type: "Material", total: 100 } });
        const corruptEps = await prisma.estimatePaymentSchedule.create({
            data: { estimateId: failEstimate.id, name: "Corrupt percent", percentage: 50, amount: 100, status: "Pending" },
        });
        await prisma.$executeRaw`UPDATE "EstimatePaymentSchedule" SET "percentage" = 'NaN'::double precision WHERE "id" = ${corruptEps.id}`;
        const failInvoice = await makeInvoice(failProject.id, failEstimate.id, "FAIL", 100);
        const failedAuto = await autoGenerateScheduleForApprovedEstimate(failEstimate.id);
        const [failEstimateAfter, failInvoiceAfter, failTaskCount] = await Promise.all([
            prisma.estimate.findUniqueOrThrow({ where: { id: failEstimate.id } }),
            prisma.invoice.findUniqueOrThrow({ where: { id: failInvoice.id } }),
            prisma.scheduleTask.count({ where: { projectId: failProject.id } }),
        ]);
        pass("(a) injected generator failure is surfaced", !failedAuto.generated && !!failedAuto.note);
        pass("(a) generator failure rolls back tasks", failTaskCount === 0);
        pass("(a) approval + invoice remain committed after generator failure", failEstimateAfter.status === "Approved" && failInvoiceAfter.id === failInvoice.id);

        const lateDateProject = await makeProject("late-date", { startDate: null });
        const lateDateEstimate = await makeEstimate(lateDateProject.id, "LATE-DATE");
        await prisma.estimateItem.create({ data: { estimateId: lateDateEstimate.id, name: "Late date task", type: "Material", total: 100 } });
        const beforeDate = await autoGenerateScheduleForApprovedEstimate(lateDateEstimate.id);
        const dateMove = await setProjectStartDate({ projectId: lateDateProject.id, startDate: at(5), actor: TEAM });
        const lateTasks = await prisma.scheduleTask.findMany({ where: { projectId: lateDateProject.id } });
        pass("(a) sign first with no date creates nothing", !beforeDate.generated && lateTasks.length === 1);
        pass("(a) null -> dated hook auto-generates", lateTasks.length === 1 && lateTasks[0].startDate.getTime() === at(5).getTime());
        pass("(a) late-date hook reports generation in notes", dateMove.notes.some(n => /auto-generated/i.test(n)));

        const actionsSource = fs.readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
        const approveStart = actionsSource.indexOf("export async function approveEstimate");
        const approveEnd = actionsSource.indexOf("\nexport async function deleteInvoice", approveStart);
        const approveBody = actionsSource.slice(approveStart, approveEnd);
        pass("(a) approveEstimate wires the post-commit auto-generator", approveBody.includes("autoGenerateScheduleForApprovedEstimate"));
        pass("(a) dashboard generation passes requireEmptyProject true", /generateProjectScheduleAction[\s\S]*?requireEmptyProject:\s*true/.test(actionsSource));
        const scheduleCoreSource = fs.readFileSync(new URL("../src/lib/schedule-core.ts", import.meta.url), "utf8");
        const setDateBody = scheduleCoreSource.slice(scheduleCoreSource.indexOf("export async function setProjectStartDate"), scheduleCoreSource.indexOf("export interface CashflowBucket"));
        const autoBody = scheduleCoreSource.slice(scheduleCoreSource.indexOf("export async function autoGenerateScheduleForApprovedEstimate"), scheduleCoreSource.indexOf("export class CoSchedulePreconditionError"));
        const importerBody = actionsSource.slice(actionsSource.indexOf("export async function importEstimateToSchedule"), actionsSource.indexOf("export async function generateProjectScheduleAction"));
        pass("(a) every automatic caller requires an empty project", setDateBody.includes("requireEmptyProject: true") && autoBody.includes("requireEmptyProject: true"));
        pass("(a) explicit importer preserves merge semantics", !importerBody.includes("requireEmptyProject"));
        pass("(a) approveEstimate hook runs after invoice/budget work and is caught", approveBody.indexOf("autoGenerateScheduleForApprovedEstimate") > approveBody.indexOf("prisma.budget.create") && /try\s*\{[\s\S]*autoGenerateScheduleForApprovedEstimate[\s\S]*\}\s*catch/.test(approveBody));

        // (b) Approved CO application, exact placement, deductions, links,
        // billed/unbilled overlay behavior, idempotency, and safe regenerate.
        const coProject = await makeProject("co-main", { status: "In Progress", startDate: at(10), endDate: at(20) });
        const coEstimate = await makeEstimate(coProject.id, "CO-MAIN", { taxExempt: true, totalAmount: 10_000 });
        await prisma.estimateItem.create({
            data: { estimateId: coEstimate.id, name: "Original labor", type: "Labor", quantity: 80, budgetUnit: "hours", total: 1_000 },
        });
        await prisma.scheduleTask.create({
            data: { projectId: coProject.id, name: "Existing work", startDate: at(18), endDate: at(22), type: "task" },
        });
        await prisma.scheduleTask.create({
            data: { projectId: coProject.id, name: "Trailing milestone ignored", startDate: at(100), endDate: at(101), type: "milestone" },
        });
        const co = await makeCo(coProject.id, coEstimate.id, "MAIN", 1_000);
        await prisma.changeOrderItem.createMany({ data: [
            { changeOrderId: co.id, name: "Added framing", type: "Labor", total: 500, order: 0 },
            { changeOrderId: co.id, name: "Added material", type: "Material", total: 200, order: 1 },
            { changeOrderId: co.id, name: "Removed labor", type: "Labor", total: -400, order: 2 },
        ] });
        const firstCoPay = await prisma.changeOrderPaymentSchedule.create({
            data: { changeOrderId: co.id, name: "CO deposit", amount: 250, dueDate: at(30), order: 0 },
        });
        const secondCoPay = await prisma.changeOrderPaymentSchedule.create({
            data: { changeOrderId: co.id, name: "CO balance", amount: 750, order: 1 },
        });

        const applied = await applyChangeOrderToSchedule({ changeOrderId: co.id, actor: TEAM });
        const appliedTasks = await prisma.scheduleTask.findMany({
            where: { generatedFromChangeOrderId: co.id }, orderBy: [{ order: "asc" }, { id: "asc" }],
        });
        const parent = appliedTasks.find(t => t.parentId === null && t.type !== "milestone");
        const children = appliedTasks.filter(t => t.parentId === parent?.id);
        const milestones = appliedTasks.filter(t => t.type === "milestone");
        const linkedRows = await prisma.changeOrderPaymentSchedule.findMany({
            where: { changeOrderId: co.id }, orderBy: [{ order: "asc" }, { id: "asc" }],
        });
        pass("(b) CO block starts at max(project end, non-milestone end)", parent?.startDate.getTime() === at(22).getTime());
        pass("(b) labor-calibrated parent window is five days", parent?.endDate.getTime() === at(27).getTime());
        pass("(b) non-negative CO items are children of the CO parent", children.length === 2);
        pass("(b) deduction creates no task and leaves a note", !appliedTasks.some(t => t.name === "Removed labor") && applied.notes.some(n => /deduction/i.test(n)));
        pass("(b) explicit and derived payment rows link without due-date mutation",
            milestones.length === 2 && linkedRows.every(r => !!r.scheduleTaskId) &&
            linkedRows.find(r => r.id === firstCoPay.id)?.dueDate?.getTime() === at(30).getTime() &&
            linkedRows.find(r => r.id === secondCoPay.id)?.dueDate === null);
        const firstMilestone = milestones.find(task => task.id === linkedRows.find(row => row.id === firstCoPay.id)?.scheduleTaskId);
        const secondMilestone = milestones.find(task => task.id === linkedRows.find(row => row.id === secondCoPay.id)?.scheduleTaskId);
        pass("(c) dueDate wins for the explicit CO milestone", firstMilestone?.startDate.getTime() === at(30).getTime());
        pass("(c) null dueDate derives from cumulative amount share", secondMilestone?.startDate.getTime() === at(27).getTime());

        const beforeBillOverlay = await getCalendarOverlays(at(0), at(60));
        const beforeBillRows = beforeBillOverlay.changeOrders.filter(r => r.changeOrderId === co.id);
        pass("(b) unbilled CO projects its payment schedule exactly once", beforeBillRows.length === 2 && beforeBillRows.reduce((s, r) => s + r.amount, 0) === 1_000);

        // Seed stale non-null links; merge must converge them rather than only
        // filling NULL links (scheduleTaskId is the only money-row field touched).
        await prisma.changeOrderPaymentSchedule.update({ where: { id: secondCoPay.id }, data: { scheduleTaskId: parent!.id } });
        const coInvoice = await makeInvoice(coProject.id, coEstimate.id, "CO-MAIN", 1_000);
        const billedClone = await prisma.paymentSchedule.create({
            data: { invoiceId: coInvoice.id, name: `${co.code} — ${co.title}`, amount: 1_000, status: "Pending", scheduleTaskId: parent!.id },
        });
        const mergeAgain = await applyChangeOrderToSchedule({ changeOrderId: co.id, actor: TEAM });
        const [afterMergeCount, cloneAfterMerge, afterBillOverlay] = await Promise.all([
            prisma.scheduleTask.count({ where: { generatedFromChangeOrderId: co.id } }),
            prisma.paymentSchedule.findUniqueOrThrow({ where: { id: billedClone.id } }),
            getCalendarOverlays(at(0), at(60)),
        ]);
        pass("(b) merge is idempotent", afterMergeCount === appliedTasks.length && mergeAgain.created.length === 0);
        pass("(b) billed clone converges to the first CO milestone", cloneAfterMerge.scheduleTaskId === linkedRows[0].scheduleTaskId);
        const correctedSecondRow = await prisma.changeOrderPaymentSchedule.findUniqueOrThrow({ where: { id: secondCoPay.id } });
        pass("(b) merge corrects a stale non-null CO-row link", correctedSecondRow.scheduleTaskId === linkedRows[1].scheduleTaskId);
        pass("(b) billed CO is absent from projected overlay", afterBillOverlay.changeOrders.every(r => r.changeOrderId !== co.id));
        const billedIncomeRows = afterBillOverlay.income.filter(row => row.id === billedClone.id);
        pass("(d) billed CO appears in ordinary income exactly once at the same amount", billedIncomeRows.length === 1 && billedIncomeRows[0].amount === 1_000);

        const protectedChild = children[0];
        await prisma.taskComment.create({ data: { taskId: protectedChild.id, userId: active.id, text: "Protect this generated subtree" } });
        const oldMilestoneIds = new Set(milestones.map(t => t.id));
        await applyChangeOrderToSchedule({ changeOrderId: co.id, mode: "regenerate", actor: TEAM });
        const regenerated = await prisma.scheduleTask.findMany({ where: { generatedFromChangeOrderId: co.id } });
        const regeneratedRows = await prisma.changeOrderPaymentSchedule.findMany({ where: { changeOrderId: co.id } });
        const regeneratedClone = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: billedClone.id } });
        pass("(b) regenerate preserves a protected CO subtree", regenerated.some(t => t.id === parent?.id) && regenerated.some(t => t.id === protectedChild.id));
        pass("(b) regenerate rebuilds eligible milestone roots", regenerated.filter(t => t.type === "milestone").length === 2 && regenerated.some(t => t.type === "milestone" && !oldMilestoneIds.has(t.id)));
        pass("(b) regenerate relinks CO rows and billed clone", regeneratedRows.every(r => !!r.scheduleTaskId) && !!regeneratedClone.scheduleTaskId);

        // (c) Zero-payment-row fallback uses the tax-inclusive billing amount.
        // Reuse the main CO code on another project to prove billed detection is
        // keyed by (projectId, code), never code alone.
        const zeroProject = await makeProject("co-zero", { status: "In Progress", startDate: at(40), endDate: null });
        const zeroEstimate = await makeEstimate(zeroProject.id, "CO-ZERO", { taxExempt: false, taxRatePercent: 10, totalAmount: 5_000 });
        await prisma.estimateItem.create({ data: { estimateId: zeroEstimate.id, name: "Original material", type: "Material", total: 500 } });
        const zeroCo = await makeCo(zeroProject.id, zeroEstimate.id, "ZERO", 100);
        await prisma.changeOrder.update({ where: { id: zeroCo.id }, data: { code: co.code } });
        await prisma.changeOrderItem.create({ data: { changeOrderId: zeroCo.id, name: "Small addition", type: "Material", total: 100, order: 0 } });
        const zeroApply = await applyChangeOrderToSchedule({ changeOrderId: zeroCo.id, actor: TEAM });
        const zeroTasks = await prisma.scheduleTask.findMany({ where: { generatedFromChangeOrderId: zeroCo.id } });
        const zeroParent = zeroTasks.find(t => t.type !== "milestone" && t.parentId === null);
        const zeroMilestone = zeroTasks.find(t => t.type === "milestone");
        const signedZero = coSignedAmount(100, { taxExempt: false, taxRatePercent: 10, taxRateName: null });
        pass("(c) zero-row CO gets one synthesized milestone at block end", !!zeroParent && zeroMilestone?.startDate.getTime() === zeroParent.endDate.getTime());
        pass("(c) empty-project effectiveWorkEnd falls back exactly to startDate", zeroParent?.startDate.getTime() === at(40).getTime());
        pass("(c) synthesized milestone reports the tax-inclusive signed amount", signedZero === 110 && zeroApply.notes.some(n => n.includes("$110.00")));
        const zeroProjected = (await getCalendarOverlays(at(0), at(80))).changeOrders.filter(r => r.changeOrderId === zeroCo.id);
        pass("(c) same CO code on another project is still projected", zeroProjected.length === 1 && zeroProjected[0].amount === 110);

        const zeroInvoice = await makeInvoice(zeroProject.id, zeroEstimate.id, "CO-ZERO", 110);
        const zeroClone = await prisma.paymentSchedule.create({
            data: { invoiceId: zeroInvoice.id, name: `${co.code} — ${zeroCo.title}`, amount: 110, status: "Pending" },
        });
        await applyChangeOrderToSchedule({ changeOrderId: zeroCo.id, actor: TEAM });
        const zeroCloneAfter = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: zeroClone.id } });
        const zeroAfterBill = (await getCalendarOverlays(at(0), at(80))).changeOrders.filter(r => r.changeOrderId === zeroCo.id);
        const zeroIncomeAfterBill = (await getCalendarOverlays(at(0), at(80))).income.filter(r => r.id === zeroClone.id);
        pass("(c) zero-row billed clone links to synthesized milestone", zeroCloneAfter.scheduleTaskId === zeroMilestone?.id);
        pass("(c) zero-row billed CO is not double-counted", zeroAfterBill.length === 0);
        pass("(d) taxable zero-row amount is identical before and after billing", zeroProjected[0]?.amount === 110 && zeroIncomeAfterBill.length === 1 && zeroIncomeAfterBill[0].amount === zeroProjected[0].amount);
        pass("(c) schedule linking never writes a billing due date", zeroCloneAfter.dueDate === null);

        // (d) Task-level crew replacement and role-safe dashboard enrichment.
        const crewTask = children[1];
        const firstCrew = await setTaskCrew({ taskId: crewTask.id, userIds: [active.id], actor: TEAM });
        const secondCrew = await setTaskCrew({ taskId: crewTask.id, userIds: [active.id, active.id], actor: TEAM });
        let pendingRejected = false;
        try {
            await setTaskCrew({ taskId: crewTask.id, userIds: [pending.id], actor: TEAM });
        } catch (error) {
            pendingRejected = /ACTIVATED/.test(String(error));
        }
        pass("(d) task crew replacement is idempotent", firstCrew.assignments.length === 1 && secondCrew.assignments.length === 1);
        pass("(d) pending users cannot be assigned", pendingRejected);
        await prisma.taskAssignment.create({ data: { taskId: crewTask.id, userId: disabled.id, role: "assigned" } });

        const unappliedProject = await makeProject("unapplied", { status: "In Progress", startDate: at(50), endDate: at(53) });
        const unappliedEstimate = await makeEstimate(unappliedProject.id, "UNAPPLIED");
        const unappliedCo = await makeCo(unappliedProject.id, unappliedEstimate.id, "UNAPPLIED", 50);
        const financeDashboard = await getCompanyDashboardData({ role: "FINANCE" }, "2037-03");
        const financeProjects = [
            ...financeDashboard.pipeline.waitingToStart,
            ...financeDashboard.pipeline.scheduled,
            ...financeDashboard.pipeline.inProgress,
        ];
        const financeCoProject = financeProjects.find(p => p.id === coProject.id);
        const financeUnapplied = financeProjects.find(p => p.id === unappliedProject.id);
        const financeAssignment = financeCoProject?.tasks.flatMap(t => t.assignments).find(a => a.userId === disabled.id);
        pass("(d) FINANCE can read expanded tasks and inactive assignment status", financeAssignment?.status === "DISABLED");
        pass("(d) FINANCE receives no edit list or money overlays", financeDashboard.teamMembers === null && financeDashboard.overlays === null && financeDashboard.strip === null);
        pass("(d) dashboard exposes Approved COs with no provenance tasks", financeUnapplied?.unappliedChangeOrders.items.some(c => c.id === unappliedCo.id) === true);
        const unappliedPayloadKeys = financeUnapplied?.unappliedChangeOrders.items.flatMap(item => Object.keys(item)) ?? [];
        pass("(d) unapplied CO dashboard payload contains no money", unappliedPayloadKeys.every(key => key === "id" || key === "code"));
        await setTaskCrew({ taskId: crewTask.id, userIds: [active.id], actor: TEAM });
        const removedDisabled = await prisma.taskAssignment.count({ where: { taskId: crewTask.id, userId: disabled.id } });
        pass("(d) inactive legacy assignment remains removable", removedDisabled === 0);

        // (e) Task-window conflicts, per-(user, project) fallback, and the
        // shared max(endDate, latest work-task end) effective work end.
        const conflictA = await makeProject("conflict-a", { status: "In Progress", startDate: at(60), endDate: at(62) });
        const conflictB = await makeProject("conflict-b", { status: "In Progress", startDate: at(60), endDate: at(62) });
        const conflictC = await makeProject("conflict-c", { status: "In Progress", startDate: at(63), endDate: at(64) });
        await prisma.project.update({ where: { id: conflictB.id }, data: { crew: { connect: { id: active.id } } } });
        const taskA1 = await prisma.scheduleTask.create({ data: { projectId: conflictA.id, name: "A assigned", startDate: at(64), endDate: at(66) } });
        const taskA2 = await prisma.scheduleTask.create({ data: { projectId: conflictA.id, name: "A same project", startDate: at(64), endDate: at(67) } });
        const taskB = await prisma.scheduleTask.create({ data: { projectId: conflictB.id, name: "B extends effective end", startDate: at(62), endDate: at(65) } });
        const taskC = await prisma.scheduleTask.create({ data: { projectId: conflictC.id, name: "C assigned", startDate: at(65), endDate: at(68) } });
        await prisma.taskAssignment.createMany({ data: [
            { taskId: taskA1.id, userId: active.id, role: "assigned" },
            { taskId: taskA2.id, userId: active.id, role: "assigned" },
            { taskId: taskC.id, userId: active.id, role: "assigned" },
        ] });
        const conflicts = await getCrewConflicts(at(59), at(70));
        const activeConflicts = conflicts.find(c => c.userId === active.id)?.pairs ?? [];
        const hasPair = (a: string, b: string) => activeConflicts.some(p => new Set([p.projectA.id, p.projectB.id]).has(a) && new Set([p.projectA.id, p.projectB.id]).has(b));
        const taskPair = activeConflicts.find(p => new Set([p.projectA.id, p.projectB.id]).has(conflictA.id) && new Set([p.projectA.id, p.projectB.id]).has(conflictC.id));
        pass("(e) overlapping assigned tasks on different projects conflict", !!taskPair?.taskA && !!taskPair?.taskB);
        pass("(e) assigned-task vs fallback project window conflict is detected", hasPair(conflictA.id, conflictB.id));
        pass("(e) fallback effective end uses max(project end, work-task end)", activeConflicts.some(p => new Set([p.projectA.id, p.projectB.id]).has(conflictB.id) && p.overlapEnd === at(65).toISOString()));
        pass("(e) same-project task overlaps are ignored", activeConflicts.every(p => p.projectA.id !== p.projectB.id));

        // (f) Fresh-approval billing hook: schedule preconditions are quiet;
        // real failures are surfaced without unwinding billing.
        const hookProject = await makeProject("hook-no-date", { startDate: null });
        const hookEstimate = await makeEstimate(hookProject.id, "HOOK-NO-DATE");
        const hookCo = await makeCo(hookProject.id, hookEstimate.id, "HOOK-NO-DATE", 75);
        const hookInvoice = await makeInvoice(hookProject.id, hookEstimate.id, "HOOK-NO-DATE", 75);
        await prisma.paymentSchedule.create({
            data: { invoiceId: hookInvoice.id, name: `${hookCo.code} — ${hookCo.title}`, amount: 75, status: "Pending" },
        });
        const quietHook = await handleChangeOrderApproved(hookCo.id, { notify: false, freshlyApproved: true });
        const hookTaskCount = await prisma.scheduleTask.count({ where: { generatedFromChangeOrderId: hookCo.id } });
        pass("(f) fresh approval with no project date leaves billing committed", hookTaskCount === 0 && quietHook.issues.every(i => !/schedule/i.test(i)));

        const brokenProject = await makeProject("hook-failure", { startDate: at(80), endDate: at(81) });
        const brokenEstimate = await makeEstimate(brokenProject.id, "HOOK-FAIL");
        const brokenCo = await makeCo(brokenProject.id, brokenEstimate.id, "HOOK-FAIL", 90);
        const brokenInvoice = await makeInvoice(brokenProject.id, brokenEstimate.id, "HOOK-FAIL", 90);
        const brokenClone = await prisma.paymentSchedule.create({
            data: { invoiceId: brokenInvoice.id, name: `${brokenCo.code} — ${brokenCo.title}`, amount: 90, status: "Pending" },
        });
        await prisma.$executeRaw`UPDATE "Project" SET "endDate" = 'infinity'::timestamp WHERE "id" = ${brokenProject.id}`;
        const brokenHook = await handleChangeOrderApproved(brokenCo.id, { notify: false, freshlyApproved: true });
        await prisma.$executeRaw`UPDATE "Project" SET "endDate" = NULL WHERE "id" = ${brokenProject.id}`;
        const brokenCloneAfter = await prisma.paymentSchedule.findUnique({ where: { id: brokenClone.id } });
        pass("(f) real schedule-hook failure is reported", brokenHook.issues.some(i => /schedule/i.test(i)));
        pass("(f) real schedule-hook failure does not unwind billing", brokenCloneAfter?.id === brokenClone.id);

        // Static integration checks cover auth boundaries and UI/MCP wiring that
        // is intentionally not invoked by this database fixture.
        const scheduleSource = fs.readFileSync(new URL("../src/lib/schedule-core.ts", import.meta.url), "utf8");
        const billingSource = fs.readFileSync(new URL("../src/lib/billing-core.ts", import.meta.url), "utf8");
        const mcpSource = fs.readFileSync(new URL("../src/app/api/mcp/[transport]/route.ts", import.meta.url), "utf8");
        const dashboardSource = fs.readFileSync(new URL("../src/app/company-dashboard/CompanyDashboardClient.tsx", import.meta.url), "utf8");
        const coApplyStart = scheduleSource.indexOf("export async function applyChangeOrderToSchedule");
        const coApplyEnd = scheduleSource.indexOf("export async function setTaskCrew", coApplyStart);
        const coApplyBody = scheduleSource.slice(coApplyStart, coApplyEnd);
        const forbiddenMoneyRowWrite = /SET\s+"?(?:dueDate|amount|status|qbInvoiceId)"?|(?:changeOrderPaymentSchedule|paymentSchedule)\.update(?:Many)?\s*\(/i;
        pass("(f) CO application contains no due-date or money mutation", !forbiddenMoneyRowWrite.test(coApplyBody));
        pass("(f) approveChangeOrder marks only a fresh transition for scheduling", /handleChangeOrderApproved\(id,\s*\{\s*freshlyApproved:\s*true/.test(actionsSource));
        pass("(f) billing hook catches schedule preconditions separately", billingSource.includes("CoSchedulePreconditionError") && billingSource.includes("freshlyApproved"));
        const applyActionBody = actionsSource.slice(actionsSource.indexOf("export async function applyChangeOrderToScheduleAction"), actionsSource.indexOf("export async function updateTaskCrewAction"));
        const taskCrewActionBody = actionsSource.slice(actionsSource.indexOf("export async function updateTaskCrewAction"), actionsSource.indexOf("export async function updateProjectColor"));
        pass("(f) protected dashboard actions enforce company edit roles", applyActionBody.includes('["ADMIN", "MANAGER"]') && taskCrewActionBody.includes('["ADMIN", "MANAGER"]'));
        pass("(f) MCP exposes apply_change_order_to_schedule", mcpSource.includes('"apply_change_order_to_schedule"') && mcpSource.includes("applyChangeOrderToSchedule"));
        const mcpGeneratorBody = mcpSource.slice(mcpSource.indexOf('"generate_project_schedule"'), mcpSource.indexOf('"assign_project_crew"'));
        pass("(f) MCP generator preserves explicit merge semantics", !mcpGeneratorBody.includes("requireEmptyProject"));
        pass("(f) MCP schedule read exposes unapplied CO details", mcpSource.includes("unappliedChangeOrders"));
        pass("(f) MCP advertises contract version 1.9.0", mcpSource.includes('version: "1.9.0"'));
        pass("(f) MCP instructions explain automatic and explicit CO application", mcpSource.includes("change orders adjust the schedule") && mcpSource.includes("deductions never auto-remove tasks"));
        pass("(f) dashboard includes expandable task rows and task crew action", dashboardSource.includes("aria-expanded") && dashboardSource.includes("updateTaskCrewAction"));
        pass("(f) dashboard includes Apply CO control", dashboardSource.includes("applyChangeOrderToScheduleAction") && dashboardSource.includes("Apply CO"));
        pass("(f) hover controls are keyboard/touch accessible", dashboardSource.includes("focus:opacity-100") && dashboardSource.includes("[@media(hover:none)]:opacity-100") && dashboardSource.includes("pointer-events-none") && dashboardSource.includes("focus:pointer-events-auto"));
        pass("(f) ADMIN views distinguish projected CO money", dashboardSource.includes("coProjected") && dashboardSource.includes("Projected CO"));
        pass("(f) shared effective-work-end rule is used by CO placement and conflicts", (scheduleSource.match(/effectiveWorkEnd/g)?.length ?? 0) >= 3 && scheduleSource.includes("computeEffectiveWorkEnd"));
    } finally {
        if (invoiceIds.length) await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
        if (changeOrderIds.length) await prisma.changeOrder.deleteMany({ where: { id: { in: changeOrderIds } } });
        if (estimateIds.length) await prisma.estimate.deleteMany({ where: { id: { in: estimateIds } } });
        if (projectIds.length) await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        if (clientIds.length) await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
        console.log(`CLEANUP: removed ${projectIds.length} projects, ${estimateIds.length} estimates, ${changeOrderIds.length} COs, ${invoiceIds.length} invoices, ${userIds.length} users, ${clientIds.length} clients`);
    }

    const failed = checks.filter(([, ok]) => !ok);
    for (const [label, ok, detail] of checks) {
        console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
    }
    console.log(`SUMMARY: ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
        throw new Error(`${failed.length} Phase 3 verification check(s) failed: ${failed.map(([label]) => label).join("; ")}`);
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
