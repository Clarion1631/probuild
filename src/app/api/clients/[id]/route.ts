import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { normalizeE164 } from "@/lib/phone";
export const dynamic = 'force-dynamic';

async function requireManagerSession() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } });
    if (!user || !["MANAGER", "ADMIN"].includes(user.role)) return null;
    return user;
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const authUser = await requireManagerSession();
        if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        const id = (await params).id;
        if (!id) {
            return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
        }

        const data = await req.json();

        // Generate initials if name is updated but not initials
        let initials = data.initials;
        if (data.name && !initials) {
            const parts = data.name.trim().split(' ');
            if (parts.length > 1) {
                initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
            } else if (parts.length === 1) {
                initials = parts[0].substring(0, 2).toUpperCase();
            }
        }

        const updateData: any = { ...data };
        if (initials) {
            updateData.initials = initials;
        }
        // Keep E.164 columns in sync when caller updates raw phone fields.
        if ("primaryPhone" in data) {
            updateData.primaryPhoneE164 = normalizeE164(data.primaryPhone);
        }
        if ("additionalPhone" in data) {
            updateData.additionalPhoneE164 = normalizeE164(data.additionalPhone);
        }

        const client = await prisma.client.update({
            where: { id },
            data: updateData,
        });

        return NextResponse.json(client);
    } catch (error) {
        console.error("Error updating client:", error);
        return NextResponse.json({ error: "Failed to update client" }, { status: 500 });
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const authUser = await requireManagerSession();
        if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        const id = (await params).id;
        if (!id) {
            return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
        }

        await prisma.client.delete({
            where: { id },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error deleting client:", error);
        return NextResponse.json({ error: "Failed to delete client" }, { status: 500 });
    }
}
