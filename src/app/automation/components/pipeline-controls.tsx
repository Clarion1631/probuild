"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type SettingKey = "receiptPushPaused" | "qboSyncPaused";

function ToggleRow({
    label,
    switchLabel,
    description,
    envEnabled,
    paused,
    settingKey,
    resumeConfirmText,
    isAdmin,
}: {
    label: string;
    switchLabel: string;
    description: string;
    envEnabled: boolean;
    paused: boolean;
    settingKey: SettingKey;
    resumeConfirmText: string;
    isAdmin: boolean;
}) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [confirmingResume, setConfirmingResume] = useState(false);

    async function postPause(nextPaused: boolean) {
        setPending(true);
        try {
            const res = await fetch("/api/automation/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: settingKey, paused: nextPaused }),
            });
            const data: { ok: boolean; reason?: string; changed?: boolean } | null = await res.json().catch(() => null);
            if (res.ok && data?.ok) {
                toast.success(
                    data.changed === false ? "Already in that state" : nextPaused ? `${label} paused` : `${label} resumed`
                );
            } else {
                toast.error(`Couldn't update: ${data?.reason || `HTTP ${res.status}`}`);
            }
        } catch {
            toast.error("Couldn't update: network error");
        } finally {
            setPending(false);
            setConfirmingResume(false);
            router.refresh();
        }
    }

    if (!envEnabled) {
        return (
            <div className="flex items-center justify-between py-2 border-b border-hui-border">
                <div>
                    <p className="text-sm font-medium text-hui-textMain">{label}</p>
                    <p className="text-xs text-hui-textMuted">{description}</p>
                </div>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 whitespace-nowrap">
                    Off by deployment
                </span>
            </div>
        );
    }

    const running = !paused;

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-between py-2 border-b border-hui-border">
                <div>
                    <p className="text-sm font-medium text-hui-textMain">{label}</p>
                    <p className="text-xs text-hui-textMuted">{description}</p>
                </div>
                <span className={`text-xs font-semibold whitespace-nowrap ${running ? "text-green-700" : "text-amber-700"}`}>
                    {running ? "Running" : "Paused"}
                </span>
            </div>
        );
    }

    return (
        <div className="py-2 border-b border-hui-border">
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-sm font-medium text-hui-textMain">{label}</p>
                    <p className="text-xs text-hui-textMuted">{description}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs font-semibold ${running ? "text-green-700" : "text-amber-700"}`}>
                        {running ? "Running" : "Paused"}
                    </span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={running}
                        aria-label={`${running ? "Pause" : "Resume"} ${switchLabel}`}
                        aria-expanded={confirmingResume}
                        aria-controls={`${settingKey}-resume-confirm`}
                        disabled={pending}
                        onClick={() => (paused ? setConfirmingResume(true) : postPause(true))}
                        className={`relative w-10 h-5 rounded-full transition disabled:opacity-50 ${running ? "bg-hui-primary" : "bg-slate-300"}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition ${running ? "translate-x-5" : ""}`} />
                    </button>
                </div>
            </div>
            {confirmingResume && (
                <div
                    id={`${settingKey}-resume-confirm`}
                    role="alertdialog"
                    aria-live="polite"
                    aria-label={resumeConfirmText}
                    className="mt-2 flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
                >
                    <p className="text-xs text-amber-800">{resumeConfirmText}</p>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => postPause(false)}
                            disabled={pending}
                            className="hui-btn hui-btn-green text-xs px-2 py-1 disabled:opacity-50"
                        >
                            Confirm
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirmingResume(false)}
                            disabled={pending}
                            className="hui-btn hui-btn-secondary text-xs px-2 py-1 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function PipelineControls({
    pushEnabled,
    syncCronEnabled,
    receiptPushPaused,
    qboSyncPaused,
    isAdmin,
}: {
    pushEnabled: boolean;
    syncCronEnabled: boolean;
    receiptPushPaused: boolean;
    qboSyncPaused: boolean;
    isAdmin: boolean;
}) {
    return (
        <div>
            <ToggleRow
                label="Receipt → QuickBooks push"
                switchLabel="receipt to QuickBooks push"
                description="Receipts drop straight into QuickBooks as they're scanned."
                envEnabled={pushEnabled}
                paused={receiptPushPaused}
                settingKey="receiptPushPaused"
                resumeConfirmText="Resume automatic booking to QuickBooks?"
                isAdmin={isAdmin}
            />
            <ToggleRow
                label="QuickBooks → ProBuild sync (every 4h)"
                switchLabel="QuickBooks to ProBuild sync"
                description="Pulls booked transactions back into ProBuild's job costing."
                envEnabled={syncCronEnabled}
                paused={qboSyncPaused}
                settingKey="qboSyncPaused"
                resumeConfirmText="Resume automatic sync into ProBuild's job costing?"
                isAdmin={isAdmin}
            />
        </div>
    );
}
