"use client";

import { useState, useTransition } from "react";
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
}

const MAX_FILES = 5;

export function SelectionItemThread({
    itemId,
    comments,
    unreadCount,
    onChanged,
    className,
}: SelectionItemThreadProps) {
    const [expanded, setExpanded] = useState(false);
    const [draft, setDraft] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [, startMarkRead] = useTransition();

    function handleExpand() {
        const next = !expanded;
        setExpanded(next);
        if (next && comments.length > 0) {
            // Optimistically clears the pill — best-effort, a failed mark-read
            // isn't worth surfacing to the viewer.
            startMarkRead(async () => {
                try {
                    await markSelectionItemThreadRead(itemId, comments.map((c) => c.id));
                    onChanged();
                } catch {
                    // no-op
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
        <div className={className}>
            <button
                type="button"
                data-testid="selection-thread-toggle"
                aria-expanded={expanded}
                aria-controls={`selection-thread-${itemId}`}
                onClick={handleExpand}
                className="text-xs font-medium text-blue-600 hover:underline flex items-center gap-1.5"
            >
                <span>💬 Discussion ({comments.length})</span>
                {unreadCount > 0 && (
                    <span
                        data-testid="selection-thread-unread-pill"
                        className="inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-bold text-white bg-red-500 rounded-full"
                    >
                        {unreadCount} new
                    </span>
                )}
            </button>

            {expanded && (
                <div id={`selection-thread-${itemId}`} className="mt-2 space-y-2 border-t border-slate-100 pt-2">
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
