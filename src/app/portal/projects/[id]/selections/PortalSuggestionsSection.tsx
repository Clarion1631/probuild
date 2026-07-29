"use client";

// Entry point for adding items into the playground: the clipper bookmarklet
// and a manual "Add an item" button. The old flat "Your suggestions" list
// that used to live here is gone — every item now shows up grouped under
// PortalDecisionsSection (in a Decision, or in Unsorted), so listing them
// again here would just duplicate that view. docs/specs/client-selections-playground.md
// Phase 1: adding is ungated ("the client's space... PM does not gate what
// may exist"), so the framing here is "adding", not "requesting permission".

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { buildClipperBookmarklet } from "@/lib/clipper-bookmarklet";
import ClipperDragLink from "@/components/ClipperDragLink";
import AddItemModal from "./AddItemModal";
import { Link2, Copy, Plus } from "lucide-react";

export default function PortalSuggestionsSection({
    projectId,
    appUrl,
}: {
    projectId: string;
    appUrl: string;
}) {
    const router = useRouter();
    const [modalOpen, setModalOpen] = useState(false);

    const bookmarkletHref = buildClipperBookmarklet({
        origin: appUrl,
        targetPath: "/portal/clip",
        extraParams: { projectId },
    });

    async function handleCopyBookmarklet() {
        try {
            await navigator.clipboard.writeText(bookmarkletHref);
            toast.success("Clipper code copied! Create a new bookmark and paste this in as the URL.");
        } catch {
            toast.error("Couldn't copy that — try dragging the button instead.");
        }
    }

    return (
        <div className="hui-card p-5 flex items-center justify-between gap-6 flex-wrap">
            <div className="flex items-center gap-4">
                <div className="w-11 h-11 bg-hui-primary/10 rounded-xl flex items-center justify-center shrink-0">
                    <Link2 className="w-5 h-5 text-hui-primary" />
                </div>
                <div>
                    <h2 className="text-base font-semibold text-hui-textMain">Get the Clipper</h2>
                    <p className="text-sm text-hui-textMuted mt-0.5 max-w-md">
                        Found something while shopping? Drag the ProBuild Clip button to your bookmarks bar.
                        <br />
                        On any product page, click it and the item lands right here for you to sort.
                        <br />
                        Dragging not working on your device? Tap Copy, then make a new bookmark and paste it in as the URL.
                    </p>
                </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                <ClipperDragLink
                    href={bookmarkletHref}
                    className="hui-btn hui-btn-secondary flex items-center gap-2 cursor-grab active:cursor-grabbing"
                    title="Drag me to your bookmarks bar"
                >
                    <Link2 className="w-4 h-4" />
                    ProBuild Clip
                </ClipperDragLink>
                <button
                    type="button"
                    onClick={handleCopyBookmarklet}
                    className="hui-btn hui-btn-secondary flex items-center gap-2"
                    title="Copy the clipper code"
                >
                    <Copy className="w-4 h-4" />
                    Copy
                </button>
                <button
                    type="button"
                    onClick={() => setModalOpen(true)}
                    className="hui-btn hui-btn-green flex items-center gap-2"
                >
                    <Plus className="w-4 h-4" />
                    Add an item
                </button>
            </div>

            <AddItemModal
                projectId={projectId}
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onSubmitted={() => router.refresh()}
            />
        </div>
    );
}
