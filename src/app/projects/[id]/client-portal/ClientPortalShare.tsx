"use client";
import { useState, useTransition } from "react";
import { emailPortalLinkToClient } from "@/lib/actions";
import { toast } from "sonner";

interface Props {
    projectId: string;
    portalUrl: string;
    clientEmail: string | null;
    lastSharedAt: string | null;
}

export default function ClientPortalShare({ projectId, portalUrl, clientEmail, lastSharedAt }: Props) {
    const [copied, setCopied] = useState(false);
    const [isPending, startTransition] = useTransition();

    const handleCopy = async () => {
        await navigator.clipboard.writeText(portalUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleSendEmail = () => {
        if (!clientEmail) {
            toast.error("No client email on file for this project.");
            return;
        }
        startTransition(async () => {
            try {
                await emailPortalLinkToClient(projectId);
                toast.success(`Portal link sent to ${clientEmail}`);
            } catch (e: any) {
                toast.error(e.message || "Failed to send email");
            }
        });
    };

    return (
        <div className="hui-card p-6 space-y-4">
            <h2 className="text-base font-semibold text-hui-textMain">Share Portal</h2>

            <div>
                <label className="text-xs font-medium text-hui-textMuted mb-1 block">Portal Link</label>
                <div className="flex gap-2">
                    <input
                        readOnly
                        value={portalUrl}
                        className="hui-input text-xs flex-1 bg-slate-50 text-hui-textMuted"
                    />
                    <button onClick={handleCopy} className="hui-btn hui-btn-secondary text-xs px-3 shrink-0">
                        {copied ? "Copied!" : "Copy"}
                    </button>
                </div>
            </div>

            <div>
                <label className="text-xs font-medium text-hui-textMuted mb-1 block">Client Email</label>
                <div className="text-sm text-hui-textMain px-3 py-2 bg-slate-50 rounded border border-hui-border">
                    {clientEmail ?? <span className="italic text-hui-textMuted">No email on file</span>}
                </div>
            </div>

            <button
                onClick={handleSendEmail}
                disabled={isPending || !clientEmail}
                className="hui-btn hui-btn-primary w-full text-sm disabled:opacity-50"
            >
                {isPending ? "Sending..." : "Send Portal Link via Email"}
            </button>

            {lastSharedAt && (
                <p className="text-xs text-hui-textMuted text-center">
                    Last sent {new Date(lastSharedAt).toLocaleDateString()}
                </p>
            )}
        </div>
    );
}
