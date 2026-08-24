export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { resolveCostCode } from "@/lib/cost-code-resolver";
import { computeLaborCost } from "@/lib/labor-cost";
import { notifyReview } from "@/lib/notify";

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get('projectId');

    let whereClause: any = {};
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
            project: true,
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
    const { projectId, costCodeId, estimateItemId, startTime, latitude, longitude } = body;

    if (!projectId) {
        return NextResponse.json({ error: "Project ID is required" }, { status: 400 });
    }

    const fail = await assertProjectAccess(user, projectId);
    if (fail) return fail;

    // If a line item was chosen it must belong to THIS project's estimate — otherwise the
    // entry would be coded against another job's line item.
    if (estimateItemId) {
        const item = await prisma.estimateItem.findFirst({
            where: { id: estimateItemId, estimate: { projectId } },
            select: { id: true },
        });
        if (!item) {
            return NextResponse.json(
                { error: "That line item doesn't belong to this project." },
                { status: 400 }
            );
        }
    }

    // Job-costing gate: no uncoded labour. Require an active cost code, derived from the
    // chosen estimate line item when not supplied directly. Reject the clock-in otherwise
    // so labour can never land on a job with no cost attribution.
    const coded = await resolveCostCode({ costCodeId, lineItemId: estimateItemId });
    if (!coded.ok) return NextResponse.json({ error: coded.error }, { status: coded.status });

    const timeEntry = await prisma.timeEntry.create({
        data: {
            userId: user.id,
            projectId,
            costCodeId: coded.costCodeId,
            costTypeId: coded.costTypeId,
            estimateItemId: estimateItemId || null,
            startTime: startTime ? new Date(startTime) : new Date(),
            latitude,
            longitude,
        }
    });

    return NextResponse.json(timeEntry);
}

export async function PUT(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const body = await req.json();
    const { id, endTime, latitude, longitude, mealSkipped } = body;

    if (!id) return NextResponse.json({ error: "Time Entry ID is required" }, { status: 400 });

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Time Entry not found" }, { status: 404 });

    if (existing.userId !== user.id && user.role !== 'MANAGER' && user.role !== 'ADMIN') {
        return NextResponse.json({ error: "Unauthorized to edit this entry" }, { status: 403 });
    }

    const end = endTime ? new Date(endTime) : new Date();
    if (Number.isNaN(end.getTime())) {
        return NextResponse.json({ error: "Invalid endTime" }, { status: 400 });
    }
    if (end.getTime() < existing.startTime.getTime()) {
        return NextResponse.json({ error: "endTime cannot be before startTime" }, { status: 400 });
    }

    // Cost is always calculated from the time-entry OWNER's rates, not the editing user's
    // (a manager editing a field crew's punch must not stamp manager rates onto the entry).
    const owner = existing.userId === user.id
        ? user
        : await prisma.user.findUnique({ where: { id: existing.userId } });
    if (!owner) return NextResponse.json({ error: "Owner not found" }, { status: 404 });

    // WA-compliant cost: meal deduction for shifts >5h (unless skipped), cents rounding.
    const cost = computeLaborCost({
        start: existing.startTime,
        end,
        hourlyRate: toNum(owner.hourlyRate),
        burdenRate: toNum(owner.burdenRate),
        mealSkipped: typeof mealSkipped === "boolean" ? mealSkipped : existing.mealSkipped,
    });

    const updateData: any = {
        endTime: end,
        durationHours: cost.payableHours,
        laborCost: cost.laborCost,
        burdenCost: cost.burdenCost,
        mealSkipped: typeof mealSkipped === "boolean" ? mealSkipped : existing.mealSkipped,
        mealDeductionHours: cost.mealDeductionHours,
        needsReview: cost.needsReview,
        reviewReason: cost.reviewReason,
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

    // Flag for review when a meal was skipped on a long shift (WA L&I premium/owed-pay check).
    if (cost.needsReview) {
        await notifyReview({
            type: "meal_skipped",
            severity: "warning",
            title: "Meal break skipped on a long shift",
            body: `${cost.payableHours.toFixed(2)} hrs clocked with no meal break (shift over 5h). ${cost.reviewReason ?? ""}`.trim(),
            projectId: existing.projectId,
            timeEntryId: id,
            actorId: user.id,
            dedupeKey: `meal_skipped:${id}`,
        }).catch(() => {});
    }

    return NextResponse.json(JSON.parse(JSON.stringify(timeEntry)));
}
