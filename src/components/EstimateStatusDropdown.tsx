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
        <select
            value={currentStatus}
            onChange={handleChange}
            disabled={isUpdating}
            className={`cursor-pointer inline-block px-2 text-[10px] font-semibold tracking-wider uppercase border rounded-full focus:outline-none focus:ring-1 focus:ring-blue-500 transition disabled:opacity-50 ${currentStatus === 'Draft' ? 'bg-slate-100 text-slate-800 border-slate-200' : 'bg-green-50 text-green-800 border-green-200'}`}
        >
            {statuses.map(status => (
                <option key={status} value={status}>{status}</option>
            ))}
        </select>
    );
}
