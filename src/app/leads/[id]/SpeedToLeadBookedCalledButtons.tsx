"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import {
    markLeadBookedAction, markLeadCalledAction, markLeadJunkAction, promoteLeadToRealAction,
} from "@/lib/speed-to-lead-actions";

/**
 * Speed-to-Lead (PB-leads-001) v1a: Booked/Called (any active staff) plus
 * Justin-only Junk and Promote.
 */
export default function SpeedToLeadBookedCalledButtons({ leadId, isApprover }: { leadId: string; isApprover: boolean }) {
    const [pending, startTransition] = useTransition();

    const run = (fn: () => Promise<void>, okMessage: string) => startTransition(async () => {
        try {
            await fn();
            toast.success(okMessage);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Action failed");
        }
    });

    return (
        <div className="flex items-center justify-between py-2 border-b border-slate-50">
            <span className="text-sm text-slate-600">Speed-to-Lead</span>
            <div className="flex gap-2">
                <button type="button" className="hui-btn hui-btn-secondary text-xs px-2 py-1" disabled={pending} onClick={() => run(() => markLeadBookedAction(leadId), "Marked Booked")}>
                    Booked
                </button>
                <button type="button" className="hui-btn hui-btn-secondary text-xs px-2 py-1" disabled={pending} onClick={() => run(() => markLeadCalledAction(leadId), "Marked Called")}>
                    Called
                </button>
                {isApprover && (
                    <>
                        <button type="button" className="hui-btn hui-btn-secondary text-xs px-2 py-1" disabled={pending} onClick={() => run(() => promoteLeadToRealAction(leadId), "Promoted to REAL")}>
                            Promote
                        </button>
                        <button type="button" className="hui-btn hui-btn-secondary text-xs px-2 py-1 text-red-600" disabled={pending} onClick={() => run(() => markLeadJunkAction(leadId), "Marked Junk")}>
                            Junk
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
