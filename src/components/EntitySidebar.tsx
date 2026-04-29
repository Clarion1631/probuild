"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/components/PermissionsProvider";
import { RoomDesignerNavContent } from "@/components/room-designer/RoomDesignerNavContent";
import { toast } from "sonner";

interface EntitySidebarProps {
    entity: { type: "lead" | "project"; id: string; name: string; clientName?: string };
    linkedEntity?: { type: "lead" | "project"; id: string; name: string } | null;
    unreadMessageCount?: number;
    onConvertToProject?: () => void;
}

type NavItem = { label: string; href: string; permission?: string };
type NavSection = { id: string; title: string; items: NavItem[] };

export default function EntitySidebar({
    entity, linkedEntity, unreadMessageCount = 0, onConvertToProject,
}: EntitySidebarProps) {
    const pathname = usePathname();
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [showMoreActions, setShowMoreActions] = useState(false);
    const { permissions, loaded } = usePermissions();

    const can = (key?: string) => !key || !loaded || !!permissions[key];
    const id = entity.id;

    useEffect(() => {
        const stored = localStorage.getItem("projectSidebarCollapsed");
        if (stored === "true") setSidebarCollapsed(true);
    }, []);

    const isRoomEditor =
        /^\/projects\/[^/]+\/room-designer\/[^/]+$/.test(pathname || "") ||
        /^\/leads\/[^/]+\/room-designer\/[^/]+$/.test(pathname || "");

    const toggleSidebar = () => {
        setSidebarCollapsed(prev => {
            const next = !prev;
            localStorage.setItem("projectSidebarCollapsed", String(next));
            return next;
        });
    };

    const toggleSection = (sectionId: string) => {
        setCollapsedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
    };

    const navSections: NavSection[] = entity.type === "project"
        ? [
            {
                id: "planning", title: "Planning", items: [
                    { label: "Contracts", href: `/projects/${id}/contracts`, permission: "contracts" },
                    { label: "Estimates", href: `/projects/${id}/estimates`, permission: "estimates" },
                    { label: "Takeoffs", href: `/projects/${id}/takeoffs`, permission: "takeoffs" },
                    { label: "Room Designer", href: `/projects/${id}/room-designer`, permission: "roomDesigner" },
                    { label: "Mood Boards", href: `/projects/${id}/mood-boards` },
                    { label: "Selection Boards", href: `/projects/${id}/selections` },
                    { label: "Bids", href: `/projects/${id}/bid-packages` },
                ],
            },
            {
                id: "management", title: "Management", items: [
                    { label: "Client Messages", href: `/projects/${id}/messages` },
                    { label: "Files & Photos", href: `/projects/${id}/files`, permission: "files" },
                    { label: "Schedule", href: `/projects/${id}/schedule`, permission: "schedules" },
                    { label: "Tasks & Punchlist", href: `/projects/${id}/tasks` },
                    { label: "Client Dashboard", href: `/projects/${id}/client-portal` },
                    { label: "Daily Logs", href: `/projects/${id}/dailylogs`, permission: "dailyLogs" },
                    { label: "Time & Expenses", href: `/projects/${id}/time-expenses`, permission: "timeClock" },
                    { label: "Project Settings", href: `/projects/${id}/settings` },
                ],
            },
            {
                id: "finance", title: "Finance", items: [
                    { label: "Invoices", href: `/projects/${id}/invoices`, permission: "invoices" },
                    { label: "Purchase Orders", href: `/projects/${id}/purchase-orders`, permission: "financialReports" },
                    { label: "Change Orders", href: `/projects/${id}/change-orders`, permission: "changeOrders" },
                    { label: "Retainers & Credits", href: `/projects/${id}/retainers` },
                    { label: "Budget", href: `/projects/${id}/budget`, permission: "financialReports" },
                    { label: "Financial Overview", href: `/projects/${id}/financial-overview` },
                ],
            },
        ]
        : [
            {
                id: "planning", title: "Planning", items: [
                    { label: "Contracts", href: `/leads/${id}/contracts` },
                    { label: "Estimates", href: `/leads/${id}/estimates` },
                    { label: "Takeoffs", href: `/leads/${id}/takeoffs` },
                    { label: "Room Designer", href: `/leads/${id}/room-designer` },
                ],
            },
            {
                id: "management", title: "Management", items: [
                    { label: "Overview", href: `/leads/${id}` },
                    { label: "Notes", href: `/leads/${id}/notes` },
                    { label: "Tasks", href: `/leads/${id}/tasks` },
                    { label: "Meetings", href: `/leads/${id}/meetings` },
                    { label: "Files & Photos", href: `/leads/${id}/files` },
                    { label: "Schedule", href: `/leads/${id}/schedule` },
                ],
            },
        ];

    const backHref = entity.type === "project" ? "/projects" : "/leads";
    const backLabel = entity.type === "project" ? "All Projects" : "All Leads";
    const overviewHref = entity.type === "project" ? `/projects/${id}` : `/leads/${id}`;
    const overviewLabel = entity.type === "project" ? "Project Overview" : "Lead Overview";
    const roomDesignerBackHref = `/${entity.type === "project" ? "projects" : "leads"}/${id}/room-designer`;

    return (
        <>
        <div
            style={{
                flex: sidebarCollapsed ? "0 0 48px" : "0 0 224px",
                maxWidth: sidebarCollapsed ? "48px" : "224px",
                minWidth: 0,
                position: "relative",
            }}
            className="h-full"
        >
        <button
            onClick={toggleSidebar}
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{ position: "absolute", right: -20, top: "50%", transform: "translateY(-50%)", zIndex: 10 }}
            className="w-5 h-10 bg-white border border-hui-border border-l-0 rounded-r-md shadow-sm flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition"
        >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                {sidebarCollapsed
                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" />
                    : <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
                }
            </svg>
        </button>
        <div style={{ overflowX: "hidden", width: "100%", height: "100%" }}>
        <div className="w-56 bg-hui-background border-r border-hui-border flex flex-col h-full">

            {!sidebarCollapsed && isRoomEditor && (
                <RoomDesignerNavContent backHref={roomDesignerBackHref} />
            )}

            {!sidebarCollapsed && !isRoomEditor && (
                <div className="flex items-center border-b border-hui-border px-2 py-2 shrink-0">
                    <Link
                        href={backHref}
                        className="flex items-center gap-2 px-2 py-0.5 text-sm text-slate-500 hover:text-hui-primary hover:bg-slate-100 rounded transition group"
                    >
                        <svg className="w-4 h-4 transition group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                        <span className="font-medium">{backLabel}</span>
                    </Link>
                </div>
            )}

            {!sidebarCollapsed && !isRoomEditor && <>

            {(entity.name || entity.clientName) && (
                <div className="px-4 py-3 border-b border-hui-border bg-white shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        {entity.name && (
                            <p className="text-sm font-semibold text-hui-textMain truncate">{entity.name}</p>
                        )}
                        {entity.type === "lead" && (
                            <span className="text-[10px] font-bold uppercase bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded shrink-0">
                                Lead
                            </span>
                        )}
                    </div>
                    {entity.clientName && (
                        <p className="text-xs text-slate-500 truncate">{entity.clientName}</p>
                    )}
                    {linkedEntity && (
                        <Link
                            href={`/${linkedEntity.type === "project" ? "projects" : "leads"}/${linkedEntity.id}`}
                            className="mt-1 text-xs text-hui-primary hover:underline truncate block"
                        >
                            {linkedEntity.type === "project" ? "→ Project: " : "← Lead: "}{linkedEntity.name}
                        </Link>
                    )}
                </div>
            )}

            {entity.type === "project" && (
                <div className="p-3 border-b border-hui-border bg-slate-50 shrink-0">
                    <Link
                        href={`/portal/projects/${id}`}
                        target="_blank"
                        className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-md bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-100 transition shadow-sm"
                    >
                        <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                        View Client Portal
                    </Link>
                </div>
            )}

            <div className="p-4 border-b border-hui-border bg-white shrink-0">
                <h2 className="text-sm font-bold uppercase tracking-wider">
                    <Link href={overviewHref} className="text-hui-textMain hover:text-hui-accent transition-colors">
                        {overviewLabel}
                    </Link>
                </h2>
            </div>

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
                                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                    </svg>
                                </button>
                                {!collapsedSections[section.id] && (
                                    <ul className="space-y-1">
                                        {visibleItems.map((item) => {
                                            const isActive = pathname === item.href || (pathname?.startsWith(item.href + "/") && item.href !== `/leads/${id}` && item.href !== `/projects/${id}`);
                                            const showBadge = item.label === "Client Messages" && unreadMessageCount > 0;
                                            return (
                                                <li key={item.label}>
                                                    <Link
                                                        href={item.href}
                                                        className={`flex items-center justify-between px-3 py-1.5 text-sm rounded transition ${
                                                            isActive
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

            {entity.type === "lead" && onConvertToProject && (
                <div className="px-4 py-3 border-t border-hui-border shrink-0">
                    <button
                        onClick={onConvertToProject}
                        className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 border border-transparent text-white text-sm font-semibold rounded-lg transition shadow-sm hover:shadow"
                    >
                        Convert to Project
                    </button>
                    <div className="relative mt-3">
                        <button
                            onClick={() => setShowMoreActions(!showMoreActions)}
                            className="w-full flex items-center justify-center gap-1 text-sm text-slate-700 hover:text-slate-900 transition font-medium py-1"
                        >
                            More Actions
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${showMoreActions ? "rotate-180" : ""}`}>
                                <path d="M6 9l6 6 6-6" />
                            </svg>
                        </button>
                        {showMoreActions && (
                            <div className="mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden z-20 relative">
                                {[
                                    { label: "Print", action: () => window.print() },
                                    {
                                        label: "Archive", action: async () => {
                                            const { updateLeadMetadata } = await import("@/lib/actions");
                                            await updateLeadMetadata(id, { isArchived: true });
                                            toast.success("Lead archived");
                                            window.location.href = "/leads";
                                        }
                                    },
                                    {
                                        label: "Delete", danger: true, action: async () => {
                                            if (confirm("Are you sure you want to delete this lead?")) {
                                                const { deleteLead } = await import("@/lib/actions");
                                                await deleteLead(id);
                                                toast.success("Lead deleted");
                                                window.location.href = "/leads";
                                            }
                                        }
                                    },
                                ].map(action => (
                                    <button
                                        key={action.label}
                                        onClick={() => { action.action(); setShowMoreActions(false); }}
                                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50 transition ${
                                            (action as any).danger ? "text-red-600 hover:bg-red-50" : "text-slate-700"
                                        }`}
                                    >
                                        {action.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            </>}
        </div>
        </div>
        </div>
        </>
    );
}
