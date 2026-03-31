"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function getLeadNotes(leadId: string) {
    return prisma.leadNote.findMany({
        where: { leadId },
        orderBy: { createdAt: "desc" },
    });
}

export async function createLeadNote(leadId: string, content: string, createdBy?: string) {
    const note = await prisma.leadNote.create({
        data: {
            leadId,
            content,
            createdBy: createdBy || "Team Member",
        }
    });
    revalidatePath(`/leads/${leadId}`);
    return note;
}
