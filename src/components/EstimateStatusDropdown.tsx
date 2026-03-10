"use client";

import { useState } from "react";
import { updateEstimateStatus } from "@/lib/actions";
import { toast } from "sonner";

export default function EstimateStatusDropdown({ estimateId, currentStatus, leadId, projectId }: { estimateId: string, currentStatus: string, leadId?: string, projectId?: string }) {
    const [isUpdating, setIsUpdating] = useState(false);
    
    const statuses = [
        "Draft", 
        "Pending", 
        "Approved", 
        "Rejected"
    ];

    async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const newStatus = e.target.value;
        setIsUpdating(true);
        try {
            await updateEstimateStatus(estimateId, newStatus, leadId, projectId);
            toast.success(`Estimate status updated to ${newStatus}`);
        } catch (error) {
            toast.error("Failed to update estimate status");
        } finally {
            setIsUpdating(false);
        }
    }

    return (
        <div className="relative inline-block" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <select
                value={currentStatus}
                onChange={handleChange}
                disabled={isUpdating}
                className={`appearance-none cursor-pointer inline-flex items-center px-3 py-1.5 pr-7 text-[10px] font-semibold tracking-wider uppercase border rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition shadow-sm disabled:opacity-50 ${currentStatus === 'Draft' ? 'bg-slate-100 text-slate-800 border-slate-200' : 'bg-green-50 text-green-800 border-green-200'}`}
            >
                {statuses.map(status => (
                    <option key={status} value={status}>{status}</option>
                ))}
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </div>
        </div>
    );
}
