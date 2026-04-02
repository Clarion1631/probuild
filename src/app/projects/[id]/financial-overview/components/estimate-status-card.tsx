"use client";

import { Card } from "@/components/ui/card";
import { useRouter } from "next/navigation";

export default function EstimateStatusCard({ projectId, estimates }: { projectId: string; estimates: any }) {
    const router = useRouter();
    const formatCurrency = (val: number) => 
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val || 0);

    return (
        <Card className="flex flex-col border-gray-200 bg-white h-full shadow-sm">
            <div className="p-5 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                <h3 className="font-semibold text-gray-900">
                    Estimate Status
                </h3>
                <button 
                    onClick={() => router.push(`/projects/${projectId}/estimates?status=open`)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-800 transition"
                >
                    Open Estimates
                </button>
            </div>
            <div className="p-5 flex-1 flex items-center justify-between">
                <div>
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Pending Approval</p>
                    <p className="text-2xl font-bold text-gray-900">{formatCurrency(estimates.pendingApproval.totalAmount)}</p>
                    <p className="text-xs text-gray-500 mt-1">{estimates.pendingApproval.count} Items</p>
                </div>
                <div className="w-px h-12 bg-gray-200 shrink-0 mx-2"></div>
                <div className="text-right">
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Uninvoiced</p>
                    <p className="text-2xl font-bold text-gray-900">{formatCurrency(estimates.uninvoiced.totalAmount)}</p>
                    <p className="text-xs text-gray-500 mt-1">{estimates.uninvoiced.count} Items</p>
                </div>
            </div>
        </Card>
    );
}
