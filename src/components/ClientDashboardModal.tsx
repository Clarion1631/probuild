"use client";

import { useState, useTransition } from "react";
import { savePortalVisibility, emailPortalLinkToClient, checkPortalEmailStatus } from "@/lib/actions";
import { useEffect } from "react";

type VisibilityState = {
    showSchedule: boolean;
    showFiles: boolean;
    showDailyLogs: boolean;
    showEstimates: boolean;
    showInvoices: boolean;
    showContracts: boolean;
    showMessages: boolean;
    isPortalEnabled: boolean;
    lastSharedAt?: Date | null;
    lastShareEmailId?: string | null;
    lastShareEmailStatus?: string | null;
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
    const [emailStatus, setEmailStatus] = useState<string | null>(initialState.lastShareEmailStatus || null);
    const [isEmailing, setIsEmailing] = useState(false);
    const portalUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/portal/projects/${projectId}`;

    useEffect(() => {
        if (initialState.lastShareEmailId) {
            checkPortalEmailStatus(projectId).then(status => {
                if (status) setEmailStatus(status);
            });
        }
    }, [projectId, initialState.lastShareEmailId]);

    const handleToggle = (key: keyof VisibilityState) => {
        setState((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    const handleEmailLink = async () => {
        setIsEmailing(true);
        setMessage("");
        const res = await emailPortalLinkToClient(projectId);
        if (res.success) {
            setMessage("Email sent to client successfully!");
            setEmailStatus("delivered"); // optimistic
        } else {
            setMessage(res.error || "Failed to send email");
        }
        setIsEmailing(false);
        setTimeout(() => setMessage(""), 5000);
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
                        <div className="flex items-center justify-between mb-4">
                            <label className="text-sm font-semibold text-foreground">Enable Client Dashboard</label>
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
                        
                        {state.isPortalEnabled ? (
                            <div className="space-y-3">
                                <label className="block text-sm font-semibold text-foreground mb-1">Shareable Link</label>
                                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                                    <input 
                                        type="text" 
                                        readOnly 
                                        value={portalUrl}
                                        className="hui-input flex-1 bg-slate-50 text-slate-500 font-mono text-sm"
                                    />
                                    <div className="flex gap-2 shrink-0">
                                        <button onClick={copyToClipboard} className="hui-btn hui-btn-secondary">
                                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                            Copy Link
                                        </button>
                                        <button onClick={handleEmailLink} disabled={isEmailing} className="hui-btn bg-slate-800 hover:bg-slate-900 text-white border-transparent">
                                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                                            {isEmailing ? "Sending..." : "Email Link"}
                                        </button>
                                    </div>
                                </div>
                                {(initialState.lastSharedAt || emailStatus) && (
                                    <p className="text-xs text-muted-foreground pt-1 flex items-center gap-1.5">
                                        Last emailed: {initialState.lastSharedAt ? new Date(initialState.lastSharedAt).toLocaleDateString() : 'Recently'}
                                        <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider ${
                                            emailStatus === 'opened' || emailStatus === 'clicked' ? 'bg-green-100 text-green-700' : 
                                            emailStatus === 'bounced' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                                        }`}>
                                            {emailStatus || "Delivered"}
                                        </span>
                                    </p>
                                )}
                            </div>
                        ) : (
                            <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-4 flex items-center gap-3">
                                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                Client dashboard is currently disabled. Clients will see an "Access Suspended" page if they attempt to load the portal.
                            </div>
                        )}
                    </div>

                    <div className={`border-t border-border pt-6 transition-opacity duration-300 ${!state.isPortalEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
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
