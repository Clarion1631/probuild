"use client";

import Avatar from "@/components/Avatar";
import { getLeads } from "@/lib/actions";
import Link from "next/link";
import AddLeadButton from "./AddLeadButton";
import LeadStageDropdown from "./[id]/LeadStageDropdown";
import { useEffect, useState } from "react";
import KanbanBoard from "./KanbanBoard";

export default function LeadsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
    const [view, setView] = useState('table');
    const [leads, setLeads] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        searchParams.then(params => {
            if (params.view) setView(params.view);
            else {
                const savedView = localStorage.getItem('leadsView');
                if (savedView) setView(savedView);
            }
        });
        
        getLeads().then(data => {
            setLeads(data);
            setLoading(false);
        });
    }, [searchParams]);

    const handleViewChange = (newView: string) => {
        setView(newView);
        localStorage.setItem('leadsView', newView);
    };

    return (
        <div className="flex-1 bg-slate-50 min-h-[calc(100vh-64px)] -m-6">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain">Active Leads</h1>
                        <p className="text-sm text-hui-textMuted mt-1">Manage all active leads and opportunities.</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button className="hui-btn hui-btn-secondary">Contact Form</button>
                        <button className="hui-btn hui-btn-secondary">Insights</button>
                        <AddLeadButton />
                    </div>
                </div>

                <div className="hui-card overflow-hidden bg-white shadow-sm ring-1 ring-slate-200">
                    <div className="border-b border-slate-200 p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white gap-4">
                        <div className="flex items-center gap-4 flex-1 overflow-x-auto pb-1 sm:pb-0 w-full">
                            <input type="text" placeholder="Search leads..." className="hui-input w-64 shrink-0 shadow-sm" />
                            <select className="hui-input w-auto shrink-0 shadow-sm"><option>All Project Types</option></select>
                            <select className="hui-input w-auto shrink-0 shadow-sm"><option>All Lead Sources</option></select>
                        </div>
                        <div className="flex border border-slate-200 rounded-md overflow-hidden bg-slate-50 shadow-sm shrink-0">
                            <button onClick={() => handleViewChange('table')} className={`px-4 py-2 text-xs font-medium border-r border-slate-200 transition ${view === 'table' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>Table</button>
                            <button onClick={() => handleViewChange('kanban')} className={`px-4 py-2 text-xs font-medium transition ${view === 'kanban' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>Kanban</button>
                        </div>
                    </div>

                    {loading ? (
                        <div className="p-12 text-center text-slate-500">Loading leads...</div>
                    ) : leads.length === 0 ? (
                        <div className="p-12 text-center flex flex-col items-center bg-white">
                            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                            </div>
                            <h3 className="text-lg font-medium text-slate-900 mb-1">No leads yet</h3>
                            <p className="text-slate-500 mb-6">Add your first lead to start tracking opportunities.</p>
                            <AddLeadButton />
                        </div>
                    ) : view === 'table' ? (
                        <div className="overflow-x-auto">
                            <table className="min-w-max divide-y divide-slate-200">
                                <thead className="bg-[#f9f8f6]">
                                    <tr>
                                        <th scope="col" className="px-4 py-3 text-left w-12"><input type="checkbox" className="rounded border-slate-300 text-slate-800 focus:ring-slate-800 h-4 w-4" /></th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Lead Name</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Stage</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Client Name</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Lead Address</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Task</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Type & Source</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Tags</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Financials</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Activity</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider">Managers</th>
                                        <th scope="col" className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wider"></th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-slate-100">
                                    {leads.map((l: any) => (
                                        <tr key={l.id} className={`transition-colors cursor-pointer group ${l.isUnread ? 'bg-slate-50/50 hover:bg-slate-50' : 'hover:bg-slate-50'}`} onClick={() => window.location.href = `/leads/${l.id}`}>
                                            <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                                <input type="checkbox" className="rounded border-slate-300 text-slate-800 focus:ring-slate-800 h-4 w-4" />
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <div className="flex items-center gap-2">
                                                    {l.isUnread && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                                                    <div className={`text-sm font-bold text-slate-800 group-hover:text-blue-600 transition-colors ${!l.isUnread && 'font-medium'}`}>{l.name}</div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                                <LeadStageDropdown leadId={l.id} currentStage={l.stage} variant="pill" />
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <div className="flex items-center gap-2">
                                                    <div className="flex-shrink-0 h-6 w-6">
                                                        <Avatar name={l.client?.name || "Unknown"} color="blue" />
                                                    </div>
                                                    <div className="text-sm font-medium text-slate-700">{l.client?.name || "Unknown"}</div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-500 max-w-[150px] truncate">{l.location || "-"}</td>
                                            <td className="px-4 py-3 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                {l.tasks && l.tasks.length > 0 ? (
                                                    <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-50 rounded text-amber-700 font-medium">
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                                                        {l.tasks[0].title}
                                                    </div>
                                                ) : (
                                                    <button className="text-slate-400 hover:text-slate-700 font-medium py-1 px-2 hover:bg-slate-100 rounded transition">+ Add task</button>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <div className="text-sm text-slate-700">{l.projectType || "-"}</div>
                                                <div className="text-[10px] text-slate-400 mt-0.5">{l.source || "-"}</div>
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                {l.tags ? (
                                                    <div className="flex gap-1 overflow-x-auto max-w-[150px]">
                                                        {l.tags.split(",").map((t: string) => <span key={t} className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-medium">{t.trim()}</span>)}
                                                    </div>
                                                ) : <button className="text-blue-500 hover:text-blue-700 font-medium text-xs border border-transparent hover:border-blue-200 hover:bg-blue-50 px-1.5 py-0.5 rounded transition">Add tags</button>}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-500 text-right">
                                                {l.targetRevenue ? `$${l.targetRevenue.toLocaleString()}` : "-"} <br/>
                                                <span className="text-[10px] text-green-600 font-bold">{l.expectedProfit ? `+$${l.expectedProfit.toLocaleString()}` : ""}</span>
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <div className="text-xs text-slate-500">Created: <span className="font-medium text-slate-700">{new Date(l.createdAt).toLocaleDateString()}</span></div>
                                                <div className="text-[10px] text-slate-400 mt-0.5 max-w-[120px] truncate">Last Activity: {l.lastActivityAt ? new Date(l.lastActivityAt).toLocaleDateString() : "-"}</div>
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                {l.manager ? (
                                                    <div className="flex-shrink-0 h-6 w-6" title={l.manager.name || l.manager.email}>
                                                        <Avatar name={l.manager.name || l.manager.email} color="green" />
                                                    </div>
                                                ) : (
                                                    <div className="w-6 h-6 rounded-full border border-dashed border-slate-300 flex items-center justify-center text-slate-400 hover:border-slate-500 hover:text-slate-600 transition" onClick={(e) => e.stopPropagation()} title="Assign Manager">
                                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                                                <button className="p-1.5 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded transition relative">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <KanbanBoard initialLeads={leads} />
                    )}
                </div>
            </div>
        </div>
    );
}
