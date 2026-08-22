"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmBankImageMatch } from "@/lib/actions";

/**
 * The explicit human "yes" for a check-image → bank-line pairing. Clicking
 * this is the ONLY path that writes BankImageMatch (via the
 * confirmBankImageMatch server action) — everything else on the panel is a
 * suggestion. Same "just the interactive bit" split as
 * mark-reviewed-button.tsx.
 */
export default function ConfirmMatchButton({
    bankImageId,
    bankLineId,
    note,
}: {
    bankImageId: string;
    bankLineId: string;
    /** The proposal's plain-language reason — stored on the match as the audit trail. */
    note: string | null;
}) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [done, setDone] = useState(false);

    async function confirm() {
        setPending(true);
        try {
            const res = await confirmBankImageMatch({ bankImageId, bankLineId, note });
            if (res.success) {
                setDone(true);
                toast.success("Match confirmed");
                router.refresh();
            } else {
                toast.error(res.error || "Couldn't confirm — try again");
            }
        } catch {
            toast.error("Couldn't confirm — try again");
        } finally {
            setPending(false);
        }
    }

    return (
        <button
            type="button"
            onClick={confirm}
            disabled={pending || done}
            title="Record that a human confirmed this image explains this bank line"
            className="hui-btn hui-btn-secondary text-xs px-2 py-0.5 disabled:opacity-50"
        >
            {done ? "Confirmed ✓" : pending ? "Confirming..." : "Confirm match"}
        </button>
    );
}
