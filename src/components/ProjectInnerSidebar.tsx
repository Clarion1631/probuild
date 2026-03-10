"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";

interface ProjectInnerSidebarProps {
    projectId: string;
    lead?: { id: string; name: string } | null;
}

type NavSection = {
    id: string;
    title: string;
    items: { label: string; href: string; icon?: string }[];
};

export default function ProjectInnerSidebar({ projectId, lead }: ProjectInnerSidebarProps) {
    const pathname = usePathname();
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

    const navSections: NavSection[] = [
        {
            id: "overview",
            title: "Overview",
            items: [
                { label: "Dashboard", href: `/projects/${projectId}` },
            ],
        },
        {
            id: "planning",
            title: "Planning",
            items: [
                { label: "Contracts", href: `/projects/${projectId}/contracts` },
                { label: "Estimates", href: `/projects/${projectId}/estimates` },
                { label: "Takeoffs", href: `/projects/${projectId}/takeoffs` },
                { label: "3D Floor Plans", href: `/projects/${projectId}/floor-plans` },
            ],
        },
        {
            id: "management",
            title: "Management",
            items: [
                { label: "Schedule", href: `/projects/${projectId}/schedule` },
                { label: "Files & Photos", href: `/projects/${projectId}/files` },
                { label: "Tasks & Punchlist", href: `/projects/${projectId}/tasks` },
                { label: "Daily Logs", href: `/projects/${projectId}/dailylogs` },
            ],
        },
        {
            id: "finance",
            title: "Finance",
            items: [
                { label: "Invoices", href: `/projects/${projectId}/invoices` },
                { label: "Change Orders", href: `/projects/${projectId}/changeorders` },
            ],
        },
    ];

    const toggleSection = (sectionId: string) => {
        setCollapsedSections((prev) => ({
            ...prev,
            [sectionId]: !prev[sectionId],
        }));
    };

    return (
        <div className="w-56 bg-hui-background border-r border-hui-border flex flex-col min-h-full">
            <div className="p-4 border-b border-hui-border bg-white">
                <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider">Project Menu</h2>
            </div>

            {/* Lead Link - Prominent */}
            {lead && (
                <div className="px-3 pt-3 pb-1">
                    <Link
                        href={`/leads/${lead.id}`}
                        className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 hover:from-amber-100 hover:to-orange-100 transition group"
                    >
                        <div className="w-7 h-7 bg-amber-100 group-hover:bg-amber-200 rounded-lg flex items-center justify-center shrink-0 transition">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.5">
                                <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <path d="M22 21v-2a4 4 0 00-3-3.87" />
                                <path d="M16 3.13a4 4 0 010 7.75" />
                            </svg>
                        </div>
                        <div className="min-w-0">
                            <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider">Lead</p>
                            <p className="text-xs font-medium text-amber-800 truncate">{lead.name}</p>
                        </div>
                        <svg className="w-3.5 h-3.5 text-amber-400 shrink-0 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                    </Link>
                </div>
            )}

            <div className="flex-1 overflow-y-auto w-full">
                <div className="p-3">
                    {navSections.map((section) => (
                        <div key={section.id} className="mb-4">
                            <button
                                onClick={() => toggleSection(section.id)}
                                className="w-full flex items-center justify-between text-left focus:outline-none px-3 mb-2 hover:bg-slate-100 rounded py-1 transition-colors"
                            >
                                <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                    {section.title}
                                </h3>
                                <svg
                                    className={`w-4 h-4 text-slate-400 transition-transform ${collapsedSections[section.id] ? "rotate-180" : ""
                                        }`}
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                </svg>
                            </button>

                            {!collapsedSections[section.id] && (
                                <ul className="space-y-1">
                                    {section.items.map((item) => {
                                        const isActive = pathname?.includes(item.href);
                                        return (
                                            <li key={item.label}>
                                                <Link
                                                    href={item.href}
                                                    className={`block px-3 py-1.5 text-sm rounded transition ${isActive
                                                            ? "bg-hui-primary/10 text-hui-primary font-medium"
                                                            : "text-hui-textMain hover:bg-slate-200 hover:text-hui-textMain"
                                                        }`}
                                                >
                                                    {item.label}
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
