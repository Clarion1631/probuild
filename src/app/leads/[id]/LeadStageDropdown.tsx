"use client";

import { useState } from "react";
import { updateLeadStage } from "@/lib/actions";
import { toast } from "sonner";

export default function LeadStageDropdown({ leadId, currentStage }: { leadId: string, currentStage: string }) {
    const [isUpdating, setIsUpdating] = useState(false);
    
    const stages = [
        "New", 
        "Contacted", 
        "Meeting Scheduled", 
        "Estimate Sent", 
        "Negotiating", 
        "Closed Won", 
        "Closed Lost"
    ];

    async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const newStage = e.target.value;
        setIsUpdating(true);
        try {
            await updateLeadStage(leadId, newStage);
            toast.success(`Lead stage updated to ${newStage}`);
        } catch (error) {
            toast.error("Failed to update lead stage");
        } finally {
            setIsUpdating(false);
        }
    }

    return (
        <select
            value={currentStage}
            onChange={handleChange}
            disabled={isUpdating}
            className="bg-slate-50 border border-slate-200 text-slate-800 text-sm font-medium rounded-md focus:ring-blue-500 focus:border-blue-500 block w-full px-2 py-1.5 outline-none transition disabled:opacity-50"
        >
            {stages.map(stage => (
                <option key={stage} value={stage}>{stage}</option>
            ))}
        </select>
    );
}
