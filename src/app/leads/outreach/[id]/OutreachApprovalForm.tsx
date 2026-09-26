"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
    approveOutreachMessageAction,
    saveOutreachDraftAction,
    sendAgainOutreachMessageAction,
} from "@/lib/actions";

interface Props {
    messageId: string;
    versionId: string;
    leadId: string;
    status: string;
    approvalHash: string;
    approveToken: string;
    draftToken: string;
    sendAgainToken: string;
    initialTo: string;
    initialSubject: string;
    initialBody: string;
    initialFooter: string;
}

export default function OutreachApprovalForm(props: Props) {
    const [to, setTo] = useState(props.initialTo);
    const [subject, setSubject] = useState(props.initialSubject);
    const [body, setBody] = useState(props.initialBody);
    const [footer] = useState(props.initialFooter);
    const [confirmedNotInSent, setConfirmedNotInSent] = useState(false);
    const [pending, startTransition] = useTransition();

    // Approve submits props.versionId/props.approvalHash — computed from the
    // version this page rendered, NOT from whatever is currently typed into
    // the fields below. Without this check, editing To/Subject/Body and then
    // clicking Approve would visibly show the edit while actually approving
    // and sending the ORIGINAL, unedited content — the UI would misrepresent
    // what actually goes out. An edit must be saved (a fresh generation,
    // needing its own fresh approval) before it can ever be approved.
    const hasUnsavedEdits = to !== props.initialTo || subject !== props.initialSubject || body !== props.initialBody;
    const canApprove = (props.status === "PENDING_APPROVAL" || props.status === "DRAFT") && !hasUnsavedEdits;
    const canSendAgain = props.status === "FAILED" || props.status === "UNKNOWN_DELIVERY";

    const onApprove = () => startTransition(async () => {
        if (hasUnsavedEdits) {
            toast.error("Save your edits first — Approve sends the last saved version, not what's on screen.");
            return;
        }
        try {
            await approveOutreachMessageAction({
                messageId: props.messageId, versionId: props.versionId, leadId: props.leadId,
                approvalHash: props.approvalHash, csrfToken: props.approveToken,
            });
            toast.success("Approved and dispatch attempted.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Approve failed");
        }
    });

    const onSaveDraft = () => startTransition(async () => {
        try {
            await saveOutreachDraftAction({
                messageId: props.messageId, to, subject, body, footer, csrfToken: props.draftToken,
            });
            toast.success("Draft saved as a new generation — re-approval required.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Save failed");
        }
    });

    const onSendAgain = () => startTransition(async () => {
        try {
            await sendAgainOutreachMessageAction({
                messageId: props.messageId, to, subject, body, footer,
                confirmedNotInSent, csrfToken: props.sendAgainToken,
            });
            toast.success("New draft created — needs fresh approval.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Send-again failed");
        }
    });

    return (
        <div className="hui-card p-6 space-y-3">
            <label className="block text-sm">
                To
                <input className="hui-input w-full" value={to} onChange={e => setTo(e.target.value)} />
            </label>
            <label className="block text-sm">
                Subject
                <input className="hui-input w-full" value={subject} onChange={e => setSubject(e.target.value)} />
            </label>
            <label className="block text-sm">
                Body
                <textarea className="hui-input w-full" rows={6} value={body} onChange={e => setBody(e.target.value)} />
            </label>

            {hasUnsavedEdits && (props.status === "PENDING_APPROVAL" || props.status === "DRAFT") && (
                <p className="text-xs text-amber-600">You have unsaved edits — save the draft before approving, or Approve would send the last saved version instead of what&apos;s shown here.</p>
            )}
            <div className="flex gap-2 pt-2">
                <button type="button" className="hui-btn hui-btn-secondary" disabled={pending} onClick={onSaveDraft}>
                    Save draft
                </button>
                {canApprove && (
                    <button type="button" className="hui-btn hui-btn-green" disabled={pending} onClick={onApprove}>
                        Approve &amp; send
                    </button>
                )}
                {canSendAgain && (
                    <>
                        {props.status === "UNKNOWN_DELIVERY" && (
                            <label className="text-xs flex items-center gap-1">
                                <input type="checkbox" checked={confirmedNotInSent} onChange={e => setConfirmedNotInSent(e.target.checked)} />
                                Confirmed not in Sent
                            </label>
                        )}
                        <button type="button" className="hui-btn hui-btn-primary" disabled={pending} onClick={onSendAgain}>
                            Send again
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
