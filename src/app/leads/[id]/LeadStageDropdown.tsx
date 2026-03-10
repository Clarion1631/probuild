"use client";

import { useState } from "react";
import { updateLeadStage } from "@/lib/actions";
import { toast } from "sonner";

export default function LeadStageDropdown({ leadId, currentStage, variant = "default" }: { leadId: string, currentStage: string, variant?: "default" | "pill" }) {
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

    const getStageColor = (stage: string) => {
        switch (stage) {
            case 'New': return 'bg-blue-50 text-blue-700 border-blue-200';
            case 'Contacted': return 'bg-purple-50 text-purple-700 border-purple-200';
            case 'Meeting Scheduled': return 'bg-indigo-50 text-indigo-700 border-indigo-200';
            case 'Estimate Sent': return 'bg-amber-50 text-amber-700 border-amber-200';
            case 'Negotiating': return 'bg-orange-50 text-orange-700 border-orange-200';
            case 'Closed Won': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
            case 'Closed Lost': return 'bg-red-50 text-red-700 border-red-200';
            case 'Won': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
            case 'Followed Up': return 'bg-purple-50 text-purple-700 border-purple-200';
            default: return 'bg-slate-50 text-slate-700 border-slate-200';
        }
    };

    if (variant === "pill") {
        return (
            <select
                value={currentStage}
                onChange={handleChange}
                onClick={(e) => e.stopPropagation()}
                disabled={isUpdating}
                className={`cursor-pointer inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold tracking-wide border focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all shadow-sm ${getStageColor(currentStage)} disabled:opacity-50`}
            >
                {stages.map(stage => (
                    <option key={stage} value={stage}>{stage}</option>
                ))}
            </select>
        );
    }

    return (
        <select
            value={currentStage}
            onChange={handleChange}
            onClick={(e) => e.stopPropagation()}
            disabled={isUpdating}
            className="bg-slate-50 border border-slate-200 text-slate-800 text-sm font-medium rounded-md focus:ring-blue-500 focus:border-blue-500 block w-full px-2 py-1.5 outline-none transition disabled:opacity-50"
        >
            {stages.map(stage => (
                <option key={stage} value={stage}>{stage}</option>
            ))}
        </select>
    );
}
