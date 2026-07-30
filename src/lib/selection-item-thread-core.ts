export const SELECTION_ITEM_COMMENT_MAX_LENGTH = 4000 as const;
export const SELECTION_ITEM_COMMENT_MAX_FILES = 5 as const;
export const SELECTION_ITEM_COMMENT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Trims and length-checks a comment body. Does NOT require non-empty — a
 * post with at least one attachment and no text is valid (see
 * postSelectionItemComment's combined body-or-attachment check). */
export function normalizeSelectionItemCommentBody(value: unknown): string {
    if (typeof value !== "string") {
        throw new Error("Comment must be text.");
    }
    const trimmed = value.trim();
    if (trimmed.length > SELECTION_ITEM_COMMENT_MAX_LENGTH) {
        throw new Error("Comment must be 4,000 characters or fewer.");
    }
    return trimmed;
}

export type ThreadItem = {
    id: string;
    projectId: string;
    deletedAt: Date | null;
    name: string;
};

export type ThreadActor = {
    isStaff: boolean;
    clientId: string | null;
    userId: string | null;
    actorName: string;
};

export type ThreadFileCandidate = {
    name: string;
    buffer: Buffer;
    mimeType: string;
    size: number;
};

export type ThreadAttachment = { id: string; name: string; url: string };

export type ThreadComment = {
    id: string;
    proposalId: string;
    authorType: string;
    authorUserId: string | null;
    authorClientId: string | null;
    authorName: string;
    body: string;
    attachments: string | null;
    readByTeamAt: Date | null;
    readByClientAt: Date | null;
    createdAt: Date;
};

type PostSelectionItemCommentDependencies = {
    findItem: (itemId: string) => Promise<ThreadItem | null>;
    assertAccess: (projectId: string) => Promise<ThreadActor>;
    // Called AFTER assertAccess succeeds and validation passes — never before.
    // Real implementation uploads each file via saveProjectFile() with
    // whole-batch cleanup on any later failure (see project-files.ts /
    // saveProjectFile). Denial/validation failures never reach this
    // dependency, so an unauthorized or invalid request never creates a
    // ProjectFile row or storage object.
    uploadAttachments: (
        files: ThreadFileCandidate[],
        actor: ThreadActor,
        item: ThreadItem,
    ) => Promise<ThreadAttachment[]>;
    // Runs the row-lock transaction (CAS on deletedAt + create) and the
    // activity log write.
    createComment: (input: {
        item: ThreadItem;
        actor: ThreadActor;
        body: string;
        attachments: ThreadAttachment[] | null;
    }) => Promise<ThreadComment>;
    notify: (input: { item: ThreadItem; actor: ThreadActor; comment: ThreadComment }) => Promise<void>;
    revalidate: (projectId: string) => void;
};

/**
 * Strict ordering (docs/superpowers/plans/2026-07-30-selection-item-threads.md):
 * 1. findItem — not-found on missing/deleted.
 * 2. assertAccess — nothing is validated or written before this passes.
 * 3. Validate — trimmed body 1..4000 chars OR at least one file; extension/
 *    size checks happen inside uploadAttachments using the now-known actor.
 * 4. uploadAttachments — LAST before the transaction.
 * 5. createComment — row-lock transaction + create + activity log.
 * Notify runs after commit, non-fatal.
 */
export async function postSelectionItemComment(
    itemId: string,
    rawBody: unknown,
    files: ThreadFileCandidate[],
    dependencies: PostSelectionItemCommentDependencies,
): Promise<ThreadComment> {
    if (files.length > SELECTION_ITEM_COMMENT_MAX_FILES) {
        throw new Error(`You can attach up to ${SELECTION_ITEM_COMMENT_MAX_FILES} files at a time.`);
    }
    for (const file of files) {
        if (file.size > SELECTION_ITEM_COMMENT_MAX_FILE_BYTES) {
            throw new Error(`${file.name} is too large (8 MB max).`);
        }
    }

    const normalizedBody = normalizeSelectionItemCommentBody(rawBody);
    if (!normalizedBody && files.length === 0) {
        throw new Error("Write something or attach a file.");
    }

    const item = await dependencies.findItem(itemId);
    if (!item || item.deletedAt) {
        throw new Error("Item not found");
    }

    const actor = await dependencies.assertAccess(item.projectId);

    const attachments =
        files.length > 0 ? await dependencies.uploadAttachments(files, actor, item) : null;

    const comment = await dependencies.createComment({
        item,
        actor,
        body: normalizedBody,
        attachments,
    });

    dependencies.revalidate(item.projectId);

    try {
        await dependencies.notify({ item, actor, comment });
    } catch (err) {
        console.error("[postSelectionItemComment] notify failed:", err);
    }

    return comment;
}

type MarkSelectionItemThreadReadDependencies = {
    findItem: (itemId: string) => Promise<ThreadItem | null>;
    assertAccess: (projectId: string) => Promise<ThreadActor>;
    markRead: (proposalId: string, seenCommentIds: string[], isStaff: boolean) => Promise<void>;
};

/** Marks ONLY the ids the viewer actually rendered — marking all-null-for-item
 * would swallow a comment that arrived after the page payload was built. */
export async function markSelectionItemThreadRead(
    itemId: string,
    seenCommentIds: string[],
    dependencies: MarkSelectionItemThreadReadDependencies,
): Promise<void> {
    const item = await dependencies.findItem(itemId);
    if (!item || item.deletedAt) {
        throw new Error("Item not found");
    }
    const actor = await dependencies.assertAccess(item.projectId);
    if (seenCommentIds.length === 0) return;
    await dependencies.markRead(item.id, seenCommentIds, actor.isStaff);
}
