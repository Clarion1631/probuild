import { NextResponse } from "next/server";
export const dynamic = 'force-dynamic';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const activeOnly = url.searchParams.get("active") === "true";

    const costTypes = await prisma.costType.findMany({
        where: activeOnly ? { isActive: true } : {},
        orderBy: { name: 'asc' }
    });

    return NextResponse.json(costTypes);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { name, description } = body;

    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

    const costType = await prisma.costType.create({
        data: { name, description: description || null }
    });

    return NextResponse.json(costType, { status: 201 });
}

export async function PUT(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { id, name, description, isActive } = body;

    if (!id) return NextResponse.json({ error: "ID is required" }, { status: 400 });

    const costType = await prisma.costType.update({
        where: { id },
        data: {
            ...(name !== undefined && { name }),
            ...(description !== undefined && { description }),
            ...(isActive !== undefined && { isActive }),
        }
    });

    return NextResponse.json(costType);
}
