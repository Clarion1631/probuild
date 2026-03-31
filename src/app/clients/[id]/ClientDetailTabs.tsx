"use client";

import { useState } from "react";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";

export default function ClientDetailTabs({ client }: { client: any }) {
    const [activeTab, setActiveTab] = useState("Projects");

    const tabs = ["Projects", "Leads", "Invoices", "Activity"];

    // Provide default empty arrays if relation isn't returned
    const projects = client.projects || [];
    const leads = client.leads || [];
    const invoices = client.invoices || [];

    return (
        <div className="flex flex-col h-full bg-white rounded-lg">
            <div className="border-b border-hui-border px-6 pt-6">
                <nav className="flex space-x-6">
                    {tabs.map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`pb-3 text-sm font-medium transition-colors border-b-2 ${
                                activeTab === tab
                                    ? "border-hui-primary text-hui-textMain"
                                    : "border-transparent text-hui-textMuted hover:text-hui-textMain"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </nav>
            </div>

            <div className="p-6 flex-1">
                {activeTab === "Projects" && (
                    <div className="space-y-4">
                        {projects.length === 0 ? (
                            <div className="text-center py-12 text-hui-textMuted border border-dashed border-hui-border rounded-lg">
                                No projects assigned to this client yet.
                            </div>
                        ) : (
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="text-hui-textMuted border-b border-hui-border">
                                    <tr>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider">Project Name</th>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider">Status</th>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {projects.map((project: any) => (
                                        <tr key={project.id} className="hover:bg-slate-50 transition">
                                            <td className="py-4 font-medium text-hui-textMain">{project.name}</td>
                                            <td className="py-4"><StatusBadge status={project.status} /></td>
                                            <td className="py-4 text-right">
                                                <Link href={`/projects/${project.id}`} className="text-hui-primary hover:underline font-medium text-sm">View Project</Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}

                {activeTab === "Leads" && (
                    <div className="space-y-4">
                        {leads.length === 0 ? (
                            <div className="text-center py-12 text-hui-textMuted border border-dashed border-hui-border rounded-lg">
                                No leads associated with this client.
                            </div>
                        ) : (
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="text-hui-textMuted border-b border-hui-border">
                                    <tr>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider">Lead Name</th>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider">Stage</th>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {leads.map((lead: any) => (
                                        <tr key={lead.id} className="hover:bg-slate-50 transition">
                                            <td className="py-4 font-medium text-hui-textMain">{lead.name}</td>
                                            <td className="py-4"><StatusBadge status={lead.stage} /></td>
                                            <td className="py-4 text-right">
                                                <Link href={`/leads/${lead.id}`} className="text-hui-primary hover:underline font-medium text-sm">View Lead</Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}

                {activeTab === "Invoices" && (
                    <div className="space-y-4">
                        {invoices.length === 0 ? (
                            <div className="text-center py-12 text-hui-textMuted border border-dashed border-hui-border rounded-lg">
                                No invoices found.
                            </div>
                        ) : (
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="text-hui-textMuted border-b border-hui-border">
                                    <tr>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider">Invoice #</th>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider">Status</th>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider text-right">Total</th>
                                        <th className="pb-3 font-semibold text-xs uppercase tracking-wider text-right">Balance Due</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {invoices.map((inv: any) => (
                                        <tr key={inv.id} className="hover:bg-slate-50 transition group">
                                            <td className="py-4">
                                                <Link href={`/projects/${inv.projectId}/invoices/${inv.id}`} className="font-medium text-hui-textMain group-hover:text-hui-primary">
                                                    {inv.code}
                                                </Link>
                                            </td>
                                            <td className="py-4"><StatusBadge status={inv.status} /></td>
                                            <td className="py-4 text-right text-hui-textMuted">
                                                ${inv.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                            </td>
                                            <td className="py-4 text-right font-medium text-hui-textMain">
                                                ${inv.balanceDue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}

                {activeTab === "Activity" && (
                    <div className="space-y-6 relative ml-3 border-l-2 border-slate-100 pl-6 py-2">
                        <div className="relative">
                            <div className="absolute -left-[31px] top-1 w-3 h-3 bg-hui-primary rounded-full ring-4 ring-white" />
                            <p className="text-sm font-medium text-hui-textMain">Client Record Created</p>
                            <p className="text-xs text-hui-textMuted">
                                {new Date().toLocaleDateString()}
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
