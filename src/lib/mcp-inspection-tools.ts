import type { Prisma } from "@prisma/client";

import type { McpActorContext } from "./mcp-actor";
import { assertInspectionLinksBelongToProject, inspectionResult, parseInspectionDate, type InspectionResult } from "./inspection-core";
import { executeConfirmed, issueConfirmation } from "./mcp-schedule-tools";
import { prisma } from "./prisma";

type RecordInspectionInput = {
    projectId: string;
    type: string;
    result: InspectionResult;
    date: string;
    notes?: string;
    customerNote?: string;
    sharedToPortal?: boolean;
    permitId?: string;
    scheduleTaskId?: string;
    confirmToken?: string;
};

function dateOnly(value: string): Date {
    const date = parseInspectionDate(value, "date");
    if (!date) throw new Error("date is required");
    return date;
}

function cleanOptional(value: string | undefined): string | null {
    return value?.trim() || null;
}

function preview(input: Omit<RecordInspectionInput, "confirmToken">): string {
    const visibility = input.sharedToPortal ?? input.result === "PASSED";
    const timing = input.result === "SCHEDULED" ? `scheduled for ${input.date}` : `performed ${input.date}`;
    const field = (label: string, value: string | undefined) => `${label}: ${value ? JSON.stringify(value) : "(none)"}`;
    return [
        `Record ${input.result.toLowerCase()} inspection: ${input.type.trim()} on ${timing}.`,
        `Client portal: ${visibility ? "shared" : "private"}.`,
        field("Customer note", input.customerNote),
        field("Internal notes", input.notes),
        field("Permit", input.permitId),
        field("Schedule task", input.scheduleTaskId),
    ].join(" ");
}

function canonicalInput(input: RecordInspectionInput): Omit<RecordInspectionInput, "confirmToken"> {
    const type = input.type.trim();
    if (!type) throw new Error("type is required");
    const result = inspectionResult(input.result);
    dateOnly(input.date);
    return {
        projectId: input.projectId,
        type,
        result,
        date: input.date,
        notes: cleanOptional(input.notes) ?? undefined,
        customerNote: cleanOptional(input.customerNote) ?? undefined,
        sharedToPortal: input.sharedToPortal,
        permitId: cleanOptional(input.permitId) ?? undefined,
        scheduleTaskId: cleanOptional(input.scheduleTaskId) ?? undefined,
    };
}

export async function listInspections(input: { projectId: string; limit?: number }) {
    const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, name: true } });
    if (!project) throw new Error("Project not found");
    const inspections = await prisma.inspection.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: "desc" }],
        take: input.limit ?? 100,
        select: {
            id: true, type: true, result: true, scheduledDate: true, performedDate: true,
            inspector: true, notes: true, customerNote: true, sharedToPortal: true,
            permitId: true, scheduleTaskId: true, createdAt: true,
        },
    });
    return { project: { id: project.id, name: project.name }, inspections };
}

export async function recordInspectionWithConfirmation(input: RecordInspectionInput, actor: McpActorContext) {
    const args = canonicalInput(input);
    if (!input.confirmToken) {
        return issueConfirmation("record_inspection", args, preview(args), actor.actorLabel,);
    }
    const actorUserId = actor.actorUserId;
    if (!actorUserId) throw new Error("MCP actor is not linked to a ProBuild user; cannot record inspection provenance");

    return executeConfirmed("record_inspection", args, input.confirmToken, async (tx: Prisma.TransactionClient) => {
        const project = await tx.project.findUnique({ where: { id: args.projectId }, select: { id: true, name: true } });
        if (!project) throw new Error("Project not found");
        await assertInspectionLinksBelongToProject(tx, project.id, args.permitId ?? null, args.scheduleTaskId ?? null);
        const date = dateOnly(args.date);
        const inspection = await tx.inspection.create({
            data: {
                projectId: project.id,
                type: args.type,
                result: args.result,
                scheduledDate: args.result === "SCHEDULED" ? date : null,
                performedDate: args.result === "SCHEDULED" ? null : date,
                notes: args.notes ?? null,
                customerNote: args.customerNote ?? null,
                sharedToPortal: args.sharedToPortal ?? args.result === "PASSED",
                permitId: args.permitId ?? null,
                scheduleTaskId: args.scheduleTaskId ?? null,
                createdById: actorUserId,
            },
            select: {
                id: true, type: true, result: true, scheduledDate: true,
                performedDate: true, sharedToPortal: true,
            },
        });
        return { project: { id: project.id, name: project.name }, inspection };
    }, actor.actorLabel, "inspection");
}
