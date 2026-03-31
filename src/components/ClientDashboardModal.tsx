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
};

const TOGGLE_CONFIG: { key: keyof VisibilityState; label: string; description: string }[] = [
    { key: "showEstimates", label: "Estimates & Proposals", description: "Client can view shared estimates and approve them" },
    { key: "showInvoices", label: "Invoices & Payments", description: "Client can view invoices and make payments" },
    { key: "showContracts", label: "Contracts", description: "Client can view and sign contracts" },
    { key: "showSchedule", label: "Schedule", description: "Client can view the project schedule timeline" },
    { key: "showFiles", label: "Files & Documents", description: "Client can browse project files and documents" },
    { key: "showDailyLogs", label: "Daily Logs", description: "Client can view daily project logs and notes" },
    { key: "showMessages", label: "Messages", description: "Client can send and receive messages" },
];

export default function ClientDashboardModal({
    projectId,
    initialState,
    onClose,
}: {
    projectId: string;
    initialState: VisibilityState;
    onClose: () => void;
}) {
    const [state, setState] = useState<VisibilityState>(initialState);
    const [isPending, startTransition] = useTransition();
    const [message, setMessage] = useState("");
    const portalUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/portal/projects/${projectId}`;

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

    const copyToClipboard = () => {
        navigator.clipboard.writeText(portalUrl);
        setMessage("Link copied!");
        setTimeout(() => setMessage(""), 3000);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold text-foreground">Client Dashboard</h2>
                        <p className="text-sm text-muted-foreground mt-1">Configure what your client can see and share the link.</p>
                    </div>
                    <button 
                        onClick={onClose}
                        className="p-2 hover:bg-slate-100 rounded-lg text-muted-foreground transition"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 overflow-y-auto flex-1 space-y-6">
                    
                    {/* Share Link Row */}
                    <div>
                        <label className="block text-sm font-semibold text-foreground mb-2">Shareable Link</label>
                        <div className="flex items-center gap-2">
                            <input 
                                type="text" 
                                readOnly 
                                value={portalUrl}
                                className="hui-input flex-1 bg-slate-50 text-slate-500 font-mono text-sm"
                            />
                            <button onClick={copyToClipboard} className="hui-btn hui-btn-secondary shrink-0">
                                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                Copy Link
                            </button>
                        </div>
                    </div>

                    <div className="border-t border-border pt-6">
                        <h3 className="text-sm font-semibold text-foreground mb-4">Visibility Settings</h3>
                        <div className="space-y-1">
                            {TOGGLE_CONFIG.map((toggle) => (
                                <label
                                    key={toggle.key}
                                    className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 transition cursor-pointer group"
                                >
                                    <div className="flex-1 pr-4">
                                        <div className="font-medium text-foreground text-sm">
                                            {toggle.label}
                                        </div>
                                        <div className="text-xs text-muted-foreground mt-0.5">
                                            {toggle.description}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={state[toggle.key]}
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
                    </div>

                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-border bg-slate-50 flex items-center justify-end gap-3">
                    {message && (
                        <span className={`text-sm font-medium mr-auto ${message.includes("Failed") ? "text-red-500" : "text-green-600"}`}>
                            {message}
                        </span>
                    )}
                    <button onClick={onClose} className="hui-btn hui-btn-secondary">Close</button>
                    <button onClick={handleSave} disabled={isPending} className="hui-btn hui-btn-primary">
                        {isPending ? "Saving..." : "Save Settings"}
                    </button>
                </div>
            </div>
        </div>
    );
}
