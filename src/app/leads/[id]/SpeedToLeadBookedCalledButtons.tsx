"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { markOutreachLeadBookedAction, markOutreachLeadCalledAction } from "@/lib/actions";

/**
 * Speed-to-Lead (PB-leads-001) Goal 8: "Manual Booked and Called buttons,
 * and reminders to Justin." The Server Actions existed with no button
 * anywhere calling them — this is that button.
 */
export default function SpeedToLeadBookedCalledButtons({ leadId }: { leadId: string }) {
    const [pending, startTransition] = useTransition();

    const onBooked = () => startTransition(async () => {
        try {
            await markOutreachLeadBookedAction(leadId);
            toast.success("Marked Booked — pending outreach for this lead is cancelled.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to mark Booked");
        }
    });

    const onCalled = () => startTransition(async () => {
        try {
            await markOutreachLeadCalledAction(leadId);
            toast.success("Marked Called — pending outreach for this lead is cancelled.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to mark Called");
        }
    });

    return (
        <div className="flex items-center justify-between py-2 border-b border-slate-50">
            <span className="text-sm text-slate-600">Speed-to-Lead</span>
            <div className="flex gap-2">
                <button type="button" className="hui-btn hui-btn-secondary text-xs px-2 py-1" disabled={pending} onClick={onBooked}>
                    Booked
                </button>
                <button type="button" className="hui-btn hui-btn-secondary text-xs px-2 py-1" disabled={pending} onClick={onCalled}>
                    Called
                </button>
            </div>
        </div>
    );
}
