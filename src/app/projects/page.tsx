"use client";

import Link from "next/link";
import { useState } from "react";

// Mock data
const MOCK_PROJECTS = [
    { id: "1", name: "Smith Kitchen Remodel", client: "John Smith", date: "Oct 12, 2023", status: "Active", amount: "$45,000" },
    { id: "2", name: "Johnson Master Bath", client: "Sarah Johnson", date: "Nov 05, 2023", status: "Active", amount: "$22,500" },
    { id: "3", name: "Davis Exterior Paint", client: "Mike Davis", date: "Dec 01, 2023", status: "Active", amount: "$8,200" },
    { id: "4", name: "Wilson Basement Finish", client: "Emily Wilson", date: "Jan 15, 2024", status: "Active", amount: "$65,000" },
    { id: "5", name: "Brown Deck Addition", client: "Robert Brown", date: "Feb 20, 2024", status: "Active", amount: "$15,000" },
    { id: "6", name: "Miller Roof Replacement", client: "Lisa Miller", date: "Mar 10, 2024", status: "Archived", amount: "$12,000" }
];

export default function ProjectsPage() {
    const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');

    const filteredProjects = MOCK_PROJECTS.filter(p => activeTab === 'active' ? p.status === 'Active' : p.status === 'Archived');

    return (
        <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Projects</h1>
                </div>
                <div className="flex items-center space-x-3">
                    <button className="hui-btn hui-btn-secondary">
                        Import Projects
                    </button>
                    <button className="hui-btn hui-btn-primary">
                        + New Project
                    </button>
                </div>
            </div>

            <div className="flex space-x-6 border-b border-hui-border mb-6">
                <button
                    className={`pb-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'active' ? 'border-hui-primary text-hui-textMain' : 'border-transparent text-hui-textMuted hover:text-hui-textMain'}`}
                    onClick={() => setActiveTab('active')}
                >
                    Active
                </button>
                <button
                    className={`pb-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'archived' ? 'border-hui-primary text-hui-textMain' : 'border-transparent text-hui-textMuted hover:text-hui-textMain'}`}
                    onClick={() => setActiveTab('archived')}
                >
                    Archived
                </button>
            </div>

            <div className="flex items-center mb-6 space-x-4">
                <input
                    type="text"
                    placeholder="Search projects..."
                    className="hui-input w-64"
                />
                <select className="hui-input w-48">
                    <option>All Types</option>
                    <option>Remodel</option>
                    <option>New Build</option>
                </select>
            </div>

            <div className="hui-card overflow-hidden">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50 border-b border-hui-border">
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project Name</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Client</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Start Date</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Amount</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Status</th>
                            <th className="py-3 px-4"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {filteredProjects.map((project) => (
                            <tr key={project.id} className="hover:bg-slate-50 transition-colors group">
                                <td className="py-4 px-4">
                                    <Link href={`/projects/${project.id}`} className="font-medium text-hui-textMain hover:text-hui-primary transition-colors">
                                        {project.name}
                                    </Link>
                                </td>
                                <td className="py-4 px-4 text-sm text-hui-textMuted">{project.client}</td>
                                <td className="py-4 px-4 text-sm text-hui-textMuted">{project.date}</td>
                                <td className="py-4 px-4 text-sm text-hui-textMuted">{project.amount}</td>
                                <td className="py-4 px-4">
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                        project.status === 'Active' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-800'
                                    }`}>
                                        {project.status}
                                    </span>
                                </td>
                                <td className="py-4 px-4 text-right">
                                    <button className="text-hui-textMuted hover:text-hui-textMain opacity-0 group-hover:opacity-100 transition-opacity">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                                        </svg>
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {filteredProjects.length === 0 && (
                            <tr>
                                <td colSpan={6} className="py-12 text-center text-hui-textMuted">
                                    No {activeTab} projects found.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
