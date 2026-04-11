"use client";

import { useState, useTransition } from "react";
import { savePortalVisibility } from "@/lib/actions";

type VisibilityState = {
    showSchedule: boolean;
    showFiles: boolean;
    showDailyLogs: boolean;
    showEstimates: boolean;
    showInvoices: boolean;
    showContracts: boolean;
    showMessages: boolean;
    showSelections?: boolean;
    showMoodBoards?: boolean;
    isPortalEnabled: boolean;
    lastSharedAt?: Date | null;
    lastShareEmailId?: string | null;
    lastShareEmailStatus?: string | null;
};

const TOGGLE_CONFIG: { key: keyof VisibilityState; label: string; description: string }[] = [
    { key: "showEstimates", label: "Estimates & Proposals", description: "Client can view shared estimates and approve them" },
    { key: "showInvoices", label: "Invoices & Payments", description: "Client can view invoices and make payments" },
    { key: "showContracts", label: "Contracts", description: "Client can view and sign contracts" },
    { key: "showSelections", label: "Selection Boards", description: "Client can view and approve selection items" },
    { key: "showMoodBoards", label: "Visual Mood Boards", description: "Client can view visual design layouts" },
    { key: "showSchedule", label: "Schedule", description: "Client can view the project schedule timeline" },
    { key: "showFiles", label: "Files & Documents", description: "Client can browse project files and documents" },
    { key: "showDailyLogs", label: "Daily Logs", description: "Client can view daily project logs and notes" },
    { key: "showMessages", label: "Messages", description: "Client can send and receive messages" },
];

export default function PortalVisibilityToggles({
    projectId,
    initialState,
}: {
    projectId: string;
    initialState: VisibilityState;
}) {
    const [state, setState] = useState<VisibilityState>(initialState);
    const [isPending, startTransition] = useTransition();
    const [message, setMessage] = useState("");

    const handleToggle = (key: keyof VisibilityState) => {
        setState((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    const handleSave = () => {
        startTransition(async () => {
            try {
                await savePortalVisibility(projectId, state);
                setMessage("Visibility settings saved!");
                setTimeout(() => setMessage(""), 3000);
            } catch {
                setMessage("Failed to save settings");
                setTimeout(() => setMessage(""), 3000);
            }
        });
    };

    return (
        <div>
            <div className="flex items-center justify-between p-4 bg-slate-50 border border-slate-200 rounded-lg mb-6">
                <div>
                    <h3 className="font-semibold text-hui-textMain">Enable Client Dashboard</h3>
                    <p className="text-sm text-hui-textMuted mt-0.5">Toggle whether the client can access the portal at all. If disabled, they will see an access suspended message.</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={state.isPortalEnabled}
                    onClick={() => handleToggle('isPortalEnabled')}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-hui-primary focus:ring-offset-2 ${
                        state.isPortalEnabled ? "bg-hui-primary" : "bg-slate-300"
                    }`}
                >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
                        state.isPortalEnabled ? "translate-x-6" : "translate-x-1"
                    }`} />
                </button>
            </div>

            <div className={`space-y-1 transition-opacity duration-300 ${!state.isPortalEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                {TOGGLE_CONFIG.map((toggle) => (
                    <label
                        key={toggle.key}
                        className="flex items-center justify-between p-4 rounded-lg hover:bg-slate-50 transition cursor-pointer group"
                    >
                        <div className="flex-1 pr-4">
                            <div className="font-medium text-hui-textMain text-sm">
                                {toggle.label}
                            </div>
                            <div className="text-xs text-hui-textMuted mt-0.5">
                                {toggle.description}
                            </div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={!!state[toggle.key]}
                            onClick={() => handleToggle(toggle.key)}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-hui-primary focus:ring-offset-2 ${
                                state[toggle.key]
                                    ? "bg-hui-primary"
                                    : "bg-slate-300"
                            }`}
                        >
                            <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
                                    state[toggle.key]
                                        ? "translate-x-6"
                                        : "translate-x-1"
                                }`}
                            />
                        </button>
                    </label>
                ))}
            </div>

            <div className="flex items-center gap-4 mt-6 pt-4 border-t border-hui-border">
                <button
                    onClick={handleSave}
                    disabled={isPending}
                    className="hui-btn hui-btn-primary"
                >
                    {isPending ? "Saving..." : "Save Settings"}
                </button>
                {message && (
                    <span
                        className={`text-sm font-medium ${
                            message.includes("saved")
                                ? "text-green-600"
                                : "text-red-600"
                        }`}
                    >
                        {message}
                    </span>
                )}
            </div>
        </div>
    );
}
