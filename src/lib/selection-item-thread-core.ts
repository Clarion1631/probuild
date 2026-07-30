// Typed errors so callers (the API route) can map failures to the right
// HTTP status without sniffing message strings — a validation error's
// message is always safe to return verbatim (400); anything else collapses
// to a generic 500 with the real error only ever reaching the server log.
export class ThreadNotFoundError extends Error {
    constructor() {
        super("Item not found");
        this.name = "ThreadNotFoundError";
    }
}

export class ThreadValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ThreadValidationError";
    }
}

export const SELECTION_ITEM_COMMENT_MAX_LENGTH = 4000 as const;
export const SELECTION_ITEM_COMMENT_MAX_FILES = 5 as const;
// Vercel caps serverless function request bodies at 4.5MB — an 8MB single
// file was unreachable in production. Per-file AND total-batch caps both sit
// at 4MB (leaving headroom under 4.5MB for multipart boundaries/headers and
// the body text), so a single near-4MB file or several smaller ones both
// stay under Vercel's real ceiling.
export const SELECTION_ITEM_COMMENT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const SELECTION_ITEM_COMMENT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** Trims and length-checks a comment body. Does NOT require non-empty — a
 * post with at least one attachment and no text is valid (see
 * postSelectionItemComment's combined body-or-attachment check). */
export function normalizeSelectionItemCommentBody(value: unknown): string {
    if (typeof value !== "string") {
        throw new ThreadValidationError("Comment must be text.");
    }
    const trimmed = value.trim();
    if (trimmed.length > SELECTION_ITEM_COMMENT_MAX_LENGTH) {
        throw new ThreadValidationError("Comment must be 4,000 characters or fewer.");
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

/** Parses the stored attachments JSON column into the canonical shape, or
 * an empty array when there are none / the column is malformed. */
export function parseThreadAttachments(raw: string | null): ThreadAttachment[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Unread count for the viewing side — CLIENT posts are unread for staff
 * until readByTeamAt is set; TEAM posts are unread for the client until
 * readByClientAt is set. */
export function unreadThreadCommentCount(
    comments: Pick<ThreadComment, "authorType" | "readByTeamAt" | "readByClientAt">[],
    isStaff: boolean,
): number {
    return comments.filter((c) =>
        isStaff ? c.authorType === "CLIENT" && !c.readByTeamAt : c.authorType === "TEAM" && !c.readByClientAt,
    ).length;
}

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
    // Best-effort per-file rollback (ProjectFile row + storage object). Called
    // for EVERY uploaded attachment when createComment throws after a
    // successful upload — the plan requires whole-batch cleanup for "any
    // failure after the first successful upload, not just the transaction",
    // and a lone uploadAttachments-side rollback can't reach a failure that
    // happens one step later, in createComment (e.g. the CAS row-lock losing
    // a concurrent soft-delete race).
    cleanupAttachments: (attachments: ThreadAttachment[]) => Promise<void>;
    notify: (input: { item: ThreadItem; actor: ThreadActor; comment: ThreadComment }) => Promise<void>;
    revalidate: (projectId: string) => void;
};

/**
 * Strict ordering (docs/superpowers/plans/2026-07-30-selection-item-threads.md):
 * 1. findItem — not-found on missing/deleted.
 * 2. assertAccess — nothing is validated or written before this passes. An
 *    anonymous or foreign caller always gets a 404/403 with no validation
 *    detail — file-count/size/body-length errors are only ever surfaced to
 *    an already-authorized actor.
 * 3. Validate — trimmed body 1..4000 chars OR at least one file; per-file
 *    and total-batch byte caps; extension checks happen inside
 *    uploadAttachments using the now-known actor.
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
    const item = await dependencies.findItem(itemId);
    if (!item || item.deletedAt) {
        throw new ThreadNotFoundError();
    }

    const actor = await dependencies.assertAccess(item.projectId);

    if (files.length > SELECTION_ITEM_COMMENT_MAX_FILES) {
        throw new ThreadValidationError(`You can attach up to ${SELECTION_ITEM_COMMENT_MAX_FILES} files at a time.`);
    }
    let totalBytes = 0;
    for (const file of files) {
        if (file.size > SELECTION_ITEM_COMMENT_MAX_FILE_BYTES) {
            throw new ThreadValidationError(`${file.name} is too large (4 MB max).`);
        }
        totalBytes += file.size;
    }

    const normalizedBody = normalizeSelectionItemCommentBody(rawBody);
    if (!normalizedBody && files.length === 0) {
        throw new ThreadValidationError("Write something or attach a file.");
    }
    totalBytes += Buffer.byteLength(normalizedBody, "utf8");
    if (totalBytes > SELECTION_ITEM_COMMENT_MAX_TOTAL_BYTES) {
        throw new ThreadValidationError("Attachments plus message are too large (4 MB total max).");
    }

    const attachments =
        files.length > 0 ? await dependencies.uploadAttachments(files, actor, item) : null;

    let comment: ThreadComment;
    try {
        comment = await dependencies.createComment({
            item,
            actor,
            body: normalizedBody,
            attachments,
        });
    } catch (err) {
        // Whole-batch cleanup covers ANY failure after the first successful
        // upload, not just a failure inside uploadAttachments itself — a
        // successful upload followed by createComment losing the CAS
        // row-lock race must not orphan the uploaded files.
        if (attachments && attachments.length > 0) {
            await dependencies.cleanupAttachments(attachments);
        }
        throw err;
    }

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
    revalidate: (projectId: string) => void;
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
        throw new ThreadNotFoundError();
    }
    const actor = await dependencies.assertAccess(item.projectId);
    if (seenCommentIds.length === 0) return;
    await dependencies.markRead(item.id, seenCommentIds, actor.isStaff);
    dependencies.revalidate(item.projectId);
}
