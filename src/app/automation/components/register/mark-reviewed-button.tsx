"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { OpenReviewIssue } from "../../register-data";

/**
 * Row drill-down's "Mark reviewed" action (Unified Money Register plan §5
 * step 9, now wired to step 8's API). Pulled out of `row-drilldown.tsx`
 * (a server component with no I/O of its own) into its own small client
 * component — same "just the interactive bit" split as `copy-id-button.tsx`.
 *
 * `issue` is null when the row has no OPEN review issue at all (nothing to
 * review); `issue.acknowledged` is true when everything the issue currently
 * flags has already been acknowledged. Both cases render the same disabled
 * "Reviewed ✓" state — there's nothing left for this button to do.
 */
export default function MarkReviewedButton({ issue }: { issue: OpenReviewIssue | null }) {
    const [acknowledged, setAcknowledged] = useState(issue?.acknowledged ?? false);
    const [pending, setPending] = useState(false);

    const nothingToReview = !issue || acknowledged;

    async function markReviewed() {
        if (!issue) return;
        setPending(true);
        try {
            const res = await fetch("/api/automation/review-issues/mark-reviewed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: issue.id, version: issue.version, reasonHash: issue.reasonHash }),
            });
            if (res.ok) {
                setAcknowledged(true);
                toast.success("Marked reviewed");
            } else if (res.status === 409) {
                toast.error("Someone updated this issue — refresh the page");
            } else {
                toast.error("Couldn't mark reviewed — try again");
            }
        } catch {
            toast.error("Couldn't mark reviewed — try again");
        } finally {
            setPending(false);
        }
    }

    return (
        <button
            type="button"
            onClick={markReviewed}
            disabled={nothingToReview || pending}
            title={nothingToReview ? "Nothing awaiting review" : undefined}
            className="hui-btn hui-btn-secondary text-xs px-2 py-0.5 disabled:opacity-50"
        >
            {nothingToReview ? "Reviewed ✓" : "Mark reviewed"}
        </button>
    );
}
