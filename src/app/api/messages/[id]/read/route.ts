import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// PATCH /api/messages/[id]/read — mark a message as read
export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const message = await prisma.message.findUnique({ where: { id } });
    if (!message) {
        return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    if (message.readAt) {
        return NextResponse.json(message);
    }

    const updated = await prisma.message.update({
        where: { id },
        data: { readAt: new Date() },
    });

    return NextResponse.json(updated);
}
