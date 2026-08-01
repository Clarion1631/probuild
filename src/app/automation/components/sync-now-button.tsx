"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface SyncResponse {
    ok: boolean;
    reason?: string;
    imported?: number;
    updated?: number;
    skipped?: number;
    deactivated?: number;
}

export default function SyncNowButton() {
    const [isRunning, setIsRunning] = useState(false);
    const router = useRouter();

    async function handleClick() {
        setIsRunning(true);
        try {
            const res = await fetch("/api/automation/sync-now", { method: "POST" });
            const data: SyncResponse | null = await res.json().catch(() => null);

            if (res.ok && data?.ok) {
                const parts: string[] = [];
                if (typeof data.imported === "number") parts.push(`${data.imported} imported`);
                if (typeof data.updated === "number") parts.push(`${data.updated} updated`);
                if (typeof data.skipped === "number") parts.push(`${data.skipped} skipped`);
                if (typeof data.deactivated === "number") parts.push(`${data.deactivated} deactivated`);
                toast.success(parts.length ? `Sync complete: ${parts.join(", ")}` : "Sync complete");
            } else {
                toast.error(`Sync failed: ${data?.reason || `HTTP ${res.status}`}`);
            }
        } catch {
            toast.error("Sync failed: network error");
        } finally {
            setIsRunning(false);
            router.refresh();
        }
    }

    return (
        <button
            onClick={handleClick}
            disabled={isRunning}
            className="hui-btn hui-btn-green disabled:opacity-50 flex items-center gap-2"
        >
            {isRunning ? (
                <>
                    <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Syncing…
                </>
            ) : (
                "Run sync now"
            )}
        </button>
    );
}
