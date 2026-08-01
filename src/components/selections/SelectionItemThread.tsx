"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { markSelectionItemThreadRead } from "@/lib/actions";
import { SELECTION_ITEM_COMMENT_MAX_LENGTH } from "@/lib/selection-item-thread-core";

export type SelectionItemThreadAttachment = { id: string; name: string; url: string };

export type SelectionItemThreadCommentView = {
    id: string;
    authorType: string;
    authorName: string;
    body: string;
    attachments: SelectionItemThreadAttachment[];
    createdAt: string;
};

interface SelectionItemThreadProps {
    itemId: string;
    comments: SelectionItemThreadCommentView[];
    unreadCount: number;
    onChanged: () => void;
    className?: string;
    // Disambiguates DOM ids (id/aria-controls) when the same item's thread
    // renders in more than one placement on the same page — e.g. a chosen
    // item appears both in its own CandidateCard AND in the Approved Items
    // table. Defaults to itemId, which is unique everywhere else.
    instanceId?: string;
}

const MAX_FILES = 5;

export function SelectionItemThread({
    itemId,
    comments,
    unreadCount,
    onChanged,
    className,
    instanceId,
}: SelectionItemThreadProps) {
    const domId = `selection-thread-${instanceId ?? itemId}`;
    const [expanded, setExpanded] = useState(false);
    const [draft, setDraft] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [locallyRead, setLocallyRead] = useState(false);
    const [, startMarkRead] = useTransition();
    const previousUnreadCount = useRef(unreadCount);

    // Reset the optimistic override whenever the server-reported count
    // CHANGES at all (not just when it goes up) — a drop to the value our
    // own mark-read produced is harmless to reset (unreadCount is already 0
    // there, so the pill stays hidden either way), and this is what makes a
    // later, unrelated re-render pick up a genuinely fresh count instead of
    // trusting a stale local override indefinitely.
    useEffect(() => {
        if (unreadCount !== previousUnreadCount.current) {
            setLocallyRead(false);
        }
        previousUnreadCount.current = unreadCount;
    }, [unreadCount]);

    function handleExpand() {
        const next = !expanded;
        setExpanded(next);
        if (next && comments.length > 0) {
            // Optimistically clear the pill immediately, rather than waiting
            // on the mark-read round trip + a parent refresh to reflect the
            // server's new unreadCount.
            setLocallyRead(true);
            startMarkRead(async () => {
                try {
                    await markSelectionItemThreadRead(itemId, comments.map((c) => c.id));
                    onChanged();
                } catch {
                    // The mark-read failed — the pill must not stay
                    // incorrectly hidden with no way to recover (unreadCount
                    // itself won't have changed, so the effect above won't
                    // fire on its own).
                    setLocallyRead(false);
                }
            });
        }
    }

    function handleFilePick(event: React.ChangeEvent<HTMLInputElement>) {
        const picked = Array.from(event.target.files ?? []);
        event.target.value = "";
        setFiles((current) => [...current, ...picked].slice(0, MAX_FILES));
    }

    function removeFile(index: number) {
        setFiles((current) => current.filter((_, i) => i !== index));
    }

    async function handlePost() {
        if (!draft.trim() && files.length === 0) {
            toast.error("Write something or attach a file.");
            return;
        }
        setSubmitting(true);
        try {
            const formData = new FormData();
            formData.set("itemId", itemId);
            formData.set("body", draft);
            for (const file of files) formData.append("files", file);

            const response = await fetch("/api/selections/item-comments", {
                method: "POST",
                body: formData,
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || "Couldn't post that comment.");
            }
            setDraft("");
            setFiles([]);
            toast.success("Posted");
            onChanged();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't post that comment.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        // basis-full when expanded: inside the card's flex-wrap action row the
        // open composer must take the whole row even when the thread was empty
        // (no comments → the parent passes no width class).
        <div className={`${className ?? ""} ${expanded ? "basis-full" : ""}`.trim()}>
            <button
                type="button"
                data-testid="selection-thread-toggle"
                aria-expanded={expanded}
                aria-controls={domId}
                onClick={handleExpand}
                className="text-xs font-medium text-blue-600 hover:underline flex items-center gap-1.5"
            >
                <span>💬 Discussion ({comments.length})</span>
                {unreadCount > 0 && !locallyRead && (
                    <span
                        data-testid="selection-thread-unread-pill"
                        className="inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-bold text-white bg-red-500 rounded-full"
                    >
                        {unreadCount} new
                    </span>
                )}
            </button>

            {!expanded && comments.length > 0 && (
                <p
                    data-testid="selection-thread-latest-preview"
                    className="mt-1 text-xs break-words text-hui-textMuted line-clamp-2"
                >
                    <span className="font-semibold text-hui-textMain">
                        {comments[comments.length - 1].authorName}:
                    </span>{" "}
                    {comments[comments.length - 1].body ||
                        (comments[comments.length - 1].attachments.length > 0
                            ? "sent an attachment"
                            : "")}
                </p>
            )}

            {expanded && (
                <div id={domId} className="mt-2 space-y-2 border-t border-slate-100 pt-2">
                    {comments.length === 0 ? (
                        <p className="text-xs text-hui-textMuted">No messages yet.</p>
                    ) : (
                        comments.map((comment) => (
                            <div key={comment.id} data-testid={`selection-thread-comment-${comment.id}`} className="text-xs">
                                <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-hui-textMain">{comment.authorName}</span>
                                    <span className="text-hui-textMuted">
                                        {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
                                    </span>
                                </div>
                                {comment.body && (
                                    <p className="whitespace-pre-wrap break-words text-hui-textMuted mt-0.5">{comment.body}</p>
                                )}
                                {comment.attachments.length > 0 && (
                                    <div className="mt-1 flex flex-wrap gap-1.5">
                                        {comment.attachments.map((attachment) => (
                                            <a
                                                key={attachment.id}
                                                data-testid={`selection-thread-attachment-${attachment.id}`}
                                                href={attachment.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[11px] text-blue-600 hover:underline bg-slate-50 rounded px-1.5 py-0.5"
                                            >
                                                {attachment.name}
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))
                    )}

                    <div className="pt-1">
                        <textarea
                            aria-label="Write a message"
                            data-testid="selection-thread-composer"
                            className="hui-input w-full text-xs"
                            rows={2}
                            maxLength={SELECTION_ITEM_COMMENT_MAX_LENGTH}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            disabled={submitting}
                            placeholder="Write a message…"
                        />
                        {files.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                                {files.map((file, index) => (
                                    <span key={`${file.name}-${index}`} className="inline-flex items-center gap-1 text-[11px] bg-slate-100 rounded px-1.5 py-0.5">
                                        {file.name}
                                        <button
                                            type="button"
                                            onClick={() => removeFile(index)}
                                            disabled={submitting}
                                            aria-label={`Remove ${file.name}`}
                                            className="text-slate-400 hover:text-red-600"
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="mt-1 flex items-center justify-between gap-2">
                            <label className="text-xs font-medium text-blue-600 hover:underline cursor-pointer">
                                Attach
                                <input
                                    type="file"
                                    multiple
                                    data-testid="selection-thread-attach"
                                    className="hidden"
                                    onChange={handleFilePick}
                                    disabled={submitting || files.length >= MAX_FILES}
                                />
                            </label>
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] text-hui-textMuted">
                                    {draft.length}/{SELECTION_ITEM_COMMENT_MAX_LENGTH}
                                </span>
                                <button
                                    type="button"
                                    data-testid="selection-thread-post"
                                    onClick={handlePost}
                                    disabled={submitting}
                                    className="hui-btn hui-btn-green px-2.5 py-1 text-xs"
                                >
                                    {submitting ? "Posting…" : "Post"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
