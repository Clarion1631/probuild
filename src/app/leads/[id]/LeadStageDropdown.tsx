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
            <div className="relative inline-block" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                <select
                    value={currentStage}
                    onChange={handleChange}
                    disabled={isUpdating}
                    className={`appearance-none cursor-pointer inline-flex items-center px-3 py-1.5 pr-8 rounded-full text-xs font-semibold tracking-wide border focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all shadow-sm ${getStageColor(currentStage)} disabled:opacity-50`}
                >
                    {stages.map(stage => (
                        <option key={stage} value={stage}>{stage}</option>
                    ))}
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                    <svg className="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                </div>
            </div>
        );
    }

    return (
        <div className="relative w-full" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <select
                value={currentStage}
                onChange={handleChange}
                disabled={isUpdating}
                className="appearance-none bg-slate-50 border border-slate-200 text-slate-800 text-sm font-medium rounded-md focus:ring-blue-500 focus:border-blue-500 block w-full px-3 py-2 pr-10 outline-none transition disabled:opacity-50"
            >
                {stages.map(stage => (
                    <option key={stage} value={stage}>{stage}</option>
                ))}
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </div>
        </div>
    );
}
