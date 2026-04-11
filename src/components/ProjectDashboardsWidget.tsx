"use client";

import { useState } from "react";
import ClientDashboardModal from "./ClientDashboardModal";
import SubcontractorAssignmentModal from "./SubcontractorAssignmentModal";

export default function ProjectDashboardsWidget({
    projectId,
    initialPortalVisibility,
    initialSubcontractors,
}: {
    projectId: string;
    initialPortalVisibility: any;
    initialSubcontractors: any[];
}) {
    const [showClientModal, setShowClientModal] = useState(false);
    const [showSubModal, setShowSubModal] = useState(false);

    // If portal visibility is null, maybe defaults are all false, meaning "Not Shared"
    // But since it's created automatically, it's usually defined.
    // Let's just create a shared heuristic (if anything is shared)
    const isShared = initialPortalVisibility && (
        initialPortalVisibility.showSchedule ||
        initialPortalVisibility.showFiles ||
        initialPortalVisibility.showDailyLogs ||
        initialPortalVisibility.showEstimates ||
        initialPortalVisibility.showInvoices ||
        initialPortalVisibility.showContracts ||
        initialPortalVisibility.showMessages
    );

    const defaultState = {
        showSchedule: true,
        showFiles: true,
        showDailyLogs: false,
        showEstimates: true,
        showInvoices: true,
        showContracts: true,
        showMessages: true,
    };

    return (
        <>
            <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden mb-5">
                <div className="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-slate-50/50">
                    <h3 className="font-bold text-foreground">Dashboards</h3>
                </div>
                
                <div className="divide-y divide-slate-100 p-2">
                    {/* Client Dashboard */}
                    <button 
                        onClick={() => setShowClientModal(true)}
                        className="w-full text-left p-4 hover:bg-slate-50 transition-colors group rounded-md cursor-pointer"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <svg className="w-5 h-5 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                                <span className="font-bold text-foreground text-sm">Client Dashboard</span>
                            </div>
                            <svg className="w-4 h-4 text-slate-400 group-hover:text-slate-600 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        </div>
                        <p className="text-[13px] text-muted-foreground mt-1 ml-7">Edit and share project client dashboard</p>
                        
                        <div className="mt-3 ml-7">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${isShared ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${isShared ? "bg-green-500" : "bg-amber-500"}`}></span>
                                {isShared ? "Shared" : "Not Shared"}
                            </span>
                        </div>
                    </button>

                    {/* Subcontractor Dashboard */}
                    <button 
                        onClick={() => setShowSubModal(true)}
                        className="w-full text-left p-4 hover:bg-slate-50 transition-colors group rounded-md cursor-pointer"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <svg className="w-5 h-5 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                                <span className="font-bold text-foreground text-sm">Subcontractor Dashboard</span>
                            </div>
                            <svg className="w-4 h-4 text-slate-400 group-hover:text-slate-600 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        </div>
                        <p className="text-[13px] text-muted-foreground mt-1 ml-7">Start collaborating with your subcontractors</p>
                    </button>
                </div>
            </div>

            {showClientModal && (
                <ClientDashboardModal
                    projectId={projectId}
                    initialState={initialPortalVisibility || defaultState}
                    onClose={() => setShowClientModal(false)}
                />
            )}

            {showSubModal && (
                <SubcontractorAssignmentModal
                    projectId={projectId}
                    initialSubcontractors={initialSubcontractors}
                    onClose={() => setShowSubModal(false)}
                />
            )}
        </>
    );
}
