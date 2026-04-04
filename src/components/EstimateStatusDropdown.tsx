"use client";

import { useState } from "react";
import { updateEstimateStatus } from "@/lib/actions";
import { toast } from "sonner";

const STATUSES = [
    { value: "Draft", color: "bg-slate-100 text-slate-700 border-slate-200" },
    { value: "Sent", color: "bg-amber-50 text-amber-700 border-amber-200" },
    { value: "Viewed", color: "bg-blue-50 text-blue-700 border-blue-200" },
    { value: "Approved", color: "bg-green-50 text-green-700 border-green-200" },
    { value: "Invoiced", color: "bg-indigo-50 text-indigo-700 border-indigo-200" },
    { value: "Paid", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
];

export function getStatusColor(status: string) {
    return STATUSES.find(s => s.value === status)?.color || "bg-slate-100 text-slate-700 border-slate-200";
}

export default function EstimateStatusDropdown({ estimateId, currentStatus, leadId, projectId }: { estimateId: string, currentStatus: string, leadId?: string, projectId?: string }) {
    const [isUpdating, setIsUpdating] = useState(false);

    async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const newStatus = e.target.value;
        setIsUpdating(true);
        try {
            await updateEstimateStatus(estimateId, newStatus, leadId, projectId);
            toast.success(`Status updated to ${newStatus}`);
        } catch {
            toast.error("Failed to update status");
        } finally {
            setIsUpdating(false);
        }
    }

    const colorClass = getStatusColor(currentStatus);

    return (
        <div className="relative inline-block" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <select
                value={currentStatus}
                onChange={handleChange}
                disabled={isUpdating}
                className={`appearance-none cursor-pointer inline-flex items-center px-3 py-1.5 pr-7 text-[10px] font-semibold tracking-wider uppercase border rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition shadow-sm disabled:opacity-50 ${colorClass}`}
            >
                {STATUSES.map(status => (
                    <option key={status.value} value={status.value}>{status.value}</option>
                ))}
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </div>
        </div>
    );
}
