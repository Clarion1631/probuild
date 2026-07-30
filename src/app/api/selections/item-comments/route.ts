import { NextRequest, NextResponse } from "next/server";
import { assertDecisionActorAccess } from "@/lib/actions";
import { PortalAuthError } from "@/lib/permissions";
import { mimeTypeForFileName } from "@/lib/project-files";
import {
    postSelectionItemComment,
    SELECTION_ITEM_COMMENT_MAX_FILES,
    SELECTION_ITEM_COMMENT_MAX_FILE_BYTES,
    SELECTION_ITEM_COMMENT_MAX_TOTAL_BYTES,
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
        const formData = await req.formData();
        const itemId = formData.get("itemId") as string | null;
        const body = (formData.get("body") as string | null) ?? "";
        const fileEntries = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

        if (!itemId) {
            return NextResponse.json({ error: "itemId required" }, { status: 400 });
        }

        // Enforce count/size from file METADATA before buffering any content
        // into memory — file.size is available on the File object without
        // reading its bytes. The core repeats these checks (defense in
        // depth, and the seam tests exercise it directly), but there's no
        // reason to buffer a batch that's already known to be oversized.
        if (fileEntries.length > SELECTION_ITEM_COMMENT_MAX_FILES) {
            return NextResponse.json(
                { error: `You can attach up to ${SELECTION_ITEM_COMMENT_MAX_FILES} files at a time.` },
                { status: 400 },
            );
        }
        let totalMetadataBytes = 0;
        for (const file of fileEntries) {
            if (file.size > SELECTION_ITEM_COMMENT_MAX_FILE_BYTES) {
                return NextResponse.json({ error: `${file.name} is too large (4 MB max).` }, { status: 400 });
            }
            totalMetadataBytes += file.size;
        }
        if (totalMetadataBytes + Buffer.byteLength(body, "utf8") > SELECTION_ITEM_COMMENT_MAX_TOTAL_BYTES) {
            return NextResponse.json({ error: "Attachments plus message are too large (4 MB total max)." }, { status: 400 });
        }

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

        return NextResponse.json({ comment }, { status: 201 });
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
