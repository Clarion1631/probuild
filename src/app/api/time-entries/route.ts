export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { toCompanyDayKey } from "@/lib/company-day";
import { requiresPhaseForClockIn } from "@/lib/logistics-time-entry";

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get('projectId');

    const whereClause: any = {};
    if (user.role !== 'MANAGER' && user.role !== 'ADMIN') {
        whereClause.userId = user.id;
    }
    if (projectId) {
        whereClause.projectId = projectId;
    }

    const timeEntries = await prisma.timeEntry.findMany({
        where: whereClause,
        include: {
            user: true,
            // Explicit select — a full Project row would serialize
            // chatWebhookUrl (a credential) to field crew.
            project: {
                select: {
                    id: true, name: true, status: true, location: true,
                    locationLat: true, locationLng: true, geofenceRadiusMeters: true,
                    color: true, code: true, clientId: true,
                },
            },
            costCode: true
        },
        orderBy: {
            createdAt: 'desc'
        }
    });

    return NextResponse.json(JSON.parse(JSON.stringify(timeEntries)));
}

export async function POST(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const body = await req.json();
    const {
        projectId, costCodeId, estimateItemId, startTime, latitude, longitude,
        // Suggestion audit (newer clients only — older app versions omit all of these)
        suggestedScheduleTaskId, suggestedCostCodeId, suggestionSource, suggestionOverridden,
    } = body;

    if (!projectId) {
        return NextResponse.json({ error: "Project ID is required" }, { status: 400 });
    }

    const fail = await assertProjectAccess(user, projectId);
    if (fail) return fail;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { isLogistics: true },
    });

    // Cost attribution: the estimate item is what actually gets charged, so it
    // must belong to this project (on an eligible estimate) and its cost code
    // wins over whatever the client sent. Mobile historically sent
    // costCodeId: null, which is exactly how wrong/missing cost codes happened.
    let resolvedEstimateItemId: string | null = null;
    let resolvedCostCodeId: string | null = null;
    if (estimateItemId) {
        const item = await prisma.estimateItem.findFirst({
            where: {
                id: estimateItemId,
                estimate: {
                    projectId,
                    status: { in: ["Approved", "Invoiced", "Partially Paid", "Paid"] },
                    archivedAt: null,
                },
            },
            select: { id: true, costCodeId: true },
        });
        if (!item) {
            return NextResponse.json({ error: "Estimate item does not belong to an eligible estimate on this project" }, { status: 400 });
        }
        resolvedEstimateItemId = item.id;
        // The item alone decides the charge — a client-sent costCodeId must not
        // fill in for a codeless item, or crew can charge any code they like.
        resolvedCostCodeId = item.costCodeId ?? null;
    } else if (costCodeId && typeof costCodeId === "string") {
        // True legacy path (no estimate item): keep the client's code, but only
        // if it actually exists.
        const code = await prisma.costCode.findUnique({ where: { id: costCodeId }, select: { id: true } });
        resolvedCostCodeId = code?.id ?? null;
    }

    // A phase (cost code or estimate item) is required to clock in on a normal
    // project — a logistics job (shop, travel, admin time) has no estimate to
    // attach to, so it's the deliberate exception.
    if (
        requiresPhaseForClockIn({
            isLogistics: project?.isLogistics ?? false,
            hasCostCode: !!resolvedCostCodeId,
            hasEstimateItem: !!resolvedEstimateItemId,
        })
    ) {
        return NextResponse.json(
            { error: "A phase or cost code is required to clock in on this project", code: "PHASE_REQUIRED" },
            { status: 400 }
        );
    }

    // Suggestion audit fields: trust nothing about the suggested task without
    // re-checking it lives on this project (it feeds manager review, not cost).
    let auditSuggestedTaskId: string | null = null;
    let auditSuggestedTaskName: string | null = null;
    if (suggestedScheduleTaskId && typeof suggestedScheduleTaskId === "string") {
        const suggestedTask = await prisma.scheduleTask.findFirst({
            where: { id: suggestedScheduleTaskId, projectId },
            select: { id: true, name: true },
        });
        if (suggestedTask) {
            auditSuggestedTaskId = suggestedTask.id;
            auditSuggestedTaskName = suggestedTask.name;
        }
    }
    const validSources = ["daily_log", "today_schedule", "user_history"];

    const entryStartTime = startTime ? new Date(startTime) : new Date();
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: user.id,
        projectId,
        dayKey: toCompanyDayKey(entryStartTime),
        estimateItemId: resolvedEstimateItemId,
    });

    const timeEntry = await prisma.timeEntry.create({
        data: {
            userId: user.id,
            projectId,
            costCodeId: resolvedCostCodeId,
            estimateItemId: resolvedEstimateItemId,
            startTime: entryStartTime,
            latitude,
            longitude,
            scheduleTaskId,
            suggestedScheduleTaskId: auditSuggestedTaskId,
            suggestedTaskName: auditSuggestedTaskName,
            suggestedCostCodeId: typeof suggestedCostCodeId === "string" ? suggestedCostCodeId : null,
            suggestionSource: validSources.includes(suggestionSource) ? suggestionSource : null,
            suggestionOverridden: suggestionOverridden === true,
        }
    });

    return NextResponse.json(timeEntry);
}

export async function PUT(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const body = await req.json();
    const { id, endTime, latitude, longitude } = body;

    if (!id) return NextResponse.json({ error: "Time Entry ID is required" }, { status: 400 });

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Time Entry not found" }, { status: 404 });

    if (existing.userId !== user.id && user.role !== 'MANAGER' && user.role !== 'ADMIN') {
        return NextResponse.json({ error: "Unauthorized to edit this entry" }, { status: 403 });
    }

    const end = endTime ? new Date(endTime) : new Date();
    const durationMs = end.getTime() - existing.startTime.getTime();
    let durationHours = durationMs / (1000 * 60 * 60);
    if (durationHours < 0) durationHours = 0;

    // Cost is always calculated from the time-entry OWNER's rates, not the editing user's
    // (a manager editing a field crew's punch must not stamp manager rates onto the entry).
    const owner = existing.userId === user.id
        ? user
        : await prisma.user.findUnique({ where: { id: existing.userId } });
    if (!owner) return NextResponse.json({ error: "Owner not found" }, { status: 404 });
    const laborCost = durationHours * toNum(owner.hourlyRate);
    const burdenCost = durationHours * toNum(owner.burdenRate);

    const updateData: any = {
        endTime: end,
        durationHours,
        laborCost,
        burdenCost,
    };

    if (latitude) updateData.latitude = latitude;
    if (longitude) updateData.longitude = longitude;

    if (user.role === 'MANAGER' || user.role === 'ADMIN') {
        if (existing.userId !== user.id) {
            updateData.editedByManagerId = user.id;
            updateData.editedAt = new Date();
        }
    }

    const timeEntry = await prisma.timeEntry.update({
        where: { id },
        data: updateData
    });

    return NextResponse.json(JSON.parse(JSON.stringify(timeEntry)));
}
