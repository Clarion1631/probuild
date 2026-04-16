"use client";

// Client-facing "Request changes" form rendered by the public share viewer.
// Posts to /api/rooms/[id]/share-feedback with { token, message, clientName,
// clientEmail }. The API routes the message to the project/lead manager via
// the existing sendNotification() pipeline.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface Props {
    roomId: string;
    token: string;
    onClose: () => void;
}

export function ShareRequestChangesModal({ roomId, token, onClose }: Props) {
    const [message, setMessage] = useState("");
    const [clientName, setClientName] = useState("");
    const [clientEmail, setClientEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const backdropRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        const trimmed = message.trim();
        if (!trimmed) {
            toast.error("Please add a message first.");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/rooms/${roomId}/share-feedback`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token,
                    message: trimmed,
                    clientName: clientName.trim() || undefined,
                    clientEmail: clientEmail.trim() || undefined,
                }),
            });
            if (res.status === 429) {
                toast.error("You've sent a lot of messages recently — please try again later.");
                return;
            }
            if (!res.ok) {
                toast.error("Couldn't send your message. Please try again.");
                return;
            }
            toast.success("Your feedback was sent to the contractor.");
            onClose();
        } catch {
            toast.error("Couldn't send your message. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div
            ref={backdropRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
            onMouseDown={(e) => {
                if (e.target === backdropRef.current) onClose();
            }}
        >
            <div className="hui-card w-full max-w-md bg-white p-5 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-slate-900">Request changes</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-600"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>
                <p className="mb-3 text-xs text-slate-500">
                    Tell your contractor what you&apos;d like to change. They&apos;ll get an
                    email and can reply directly to you.
                </p>
                <form onSubmit={onSubmit} className="space-y-3">
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-700">
                            Message <span className="text-rose-500">*</span>
                        </label>
                        <textarea
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            required
                            rows={5}
                            maxLength={4000}
                            className="hui-input w-full resize-y"
                            placeholder="Example: please swap the island cabinets to white oak and move the stove to the back wall."
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">
                                Your name
                            </label>
                            <input
                                value={clientName}
                                onChange={(e) => setClientName(e.target.value)}
                                maxLength={120}
                                className="hui-input w-full"
                                placeholder="Jane Doe"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">
                                Email (optional)
                            </label>
                            <input
                                type="email"
                                value={clientEmail}
                                onChange={(e) => setClientEmail(e.target.value)}
                                maxLength={200}
                                className="hui-input w-full"
                                placeholder="jane@example.com"
                            />
                        </div>
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={onClose}
                            className="hui-btn hui-btn-secondary px-3 py-1.5 text-sm"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="hui-btn hui-btn-green px-3 py-1.5 text-sm disabled:opacity-60"
                        >
                            {submitting ? "Sending…" : "Send"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
