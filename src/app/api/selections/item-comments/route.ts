import { NextRequest, NextResponse } from "next/server";
import { assertDecisionActorAccess } from "@/lib/actions";
import { PortalAuthError } from "@/lib/permissions";
import { mimeTypeForFileName } from "@/lib/project-files";
import {
    parseThreadAttachments,
    postSelectionItemComment,
    ThreadNotFoundError,
    ThreadValidationError,
    type ThreadFileCandidate,
} from "@/lib/selection-item-thread-core";
import {
    cleanupAttachments,
    createComment,
    findThreadItem,
    notify,
    revalidate,
    uploadAttachments,
} from "@/lib/selection-item-thread-dependencies";

export async function POST(req: NextRequest) {
    try {
        let formData;
        try {
            // Vercel caps serverless function request bodies at 4.5MB — that
            // platform limit is the effective outer bound on this parse; a
            // request that exceeds it never reaches this line at all (the
            // platform rejects it upstream). Anything under that ceiling
            // that's still malformed multipart lands here as a parse error.
            formData = await req.formData();
        } catch {
            return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
        }
        const itemId = formData.get("itemId") as string | null;
        const body = (formData.get("body") as string | null) ?? "";
        const fileEntries = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

        if (!itemId) {
            return NextResponse.json({ error: "itemId required" }, { status: 400 });
        }

        // File-count/size and body-length validation is the core's job, run
        // strictly AFTER findItem + assertAccess (postSelectionItemComment's
        // documented ordering) — checking it here first would leak
        // validation detail to an anonymous/foreign caller before they've
        // been authorized at all. req.formData() has also already
        // materialized the whole body by this point, so there is no
        // pre-buffering benefit to checking file metadata before this line.
        const files: ThreadFileCandidate[] = await Promise.all(
            fileEntries.map(async (file) => ({
                name: file.name,
                buffer: Buffer.from(await file.arrayBuffer()),
                // Derived strictly from the extension, never from the
                // client-supplied File.type (trivially spoofable).
                mimeType: mimeTypeForFileName(file.name),
                size: file.size,
            })),
        );

        const comment = await postSelectionItemComment(itemId, body, files, {
            findItem: findThreadItem,
            assertAccess: assertDecisionActorAccess,
            uploadAttachments,
            createComment,
            cleanupAttachments,
            notify,
            revalidate,
        });

        // Public shape only — exactly the fields the staff/portal loaders
        // expose (SelectionItemThreadCommentView); internal ids and the
        // opposite side's read timestamps never leave the server.
        return NextResponse.json(
            {
                comment: {
                    id: comment.id,
                    authorType: comment.authorType,
                    authorName: comment.authorName,
                    body: comment.body,
                    attachments: parseThreadAttachments(comment.attachments),
                    createdAt: comment.createdAt,
                },
            },
            { status: 201 },
        );
    } catch (err) {
        if (err instanceof ThreadNotFoundError) {
            return NextResponse.json({ error: err.message }, { status: 404 });
        }
        if (err instanceof PortalAuthError || (err instanceof Error && err.message === "Forbidden")) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        if (err instanceof ThreadValidationError) {
            return NextResponse.json({ error: err.message }, { status: 400 });
        }
        console.error("[POST /api/selections/item-comments]", err);
        return NextResponse.json({ error: "Couldn't post that comment." }, { status: 500 });
    }
}
