"use client";

import { useState } from "react";
import { toast } from "sonner";

interface User { id: string; name: string | null; email: string; role: string; }

interface Props {
    isConnected: boolean;
    connectedAt?: string;
    companyId?: string;
    employeeMappings: Record<string, string>;
    users: User[];
    successParam?: string;
    errorParam?: string;
}

export default function GustoClient({
    isConnected,
    connectedAt,
    companyId,
    employeeMappings: initialMappings,
    users,
    successParam,
    errorParam,
}: Props) {
    const [mappings, setMappings] = useState<Record<string, string>>(initialMappings);
    const [saving, setSaving] = useState(false);

    async function handleSaveMappings() {
        setSaving(true);
        try {
            const res = await fetch("/api/gusto/employee-mappings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ employeeMappings: mappings }),
            });
            if (!res.ok) throw new Error("Failed to save");
            toast.success("Employee mappings saved");
        } catch {
            toast.error("Failed to save mappings");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="space-y-6">
            {successParam && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
                    Gusto connected successfully!
                </div>
            )}
            {errorParam && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
                    Connection failed: {decodeURIComponent(errorParam)}
                </div>
            )}

            {/* Connection */}
            <div className="hui-card p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="font-semibold text-hui-textMain text-sm mb-1">Connection Status</div>
                        {isConnected ? (
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                                <span className="text-sm text-green-700 font-medium">Connected</span>
                                {connectedAt && <span className="text-xs text-hui-textMuted">since {new Date(connectedAt).toLocaleDateString()}</span>}
                                {companyId && <span className="text-xs text-hui-textMuted">Company: {companyId}</span>}
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />
                                <span className="text-sm text-hui-textMuted">Not connected</span>
                            </div>
                        )}
                    </div>
                    <a
                        href="/api/gusto/auth"
                        className="hui-btn hui-btn-secondary text-sm"
                        style={isConnected ? {} : { backgroundColor: "#f43f5e", color: "white" }}
                    >
                        {isConnected ? "Reconnect" : "Connect to Gusto"}
                    </a>
                </div>
                {!isConnected && (
                    <p className="text-xs text-hui-textMuted mt-4 pt-4 border-t border-hui-border">
                        Add <code>GUSTO_CLIENT_ID</code> and <code>GUSTO_CLIENT_SECRET</code> to your Vercel environment variables.
                        Get them from the Gusto Developer Portal.
                    </p>
                )}
            </div>

            {/* Employee mapping */}
            <div className="hui-card p-5">
                <div className="mb-4">
                    <h2 className="font-semibold text-hui-textMain text-sm">Employee Mapping</h2>
                    <p className="text-xs text-hui-textMuted mt-1">
                        Map ProBuild team members to their Gusto employee UUID. The UUID appears in your Gusto employee URL.
                    </p>
                </div>

                <div className="space-y-2 mb-5">
                    <div className="grid grid-cols-2 gap-3 text-[10px] font-semibold uppercase tracking-widest text-hui-textMuted px-1">
                        <span>ProBuild Team Member</span>
                        <span>Gusto Employee UUID</span>
                    </div>
                    {users.map((u) => (
                        <div key={u.id} className="grid grid-cols-2 gap-3 items-center">
                            <div className="text-sm text-hui-textMain">
                                {u.name || u.email}
                                <span className="ml-1.5 text-[10px] text-hui-textMuted">{u.role}</span>
                            </div>
                            <input
                                type="text"
                                className="hui-input text-sm font-mono"
                                placeholder="e.g. 7757869450016255"
                                value={mappings[u.id] || ""}
                                onChange={(e) => setMappings(prev => ({ ...prev, [u.id]: e.target.value }))}
                            />
                        </div>
                    ))}
                </div>

                <button
                    onClick={handleSaveMappings}
                    disabled={saving}
                    className="hui-btn text-sm"
                >
                    {saving ? "Saving…" : "Save Mappings"}
                </button>
            </div>

            {/* Export instructions */}
            <div className="hui-card p-5">
                <h2 className="font-semibold text-hui-textMain text-sm mb-3">How Export Works</h2>
                <ul className="space-y-2 text-sm text-hui-textMuted">
                    <li className="flex gap-2">
                        <span className="text-hui-primary mt-0.5">1.</span>
                        <span>Go to <strong>Time &amp; Expenses</strong> and filter for the pay period.</span>
                    </li>
                    <li className="flex gap-2">
                        <span className="text-hui-primary mt-0.5">2.</span>
                        <span>Click <strong>"Export to Gusto"</strong> to download a CSV with employee name, Gusto UUID, hours, date, and project.</span>
                    </li>
                    <li className="flex gap-2">
                        <span className="text-hui-primary mt-0.5">3.</span>
                        <span>Import the CSV in Gusto under <strong>Payroll → Import Hours</strong>.</span>
                    </li>
                </ul>
            </div>
        </div>
    );
}
