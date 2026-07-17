export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

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

    const timeEntry = await prisma.timeEntry.create({
        data: {
            userId: user.id,
            projectId,
            costCodeId: costCodeId || null,
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
