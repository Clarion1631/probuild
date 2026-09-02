"use client";

// Lock / unlock / settle controls for the payroll review page.
//
// These were inline server-action <form> elements, which DISCARD whatever the
// action returns — so "that period is already locked", "the hours changed since
// you loaded this page" and every other refusal was computed, returned, and
// thrown away, leaving a button that looked like it had worked. They are a
// client component now purely so the result is shown.
//
// The lock also carries the exportHash the page rendered, which is what binds
// the lock to the numbers a human actually reviewed rather than to whatever the
// period happens to contain at click time.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { lockPayrollPeriod, settleDeferredDaysForPeriod, unlockPayrollPeriod } from "@/lib/actions";

type Props = {
    startKey: string;
    endKeyExclusive: string;
    /** The hash of the export as rendered on THIS page — what the reviewer saw. */
    reviewedExportHash: string;
    locked: boolean;
    /** Only an exact locked period can be unlocked, and only by an admin. */
    canUnlock: boolean;
    blocked: boolean;
    deferredCount: number;
};

export default function PayrollLockControls({
    startKey,
    endKeyExclusive,
    reviewedExportHash,
    locked,
    canUnlock,
    blocked,
    deferredCount,
}: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState(false);

    const run = async (label: string, action: () => Promise<{ success: boolean; error?: string }>) => {
        setBusy(true);
        try {
            const result = await action();
            if (result.success) {
                toast.success(label);
                // The page is server-rendered from the database; refresh so the
                // badge, the hash comparison and the buttons all agree again.
                startTransition(() => router.refresh());
            } else {
                // The whole reason this is a client component.
                toast.error(result.error ?? "That didn't work.");
            }
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "That didn't work.");
        } finally {
            setBusy(false);
        }
    };

    const disabled = busy || pending;

    return (
        <div className="flex items-center gap-2">
            {deferredCount > 0 && !locked && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                        run("Deferred meal days settled.", () =>
                            settleDeferredDaysForPeriod(startKey, endKeyExclusive)
                        )
                    }
                    className="hui-btn hui-btn-secondary text-sm disabled:opacity-40"
                >
                    Settle {deferredCount} deferred meal {deferredCount === 1 ? "day" : "days"}
                </button>
            )}

            {locked ? (
                canUnlock ? (
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                            run("Period unlocked.", () => unlockPayrollPeriod(startKey, endKeyExclusive))
                        }
                        className="hui-btn hui-btn-secondary text-sm disabled:opacity-40"
                    >
                        Unlock period
                    </button>
                ) : (
                    <span className="text-xs text-hui-textMuted">
                        Only an admin can unlock the period itself
                    </span>
                )
            ) : (
                <button
                    type="button"
                    disabled={disabled || blocked}
                    title={
                        blocked
                            ? "Clear the blocking entries first"
                            : "Locks the numbers shown on this page"
                    }
                    onClick={() =>
                        run("Period locked.", () =>
                            lockPayrollPeriod(startKey, endKeyExclusive, reviewedExportHash)
                        )
                    }
                    className="hui-btn hui-btn-primary text-sm disabled:opacity-40"
                >
                    {busy ? "Locking..." : "Lock period"}
                </button>
            )}
        </div>
    );
}
