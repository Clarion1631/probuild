"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";

interface ProjectInnerSidebarProps {
    projectId: string;
}

type NavSection = {
    id: string;
    title: string;
    items: { label: string; href: string }[];
};

export default function ProjectInnerSidebar({ projectId }: ProjectInnerSidebarProps) {
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
                                        // A simple check if the current path includes the item's href
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
