"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/components/PermissionsProvider";
import { RoomDesignerNavContent } from "@/components/room-designer/RoomDesignerNavContent";

interface ProjectInnerSidebarProps {
    projectId: string;
    projectName?: string;
    clientName?: string;
    unreadMessageCount?: number;
}

type NavItem = { label: string; href: string; permission?: string };
type NavSection = {
    id: string;
    title: string;
    items: NavItem[];
};

export default function ProjectInnerSidebar({ projectId, projectName, clientName, unreadMessageCount = 0 }: ProjectInnerSidebarProps) {
    const pathname = usePathname();
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    useEffect(() => {
        const stored = localStorage.getItem("projectSidebarCollapsed");
        if (stored === "true") setSidebarCollapsed(true);
    }, []);
    const { permissions, loaded } = usePermissions();

    const can = (key?: string) => !key || !loaded || !!permissions[key];

    // When editing a single room, replace the project nav with room-designer
    // tools (back link + asset library) so the editor has one combined rail
    // instead of a left sidebar AND a second right panel.
    const isRoomEditor = /^\/projects\/[^/]+\/room-designer\/[^/]+$/.test(pathname || "");

    const toggleSidebar = () => {
        setSidebarCollapsed(prev => {
            const next = !prev;
            localStorage.setItem("projectSidebarCollapsed", String(next));
            return next;
        });
    };

    const navSections: NavSection[] = [
        {
            id: "planning",
            title: "Planning",
            items: [
                { label: "Contracts", href: `/projects/${projectId}/contracts`, permission: "contracts" },
                { label: "Estimates", href: `/projects/${projectId}/estimates`, permission: "estimates" },
                { label: "Takeoffs", href: `/projects/${projectId}/takeoffs`, permission: "takeoffs" },
                { label: "Room Designer", href: `/projects/${projectId}/room-designer`, permission: "roomDesigner" },
                { label: "Mood Boards", href: `/projects/${projectId}/mood-boards` },
                { label: "Selection Boards", href: `/projects/${projectId}/selections` },
                { label: "Bids", href: `/projects/${projectId}/bid-packages` },
            ],
        },
        {
            id: "management",
            title: "Management",
            items: [
                { label: "Client Messages", href: `/projects/${projectId}/messages` },
                { label: "Files & Photos", href: `/projects/${projectId}/files`, permission: "files" },
                { label: "Schedule", href: `/projects/${projectId}/schedule`, permission: "schedules" },
                { label: "Tasks & Punchlist", href: `/projects/${projectId}/tasks` },
                { label: "Client Dashboard", href: `/projects/${projectId}/client-portal` },
                { label: "Daily Logs", href: `/projects/${projectId}/dailylogs`, permission: "dailyLogs" },
                { label: "Time & Expenses", href: `/projects/${projectId}/time-expenses`, permission: "timeClock" },
                { label: "Project Settings", href: `/projects/${projectId}/settings` },
            ],
        },
        {
            id: "finance",
            title: "Finance",
            items: [
                { label: "Invoices", href: `/projects/${projectId}/invoices`, permission: "invoices" },
                { label: "Purchase Orders", href: `/projects/${projectId}/purchase-orders`, permission: "financialReports" },
                { label: "Change Orders", href: `/projects/${projectId}/change-orders`, permission: "changeOrders" },
                { label: "Retainers & Credits", href: `/projects/${projectId}/retainers` },
                { label: "Budget", href: `/projects/${projectId}/budget`, permission: "financialReports" },
                { label: "Financial Overview", href: `/projects/${projectId}/financial-overview` },
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
        <>
        {/* Outer sizer: position:relative for toggle button; NO overflow here so button isn't clipped */}
        <div
            style={{
                flex: sidebarCollapsed ? "0 0 48px" : "0 0 224px",
                maxWidth: sidebarCollapsed ? "48px" : "224px",
                minWidth: 0,
                position: "relative",
            }}
            className="h-full"
        >
        {/* Toggle tab — first in DOM for keyboard focus order, positioned on outside (right) edge via CSS */}
        <button
            onClick={toggleSidebar}
            aria-expanded={!sidebarCollapsed}
            aria-controls="project-inner-sidebar"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{
                position: "absolute",
                right: -20,
                top: "50%",
                transform: "translateY(-50%)",
                zIndex: 10,
            }}
            className="w-5 h-10 bg-white border border-hui-border border-l-0 rounded-r-md shadow-sm flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition"
        >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                {sidebarCollapsed
                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6"/>
                    : <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6"/>
                }
            </svg>
        </button>
        {/* Inner clip wrapper: overflow:hidden here so sidebar content clips but toggle button does not */}
        <div style={{ overflowX: "hidden", width: "100%", height: "100%" }}>
        {/* Inner sidebar: always 224px wide, clipped by inner wrapper when collapsed. */}
        <div id="project-inner-sidebar" className="w-56 bg-hui-background border-r border-hui-border flex flex-col h-full">

            {/* Room editor mode: swap entire sidebar content for the room-designer rail. */}
            {!sidebarCollapsed && isRoomEditor && (
                <RoomDesignerNavContent backHref={`/projects/${projectId}/room-designer`} />
            )}

            {/* Top bar — back link (hidden when collapsed or when in room editor) */}
            {!sidebarCollapsed && !isRoomEditor && (
                <div className="flex items-center border-b border-hui-border px-2 py-2 shrink-0">
                    <Link
                        href="/projects"
                        className="flex items-center gap-2 px-2 py-0.5 text-sm text-slate-500 hover:text-hui-primary hover:bg-slate-100 rounded transition group"
                    >
                        <svg className="w-4 h-4 transition group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                        <span className="font-medium">All Projects</span>
                    </Link>
                </div>
            )}

            {/* Expanded content */}
            {!sidebarCollapsed && !isRoomEditor && <>

            {/* Project identity */}
            {(projectName || clientName) && (
                <div className="px-4 py-3 border-b border-hui-border bg-white shrink-0">
                    {projectName && <p className="text-sm font-semibold text-hui-textMain truncate">{projectName}</p>}
                    {clientName && <p className="text-xs text-slate-500 truncate">{clientName}</p>}
                </div>
            )}

            {/* Client Portal Link */}
            <div className="p-3 border-b border-hui-border bg-slate-50 shrink-0">
                <Link
                    href={`/portal/projects/${projectId}`}
                    target="_blank"
                    className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-md bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-100 transition shadow-sm"
                >
                    <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    View Client Portal
                </Link>
            </div>

            <div className="p-4 border-b border-hui-border bg-white shrink-0">
                <h2 className="text-sm font-bold uppercase tracking-wider"><Link href={`/projects/${projectId}`} className="text-hui-textMain hover:text-hui-accent transition-colors">Project Overview</Link></h2>
            </div>

            {/* Scrollable nav */}
            <div className="flex-1 overflow-y-auto w-full">
                <div className="p-3">
                    {navSections.map((section) => {
                        const visibleItems = section.items.filter(item => can(item.permission));
                        if (visibleItems.length === 0) return null;
                        return (
                        <div key={section.id} className="mb-4">
                            <button
                                onClick={() => toggleSection(section.id)}
                                className="w-full flex items-center justify-between text-left focus:outline-none px-3 mb-2 hover:bg-slate-100 rounded py-1 transition-colors"
                            >
                                <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                    {section.title}
                                </h3>
                                <svg
                                    className={`w-4 h-4 text-slate-400 transition-transform ${collapsedSections[section.id] ? "rotate-180" : ""}`}
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                </svg>
                            </button>

                            {!collapsedSections[section.id] && (
                                <ul className="space-y-1">
                                    {visibleItems.map((item) => {
                                        const isActive = pathname?.includes(item.href);
                                        const showBadge = item.label === "Client Messages" && unreadMessageCount > 0;
                                        return (
                                            <li key={item.label}>
                                                <Link
                                                    href={item.href}
                                                    className={`flex items-center justify-between px-3 py-1.5 text-sm rounded transition ${isActive
                                                        ? "bg-hui-primary/10 text-hui-primary font-medium"
                                                        : "text-hui-textMain hover:bg-slate-200 hover:text-hui-textMain"
                                                    }`}
                                                >
                                                    <span>{item.label}</span>
                                                    {showBadge && (
                                                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                                                            {unreadMessageCount > 99 ? "99+" : unreadMessageCount}
                                                        </span>
                                                    )}
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                        );
                    })}
                </div>
            </div>

            </>}
        </div>
        </div>{/* end inner clip wrapper */}
        </div>{/* end outer sizer */}
        </>
    );
}
