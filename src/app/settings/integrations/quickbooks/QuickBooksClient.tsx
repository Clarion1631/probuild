"use client";

import { useState } from "react";
import { toast } from "sonner";
import Link from "next/link";

interface CostCode { id: string; code: string; name: string; }

interface Props {
    isConnected: boolean;
    connectedAt?: string;
    realmId?: string;
    glMappings: Record<string, string>;
    costCodes: CostCode[];
    successParam?: string;
    errorParam?: string;
}

export default function QuickBooksClient({
    isConnected,
    connectedAt,
    realmId,
    glMappings: initialMappings,
    costCodes,
    successParam,
    errorParam,
}: Props) {
    const [mappings, setMappings] = useState<Record<string, string>>(initialMappings);
    const [saving, setSaving] = useState(false);

    async function handleSaveMappings() {
        setSaving(true);
        try {
            const res = await fetch("/api/quickbooks/gl-mappings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ glMappings: mappings }),
            });
            if (!res.ok) throw new Error("Failed to save");
            toast.success("GL mappings saved");
        } catch {
            toast.error("Failed to save mappings");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="space-y-6">
            {/* Status banner */}
            {successParam && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
                    QuickBooks connected successfully!
                </div>
            )}
            {errorParam && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
                    Connection failed: {decodeURIComponent(errorParam)}
                </div>
            )}

            {/* Connection status */}
            <div className="hui-card p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="font-semibold text-hui-textMain text-sm mb-1">Connection Status</div>
                        {isConnected ? (
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                                <span className="text-sm text-green-700 font-medium">Connected</span>
                                {connectedAt && (
                                    <span className="text-xs text-hui-textMuted">
                                        since {new Date(connectedAt).toLocaleDateString()}
                                    </span>
                                )}
                                {realmId && (
                                    <span className="text-xs text-hui-textMuted">Realm: {realmId}</span>
                                )}
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />
                                <span className="text-sm text-hui-textMuted">Not connected</span>
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {isConnected ? (
                            <a
                                href="/api/quickbooks/auth"
                                className="hui-btn hui-btn-secondary text-sm"
                            >
                                Reconnect
                            </a>
                        ) : (
                            <a
                                href="/api/quickbooks/auth"
                                className="hui-btn text-sm"
                                style={{ backgroundColor: "#2CA01C", color: "white" }}
                            >
                                Connect to QuickBooks
                            </a>
                        )}
                    </div>
                </div>

                {!isConnected && (
                    <div className="mt-4 pt-4 border-t border-hui-border">
                        <p className="text-xs text-hui-textMuted">
                            <strong>Setup required:</strong> Add <code>QB_CLIENT_ID</code> and <code>QB_CLIENT_SECRET</code> to your Vercel environment variables.{" "}
                            Get them from{" "}
                            <a
                                href="https://developer.intuit.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-hui-primary underline"
                            >
                                developer.intuit.com
                            </a>.
                        </p>
                    </div>
                )}
            </div>

            {/* GL Account Mapping */}
            <div className="hui-card p-5">
                <div className="mb-4">
                    <h2 className="font-semibold text-hui-textMain text-sm">GL Account Mapping</h2>
                    <p className="text-xs text-hui-textMuted mt-1">
                        Map each ProBuild cost code to a QuickBooks GL account name. This determines how expenses sync to your chart of accounts.
                    </p>
                </div>

                <div className="space-y-2 mb-5">
                    <div className="grid grid-cols-2 gap-3 text-[10px] font-semibold uppercase tracking-widest text-hui-textMuted px-1">
                        <span>ProBuild Cost Code</span>
                        <span>QuickBooks GL Account</span>
                    </div>

                    {costCodes.length === 0 && (
                        <p className="text-sm text-hui-textMuted py-4 text-center">
                            No cost codes configured yet. Add them in{" "}
                            <Link href="/settings/cost-codes" className="text-hui-primary underline">Cost Codes</Link>.
                        </p>
                    )}

                    {costCodes.map((cc) => (
                        <div key={cc.id} className="grid grid-cols-2 gap-3 items-center">
                            <div className="text-sm text-hui-textMain">
                                <span className="text-xs font-mono text-hui-textMuted mr-1.5">{cc.code}</span>
                                {cc.name}
                            </div>
                            <input
                                type="text"
                                className="hui-input text-sm"
                                placeholder="e.g. Lumber & Building Materials"
                                value={mappings[cc.id] || ""}
                                onChange={(e) => setMappings(prev => ({ ...prev, [cc.id]: e.target.value }))}
                            />
                        </div>
                    ))}
                </div>

                <button
                    onClick={handleSaveMappings}
                    disabled={saving || !isConnected}
                    className="hui-btn text-sm"
                >
                    {saving ? "Saving…" : "Save Mappings"}
                </button>
                {!isConnected && (
                    <p className="text-xs text-hui-textMuted mt-2">Connect to QuickBooks before saving mappings.</p>
                )}
            </div>

            {/* How it works */}
            <div className="hui-card p-5">
                <h2 className="font-semibold text-hui-textMain text-sm mb-3">How Sync Works</h2>
                <ul className="space-y-2 text-sm text-hui-textMuted">
                    <li className="flex gap-2">
                        <span className="text-hui-primary mt-0.5">→</span>
                        <span><strong>Estimates:</strong> Push approved estimates from ProBuild to QB as Estimates. Open the estimate and click "Sync to QuickBooks".</span>
                    </li>
                    <li className="flex gap-2">
                        <span className="text-hui-primary mt-0.5">→</span>
                        <span><strong>Invoices:</strong> Push issued invoices to QB as Invoices. Open an invoice and click "Sync to QuickBooks".</span>
                    </li>
                    <li className="flex gap-2">
                        <span className="text-hui-primary mt-0.5">→</span>
                        <span><strong>GL codes:</strong> Each line item syncs to the GL account you mapped above. Unmapped items go to "Other Income".</span>
                    </li>
                </ul>
            </div>
        </div>
    );
}
