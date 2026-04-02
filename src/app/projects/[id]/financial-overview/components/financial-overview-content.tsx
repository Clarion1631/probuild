"use client";

import { useState, useEffect } from "react";
import CashFlowCard from "./cash-flow-card";
import IncomingPaymentsCard from "./incoming-payments-card";
import OutgoingPaymentsCard from "./outgoing-payments-card";
import CashFlowTrackerChart from "./cash-flow-tracker-chart";
import FinancialItemsSection from "./financial-items-section";

// Basic switch replacement
const Switch = ({ checked, onCheckedChange, id }: any) => (
    <div onClick={() => onCheckedChange(!checked)} className={`w-9 h-5 flex items-center rounded-full p-1 cursor-pointer transition-colors ${checked ? 'bg-black' : 'bg-gray-200'}`}>
        <div className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </div>
);
const Skeleton = ({ className }: { className?: string }) => <div className={`animate-pulse rounded-md bg-slate-200 ${className}`} />;

export default function FinancialOverviewContent({ projectId, projectName }: { projectId: string; projectName: string }) {
    const [includeUnissued, setIncludeUnissued] = useState(false);
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        fetch(`/api/projects/${projectId}/financial-overview?includeUnissued=${includeUnissued}`)
            .then(res => res.json())
            .then(resData => {
                setData(resData);
                setLoading(false);
            })
            .catch(err => {
                console.error(err);
                setLoading(false);
            });
    }, [projectId, includeUnissued]);

    if (loading && !data) {
        return (
            <div className="flex-1 w-full p-8 max-w-7xl mx-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <Skeleton className="h-64" />
                    <Skeleton className="h-64" />
                    <Skeleton className="h-64" />
                </div>
            </div>
        );
    }

    if (!data || data.error) return <div className="p-8 text-red-500">Failed to load data</div>;

    return (
        <div className="p-8 max-w-7xl mx-auto w-full">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-semibold text-gray-900">Financial Overview</h1>
                <div className="flex items-center space-x-2 bg-white rounded-lg px-3 py-1.5 border border-gray-200">
                    <label htmlFor="unissued-toggle" className="text-sm text-gray-600 font-medium">
                        Include unissued documents
                    </label>
                    <Switch
                        id="unissued-toggle"
                        checked={includeUnissued}
                        onCheckedChange={setIncludeUnissued}
                    />
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
                <CashFlowCard cashFlow={data.cashFlow} />
                <IncomingPaymentsCard projectId={projectId} incoming={data.incomingPayments} />
                <OutgoingPaymentsCard projectId={projectId} outgoing={data.outgoingPayments} />
            </div>

            <div className="mb-8 p-4 bg-white border border-gray-200 rounded-xl">
                <h2 className="text-lg font-semibold mb-4 ml-2">Cash Flow Tracker</h2>
                <CashFlowTrackerChart timeline={data.cashFlowTimeline} />
            </div>

            <FinancialItemsSection projectId={projectId} data={data} />
        </div>
    );
}
