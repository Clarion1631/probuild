"use client";

import TimeLoggedCard from "./time-logged-card";
import UninvoicedItemsCard from "./uninvoiced-items-card";
import EstimateStatusCard from "./estimate-status-card";

export default function FinancialItemsSection({ projectId, data }: { projectId: string; data: any }) {
    return (
        <div>
            <h2 className="text-xl font-bold text-gray-900 mb-6">Financial Items</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <TimeLoggedCard projectId={projectId} timeLogged={data.timeLogged} />
                <UninvoicedItemsCard projectId={projectId} uninvoiced={data.uninvoicedItems} />
                <EstimateStatusCard projectId={projectId} estimates={data.estimateStatus} />
            </div>
        </div>
    );
}
