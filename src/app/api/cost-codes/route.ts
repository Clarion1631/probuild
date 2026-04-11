export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get('active');

    const where: any = {};
    if (activeOnly === 'true') where.isActive = true;

    const costCodes = await prisma.costCode.findMany({
        where,
        orderBy: { code: 'asc' }
    });

    return NextResponse.json(costCodes);
}

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { code, name, description } = body;

    if (!code || !name) {
        return NextResponse.json({ error: "Code and Name are required" }, { status: 400 });
    }

    try {
        const costCode = await prisma.costCode.create({
            data: {
                code: code.toUpperCase(),
                name,
                description: description || null,
            }
        });
        return NextResponse.json(costCode);
    } catch (error: any) {
        if (error.code === 'P2002') {
            return NextResponse.json({ error: "A cost code with this code already exists" }, { status: 409 });
        }
        return NextResponse.json({ error: "Failed to create cost code" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { id, code, name, description, isActive } = body;

    if (!id) return NextResponse.json({ error: "ID is required" }, { status: 400 });

    try {
        const costCode = await prisma.costCode.update({
            where: { id },
            data: {
                ...(code && { code: code.toUpperCase() }),
                ...(name && { name }),
                ...(description !== undefined && { description }),
                ...(isActive !== undefined && { isActive }),
            }
        });
        return NextResponse.json(costCode);
    } catch (error: any) {
        if (error.code === 'P2002') {
            return NextResponse.json({ error: "A cost code with this code already exists" }, { status: 409 });
        }
        return NextResponse.json({ error: "Failed to update cost code" }, { status: 500 });
    }
}
