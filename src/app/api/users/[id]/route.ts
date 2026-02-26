import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = 'force-dynamic';

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const currentUser = await prisma.user.findUnique({
            where: { email: session.user.email }
        });

        // Only MANAGER and ADMIN can edit users
        if (!currentUser || (currentUser.role !== 'MANAGER' && currentUser.role !== 'ADMIN')) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();

        // Allowed fields for update
        const { role, hourlyRate, burdenRate, pinCode } = body;

        const updateData: any = {};
        if (role !== undefined) updateData.role = role;
        if (hourlyRate !== undefined) updateData.hourlyRate = Number(hourlyRate);
        if (burdenRate !== undefined) updateData.burdenRate = Number(burdenRate);
        if (pinCode !== undefined) updateData.pinCode = pinCode;

        const updatedUser = await prisma.user.update({
            where: { id: (await params).id },
            data: updateData,
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                hourlyRate: true,
                burdenRate: true,
                pinCode: true,
            }
        });

        return NextResponse.json(updatedUser);
    } catch (error: any) {
        console.error("PUT /api/users/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
