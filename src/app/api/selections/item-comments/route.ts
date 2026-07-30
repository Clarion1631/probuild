import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertDecisionActorAccess } from "@/lib/actions";
import { mimeTypeForFileName } from "@/lib/project-files";
import { postSelectionItemComment, type ThreadFileCandidate } from "@/lib/selection-item-thread-core";
import { createComment, notify, revalidate, uploadAttachments } from "@/lib/selection-item-thread-dependencies";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const itemId = formData.get("itemId") as string | null;
        const body = (formData.get("body") as string | null) ?? "";
        const fileEntries = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

        if (!itemId) {
            return NextResponse.json({ error: "itemId required" }, { status: 400 });
        }

        const files: ThreadFileCandidate[] = await Promise.all(
            fileEntries.map(async (file) => ({
                name: file.name,
                buffer: Buffer.from(await file.arrayBuffer()),
                mimeType: file.type || mimeTypeForFileName(file.name),
                size: file.size,
            })),
        );

        const comment = await postSelectionItemComment(itemId, body, files, {
            findItem: (id) =>
                prisma.selectionProposal.findUnique({
                    where: { id },
                    select: { id: true, projectId: true, deletedAt: true, name: true },
                }),
            assertAccess: assertDecisionActorAccess,
            uploadAttachments,
            createComment,
            notify,
            revalidate,
        });

        return NextResponse.json({ comment }, { status: 201 });
    } catch (err: any) {
        const message = err?.message || "Couldn't post that comment.";
        const status = message === "Item not found" ? 404 : message === "Forbidden" || message === "Unauthorized" ? 403 : 400;
        return NextResponse.json({ error: message }, { status });
    }
}
