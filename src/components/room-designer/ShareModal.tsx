"use client";

// Popover-style modal that lets the logged-in user enable/revoke the client
// share link and copy/regenerate the URL. Lives in the top toolbar next to
// the Export buttons.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface Props {
    roomId: string;
    anchorRef: React.RefObject<HTMLButtonElement | null>;
    onClose: () => void;
    /**
     * Parent state lift: when share state changes here, bubble it up so the
     * toolbar can render its green "shared" indicator dot without a re-fetch.
     */
    onStateChange: (state: { enabled: boolean; url: string | null }) => void;
    initialEnabled: boolean;
    initialUrl: string | null;
}

export function ShareModal({
    roomId,
    anchorRef,
    onClose,
    onStateChange,
    initialEnabled,
    initialUrl,
}: Props) {
    const [enabled, setEnabled] = useState(initialEnabled);
    const [url, setUrl] = useState(initialUrl);
    const [busy, setBusy] = useState(false);
    const [confirmRotate, setConfirmRotate] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    // Outside-click + Escape to close.
    useEffect(() => {
        function onDown(e: MouseEvent) {
            const target = e.target as Node;
            if (wrapRef.current?.contains(target)) return;
            if (anchorRef.current?.contains(target)) return;
            onClose();
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [onClose, anchorRef]);

    async function toggleShare(next: boolean) {
        setBusy(true);
        try {
            const res = await fetch(`/api/rooms/${roomId}/share`, {
                method: next ? "POST" : "DELETE",
            });
            if (!res.ok) throw new Error(`${res.status}`);
            const body: { enabled?: boolean; url?: string; token?: string } = await res
                .json()
                .catch(() => ({}));
            const nextEnabled = body.enabled ?? next;
            const nextUrl = body.url ?? (next ? url : null);
            setEnabled(nextEnabled);
            setUrl(nextEnabled ? nextUrl ?? url : null);
            onStateChange({ enabled: nextEnabled, url: nextEnabled ? nextUrl ?? url : null });
            toast.success(next ? "Share link enabled" : "Share link disabled");
        } catch {
            toast.error("Couldn't update share settings");
        } finally {
            setBusy(false);
        }
    }

    async function regenerate() {
        setBusy(true);
        setConfirmRotate(false);
        try {
            const res = await fetch(`/api/rooms/${roomId}/share/regenerate`, { method: "POST" });
            if (!res.ok) throw new Error(`${res.status}`);
            const body: { url?: string; enabled?: boolean } = await res.json();
            if (body.url) {
                setUrl(body.url);
                onStateChange({ enabled: body.enabled ?? enabled, url: body.url });
                toast.success("New link generated — old link no longer works");
            }
        } catch {
            toast.error("Couldn't regenerate link");
        } finally {
            setBusy(false);
        }
    }

    async function copyUrl() {
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            toast.success("Link copied");
        } catch {
            toast.error("Couldn't copy — select and copy manually");
        }
    }

    return (
        <div
            ref={wrapRef}
            className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-slate-200 bg-white p-3 shadow-lg"
        >
            <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-900">Share with client</div>
                <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
                    ✕
                </button>
            </div>
            <p className="mb-3 text-xs text-slate-500">
                Anyone with the link can view this room in 3D and request changes.
            </p>

            <label className="mb-3 flex cursor-pointer items-center justify-between rounded-md bg-slate-50 px-3 py-2">
                <span className="text-sm text-slate-800">Share link enabled</span>
                <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy}
                    onChange={(e) => toggleShare(e.target.checked)}
                    className="h-4 w-4"
                />
            </label>

            {enabled && url ? (
                <div className="space-y-2">
                    <div className="flex gap-1.5">
                        <input
                            readOnly
                            value={url}
                            onFocus={(e) => e.currentTarget.select()}
                            className="hui-input flex-1 text-xs"
                        />
                        <button
                            onClick={copyUrl}
                            className="hui-btn hui-btn-secondary px-2 py-1 text-xs"
                        >
                            Copy
                        </button>
                    </div>
                    {confirmRotate ? (
                        <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs">
                            <span className="text-amber-800">Replace current link?</span>
                            <div className="flex gap-1.5">
                                <button
                                    onClick={() => setConfirmRotate(false)}
                                    className="hui-btn hui-btn-secondary px-2 py-0.5 text-xs"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={regenerate}
                                    disabled={busy}
                                    className="hui-btn hui-btn-green px-2 py-0.5 text-xs"
                                >
                                    Replace
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            onClick={() => setConfirmRotate(true)}
                            disabled={busy}
                            className="hui-btn hui-btn-secondary w-full px-2 py-1 text-xs"
                            title="Generates a new URL and invalidates the old one"
                        >
                            Regenerate link
                        </button>
                    )}
                </div>
            ) : null}
        </div>
    );
}
