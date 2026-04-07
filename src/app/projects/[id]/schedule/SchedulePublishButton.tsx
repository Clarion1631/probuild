"use client";

import { useState, useTransition } from "react";
import { toggleSchedulePublished, emailPortalLinkToClient } from "@/lib/actions";
import { toast } from "sonner";

export default function SchedulePublishButton({
    projectId,
    initialPublished,
}: {
    projectId: string;
    initialPublished: boolean;
}) {
    const [published, setPublished] = useState(initialPublished);
    const [showMenu, setShowMenu] = useState(false);
    const [isPending, startTransition] = useTransition();

    function handleToggle() {
        const next = !published;
        startTransition(async () => {
            await toggleSchedulePublished(projectId, next);
            setPublished(next);
            toast.success(next ? "Schedule published to client portal" : "Schedule hidden from client portal");
            setShowMenu(false);
        });
    }

    function handleNotifyClient() {
        startTransition(async () => {
            await emailPortalLinkToClient(projectId);
            toast.success("Portal link sent to client");
            setShowMenu(false);
        });
    }

    return (
        <div className="relative">
            <button
                onClick={() => setShowMenu(!showMenu)}
                disabled={isPending}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition ${
                    published
                        ? "bg-green-50 text-green-700 border-green-200 hover:bg-green-100"
                        : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                } disabled:opacity-50`}
            >
                {published ? (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                )}
                {published ? "Published" : "Publish to Portal"}
                <svg className="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {showMenu && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                    <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-xl z-50 py-1">
                        <button
                            onClick={handleToggle}
                            disabled={isPending}
                            className="w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
                        >
                            {published ? (
                                <>
                                    <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                    </svg>
                                    <span className="text-red-600">Unpublish from Portal</span>
                                </>
                            ) : (
                                <>
                                    <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                    </svg>
                                    <span className="text-green-700">Publish to Client Portal</span>
                                </>
                            )}
                        </button>
                        {published && (
                            <button
                                onClick={handleNotifyClient}
                                disabled={isPending}
                                className="w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 flex items-center gap-2 border-t border-slate-100 disabled:opacity-50"
                            >
                                <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                </svg>
                                <span>Notify Client via Email</span>
                            </button>
                        )}
                        <div className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">
                            {published
                                ? "Schedule is visible on the client dashboard"
                                : "Clients won't see the schedule until published"}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
