"use client";
export const dynamic = "force-dynamic";

import Avatar from "@/components/Avatar";
import { getLeads } from "@/lib/actions";
import Link from "next/link";
import AddLeadButton from "./AddLeadButton";
import LeadStageDropdown from "./[id]/LeadStageDropdown";
import { useEffect, useState } from "react";

export default function LeadsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
    const [leads, setLeads] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getLeads().then(data => {
            setLeads(data);
            setLoading(false);
        });
    }, []);

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
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-slate-200">
                                <thead className="bg-slate-50">
                                    <tr>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Lead Name</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Stage</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Client Name</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Location</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Lead Source</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-slate-200">
                                    {leads.map((l: any) => (
                                        <tr key={l.id} className="hover:bg-slate-50 transition-colors cursor-pointer group" onClick={() => window.location.href = `/leads/${l.id}`}>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm font-medium text-slate-900 group-hover:text-blue-600 transition-colors">{l.name}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                                <LeadStageDropdown leadId={l.id} currentStage={l.stage} variant="pill" />
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="flex items-center">
                                                    <div className="flex-shrink-0 h-8 w-8 mr-3">
                                                        <Avatar name={l.client?.name || "Unknown"} color="blue" />
                                                    </div>
                                                    <div className="text-sm text-slate-900">{l.client?.name || "Unknown"}</div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">{l.location}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">{l.source}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

