import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
export const dynamic = 'force-dynamic';

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
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
