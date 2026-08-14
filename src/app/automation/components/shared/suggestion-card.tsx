"use client";

import { toast } from "sonner";
import type { FixSuggestion } from "@/lib/automation-suggestions";

export function SuggestionCard({ suggestion }: { suggestion: FixSuggestion }) {
    async function copyPrompt() {
        try {
            await navigator.clipboard.writeText(suggestion.aiPrompt);
            toast.success("Prompt copied — paste it to Claude");
        } catch {
            toast.error("Couldn't copy — select and copy manually");
        }
    }

    return (
        <div className="hui-card p-4 bg-slate-50">
            <h4 className="text-sm font-semibold text-hui-textMain mb-2">Why it stopped + how to fix</h4>
            <p className="text-sm text-hui-textMain">{suggestion.diagnosis}</p>
            {suggestion.manualFix && (
                <p className="text-sm text-hui-textMuted mt-2">
                    <span className="font-medium text-hui-textMain">Quick fix: </span>
                    {suggestion.manualFix}
                </p>
            )}
            <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Prompt for Claude</span>
                    <button onClick={copyPrompt} className="hui-btn hui-btn-secondary text-xs px-2 py-1">
                        Copy
                    </button>
                </div>
                <pre className="text-xs bg-white border border-hui-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                    {suggestion.aiPrompt}
                </pre>
            </div>
        </div>
    );
}
