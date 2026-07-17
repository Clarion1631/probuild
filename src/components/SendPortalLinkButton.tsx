"use client";

import { useTransition } from "react";
import { emailPortalLinkToClient } from "@/lib/actions";
import { toast } from "sonner";

/**
 * One-click "(re)send the client portal link" button.
 *
 * Calls `emailPortalLinkToClient`, which emails a passwordless one-click link
 * (via `/api/portal/verify`) to the project's client. Sending email is an
 * outward-facing action, so it confirms first.
 */
export default function SendPortalLinkButton({
    projectId,
    clientName,
}: {
    projectId: string;
    clientName?: string;
}) {
    const [isPending, startTransition] = useTransition();

    const who = clientName ? ` to ${clientName}` : " to the client";

    const handleSend = () => {
        if (!confirm(`Email the portal link${who}?`)) return;
        startTransition(async () => {
            try {
                const res = await emailPortalLinkToClient(projectId);
                if (res?.success) toast.success(`Portal link sent${who}`);
                else toast.error(res?.error || "Failed to send portal link");
            } catch (e: any) {
                toast.error(e?.message || "Failed to send portal link");
            }
        });
    };

    return (
        <button
            onClick={handleSend}
            disabled={isPending}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-md bg-hui-primary text-white text-sm font-medium hover:opacity-90 transition shadow-sm disabled:opacity-50"
        >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            {isPending ? "Sending…" : "Send Portal Link to Client"}
        </button>
    );
}
