"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { RECEIPT_OWNER_CHOICES } from "@/lib/receipt-requests";
import {
    markReceiptIntakeDuplicate,
    resolveOrphanedQbPurchase,
    resolveUncertainCard,
    setMissingReceiptOwner,
    retryReceiptIntake,
    setReceiptIntakeJob,
    unmarkReceiptIntakeDuplicate,
    voidReceiptIntake,
} from "@/lib/actions";

/**
 * The interactive bits of a receipt-queue row — the same "just the button"
 * split as `copy-id-button.tsx` and `mark-reviewed-button.tsx`.
 *
 * Every action's failure is TOLD to the user. The server actions throw a stale
 * error when their compare-and-swap finds 0 rows (the worker moved the row
 * underneath this view), and swallowing that would look exactly like success.
 */

const BTN = "hui-btn hui-btn-secondary text-xs px-2 py-0.5 disabled:opacity-50";

function useAction(successMessage: string) {
    const [pending, startTransition] = useTransition();
    const run = (work: () => Promise<unknown>) => {
        startTransition(async () => {
            try {
                await work();
                toast.success(successMessage);
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "That didn't work — try again");
            }
        });
    };
    return { pending, run };
}

export function SetJobControl({
    intakeId,
    jobs,
    currentProjectId,
    expectedState,
    expectedUpdatedAt,
}: {
    intakeId: string;
    jobs: Array<{ id: string; name: string }>;
    currentProjectId: string | null;
    /** The state this row was RENDERED with — the server CASes on it. */
    expectedState: string;
    /**
     * And the row VERSION it was rendered with. The state alone cannot tell one
     * NEEDS_REVIEW from a later, different NEEDS_REVIEW, so a decision made
     * about the first would otherwise land on the second.
     */
    expectedUpdatedAt: string;
}) {
    const [projectId, setProjectId] = useState(currentProjectId ?? "");
    const { pending, run } = useAction("Job set — the pipeline will pick it up");

    return (
        <div className="flex items-center gap-2 flex-wrap">
            <label className="sr-only" htmlFor={`job-${intakeId}`}>Set job</label>
            <select
                id={`job-${intakeId}`}
                className="hui-input text-xs py-1 max-w-[14rem]"
                value={projectId}
                disabled={pending}
                onChange={event => setProjectId(event.target.value)}
            >
                <option value="">Choose a job…</option>
                {jobs.map(job => (
                    <option key={job.id} value={job.id}>{job.name}</option>
                ))}
            </select>
            <button
                type="button"
                className={BTN}
                disabled={pending || !projectId}
                onClick={() => run(() => setReceiptIntakeJob(intakeId, projectId, expectedState, expectedUpdatedAt))}
            >
                Set job
            </button>
        </div>
    );
}

export function RetryButton({ intakeId, expectedUpdatedAt }: { intakeId: string; expectedUpdatedAt: string }) {
    const { pending, run } = useAction("Queued — the worker retries within 5 minutes");
    return (
        <button type="button" className={BTN} disabled={pending} onClick={() => run(() => retryReceiptIntake(intakeId, expectedUpdatedAt))}>
            Retry now
        </button>
    );
}

export function VoidButton({ intakeId, expectedState, expectedUpdatedAt }: { intakeId: string; expectedState: string; expectedUpdatedAt: string }) {
    const { pending, run } = useAction("Voided");
    return (
        <button
            type="button"
            className={BTN}
            disabled={pending}
            onClick={() => {
                if (!window.confirm("Void this receipt? It stops being processed. A booked receipt can't be voided.")) return;
                run(() => voidReceiptIntake(intakeId, expectedState, expectedUpdatedAt));
            }}
        >
            Void
        </button>
    );
}

export function NotADuplicateButton({ intakeId, expectedUpdatedAt }: { intakeId: string; expectedUpdatedAt: string }) {
    const { pending, run } = useAction("Sent back through routing");
    return (
        <button type="button" className={BTN} disabled={pending} onClick={() => run(() => unmarkReceiptIntakeDuplicate(intakeId, expectedUpdatedAt))}>
            Not a duplicate
        </button>
    );
}

export function MarkDuplicateControl({ intakeId, expectedState, expectedUpdatedAt }: { intakeId: string; expectedState: string; expectedUpdatedAt: string }) {
    const [duplicateOfId, setDuplicateOfId] = useState("");
    const { pending, run } = useAction("Marked as a duplicate");
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <label className="sr-only" htmlFor={`dup-${intakeId}`}>Duplicate of receipt id</label>
            <input
                id={`dup-${intakeId}`}
                className="hui-input text-xs py-1 w-44"
                placeholder="Duplicate of (receipt id)"
                value={duplicateOfId}
                disabled={pending}
                onChange={event => setDuplicateOfId(event.target.value.trim())}
            />
            <button
                type="button"
                className={BTN}
                disabled={pending || !duplicateOfId}
                onClick={() => run(() => markReceiptIntakeDuplicate(intakeId, duplicateOfId, expectedState, expectedUpdatedAt))}
            >
                Mark duplicate
            </button>
        </div>
    );
}

export function ResolveOrphanButton({ intakeId, qbPurchaseId, expectedUpdatedAt }: { intakeId: string; qbPurchaseId: string; expectedUpdatedAt: string }) {
    const [pending, startTransition] = useTransition();
    // This action RETURNS a stale verdict rather than throwing one, so a lost
    // race reads as "refresh", not "that didn't work — try again". Retrying a
    // stale click just loses the same race.
    const run = () => startTransition(async () => {
        try {
            const result = await resolveOrphanedQbPurchase(intakeId, expectedUpdatedAt);
            if (result.success) toast.success("Marked resolved");
            else toast.error(result.reason ?? "This receipt changed underneath you — refresh.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "That didn't work — try again");
        }
    });
    return (
        <button
            type="button"
            className={BTN}
            disabled={pending}
            onClick={() => {
                if (!window.confirm(
                    `Have you voided purchase ${qbPurchaseId} in QuickBooks? This only records that you did — it does not change QuickBooks.`,
                )) return;
                run();
            }}
        >
            Voided in QuickBooks
        </button>
    );
}

export function AssignOwnerControl({ issueId, currentOwner }: { issueId: string; currentOwner: string }) {
    const [owner, setOwner] = useState("");
    const { pending, run } = useAction("Owner set — the card goes out tomorrow morning");
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <label className="sr-only" htmlFor={`owner-${issueId}`}>Whose charge was this?</label>
            <select
                id={`owner-${issueId}`}
                className="hui-input text-xs py-1"
                value={owner}
                disabled={pending}
                onChange={event => setOwner(event.target.value)}
            >
                <option value="">Whose charge?</option>
                {RECEIPT_OWNER_CHOICES.map(name => (
                    <option key={name} value={name}>{name}</option>
                ))}
            </select>
            <button
                type="button"
                className={BTN}
                disabled={pending || !owner || owner === currentOwner}
                onClick={() => run(() => setMissingReceiptOwner(issueId, owner))}
            >
                Assign
            </button>
        </div>
    );
}

export function UncertainCardControls({ cardId, expectedUpdatedAt }: { cardId: string; expectedUpdatedAt: string }) {
    const [pending, startTransition] = useTransition();
    // Like ResolveOrphanButton, this action RETURNS a stale verdict instead of
    // throwing one: a lost race means "somebody already decided", which reads
    // as refresh, not as retry.
    const run = (decision: "delivered" | "resend") => startTransition(async () => {
        try {
            const result = await resolveUncertainCard(cardId, decision, expectedUpdatedAt);
            if (result.success) {
                toast.success(decision === "delivered" ? "Marked delivered" : "Queued for resend");
            } else {
                toast.error(result.reason ?? "That card changed underneath you — refresh.");
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "That didn't work — try again");
        }
    });
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className={BTN} disabled={pending} onClick={() => run("delivered")}>
                It&apos;s there — mark delivered
            </button>
            <button
                type="button"
                className={BTN}
                disabled={pending}
                onClick={() => {
                    if (!window.confirm("Resend this card? Only do this if it is NOT in the space — a duplicate is worse than a late one.")) return;
                    run("resend");
                }}
            >
                Not there — resend
            </button>
        </div>
    );
}
