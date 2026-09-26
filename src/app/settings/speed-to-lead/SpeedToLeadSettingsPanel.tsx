"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { setSpeedToLeadPausedAction } from "@/lib/speed-to-lead-actions";

interface DeadAlert {
    id: string;
    leadId: string;
    channel: string;
    lastErrorCategory: string | null;
    updatedAt: Date;
}

export default function SpeedToLeadSettingsPanel({ paused, leadInboxConnected, deadAlerts }: { paused: boolean; leadInboxConnected: boolean; deadAlerts: DeadAlert[] }) {
    const [pending, startTransition] = useTransition();

    const run = (fn: () => Promise<unknown>, okMessage: string) => startTransition(async () => {
        try {
            await fn();
            toast.success(okMessage);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Action failed");
        }
    });

    return (
        <div className="space-y-6">
            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Kill switch</h2>
                <p className="text-xs text-slate-500 mb-3">While paused, due alerts are skipped and never sent. Unpausing releases no backlog.</p>
                <button
                    type="button"
                    className="hui-btn hui-btn-secondary"
                    disabled={pending}
                    onClick={() => run(() => setSpeedToLeadPausedAction(!paused), paused ? "Unpaused" : "Paused")}
                >
                    {paused ? "Unpause" : "Pause"}
                </button>
            </div>

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Lead inbox</h2>
                {leadInboxConnected ? (
                    <p className="text-sm text-green-600">Connected, read-only.</p>
                ) : (
                    <a href="/api/gmail/callback?purpose=lead-inbox" className="hui-btn hui-btn-primary inline-block">
                        Connect gtrsupport@ (read-only)
                    </a>
                )}
            </div>

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Failed alerts (DEAD)</h2>
                {deadAlerts.length === 0 ? (
                    <p className="text-sm text-slate-500">None.</p>
                ) : (
                    <ul className="text-sm space-y-1">
                        {deadAlerts.map(a => (
                            <li key={a.id}>
                                <a href={`/leads/${a.leadId}`} className="text-green-600 hover:underline">{a.leadId}</a>
                                {" — "}{a.channel} — {a.lastErrorCategory ?? "unknown"} — {a.updatedAt.toISOString()}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
