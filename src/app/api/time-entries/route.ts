export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    let user;

    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        user = await prisma.user.findUnique({ where: { id: token } });
    }

    if (!user && session?.user?.email) {
        user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!user) {
            user = await prisma.user.create({
                data: {
                    email: session.user.email,
                    name: session.user.name,
                    role: 'EMPLOYEE'
                }
            });
        }
    }

    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
            budgetBucket: true
        },
        orderBy: {
            createdAt: 'desc'
        }
    });

    return NextResponse.json(timeEntries);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    let user;

    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        user = await prisma.user.findUnique({ where: { id: token } });
    }

    if (!user && session?.user?.email) {
        user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!user) {
            user = await prisma.user.create({
                data: {
                    email: session.user.email,
                    name: session.user.name,
                    role: 'EMPLOYEE'
                }
            });
        }
    }

    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { projectId, budgetBucketId, startTime, latitude, longitude } = body;

    if (!projectId) {
        return NextResponse.json({ error: "Project ID is required" }, { status: 400 });
    }

    const timeEntry = await prisma.timeEntry.create({
        data: {
            userId: user.id,
            projectId,
            budgetBucketId: budgetBucketId || null,
            startTime: startTime ? new Date(startTime) : new Date(),
            latitude,
            longitude,
        }
    });

    return NextResponse.json(timeEntry);
}

export async function PUT(req: Request) {
    const session = await getServerSession(authOptions);
    let user;

    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        user = await prisma.user.findUnique({ where: { id: token } });
    }

    if (!user && session?.user?.email) {
        user = await prisma.user.findUnique({ where: { email: session.user.email } });
    }

    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

    const laborCost = durationHours * (user.hourlyRate || 0);
    const burdenCost = durationHours * (user.burdenRate || 0);

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

    return NextResponse.json(timeEntry);
}
