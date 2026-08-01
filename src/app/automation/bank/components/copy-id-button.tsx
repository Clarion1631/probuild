"use client";

import { toast } from "sonner";

export default function CopyIdButton({ value, label }: { value: string; label?: string }) {
    async function copyId() {
        try {
            await navigator.clipboard.writeText(value);
            toast.success(`${label ?? "ID"} copied`);
        } catch {
            toast.error("Couldn't copy — select and copy manually");
        }
    }

    return (
        <button type="button" onClick={copyId} className="hui-btn hui-btn-secondary text-xs px-2 py-0.5">
            Copy ID
        </button>
    );
}
