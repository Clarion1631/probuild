"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { linkProjectToLead } from "@/lib/actions";
import { toast } from "sonner";
import { usePermissions } from "@/components/PermissionsProvider";

interface ProjectInnerSidebarProps {
    projectId: string;
    lead?: { id: string; name: string } | null;
    availableLeads?: { id: string; name: string; stage: string; client: { name: string } | null }[];
    unreadMessageCount?: number;
}

type NavItem = { label: string; href: string; permission?: string };
type NavSection = {
    id: string;
    title: string;
    items: NavItem[];
};

export default function ProjectInnerSidebar({ projectId, lead, availableLeads = [], unreadMessageCount = 0 }: ProjectInnerSidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    useEffect(() => {
        const stored = localStorage.getItem("projectSidebarCollapsed");
        if (stored === "true") setSidebarCollapsed(true);
    }, []);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [linking, setLinking] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [currentLead, setCurrentLead] = useState(lead || null);
    const { permissions, loaded } = usePermissions();

    const can = (key?: string) => !key || !loaded || !!permissions[key];

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
                { label: "3D Floor Plans", href: `/projects/${projectId}/floor-plans`, permission: "floorPlans" },
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

    const handleLinkLead = async (leadId: string) => {
        setLinking(true);
        try {
            await linkProjectToLead(projectId, leadId);
            const linked = availableLeads.find(l => l.id === leadId);
            if (linked) setCurrentLead({ id: linked.id, name: linked.name });
            toast.success("Lead linked to project!");
            setShowLinkModal(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to link lead");
        } finally { setLinking(false); }
    };

    const handleUnlinkLead = async () => {
        if (!confirm("Unlink this lead from the project?")) return;
        setLinking(true);
        try {
            await linkProjectToLead(projectId, null);
            setCurrentLead(null);
            toast.success("Lead unlinked");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to unlink lead");
        } finally { setLinking(false); }
    };

    const filtered = availableLeads.filter(l =>
        l.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (l.client?.name || "").toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <>
        {/* Toggle tab — rendered FIRST so it's the 1st focusable element (before all nav links) */}
        <div
            className="relative shrink-0 self-stretch"
            style={{ width: 0, zIndex: 10 }}
        >
            <button
                onClick={toggleSidebar}
                aria-expanded={!sidebarCollapsed}
                aria-controls="project-inner-sidebar"
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                style={{
                    position: "absolute",
                    left: 0,
                    top: "50%",
                    transform: "translateY(-50%)",
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
        </div>

        {/* Outer sizer: clips inner horizontally; overflowX:hidden makes overflowY:auto so inner scroll works */}
        <div
            style={{
                flex: sidebarCollapsed ? "0 0 48px" : "0 0 224px",
                maxWidth: sidebarCollapsed ? "48px" : "224px",
                minWidth: 0,
                overflowX: "hidden",
            }}
            className="h-full"
        >
        {/* Inner sidebar: always 224px wide, clipped by outer when collapsed. h-full constrains flex so nav can scroll. */}
        <div id="project-inner-sidebar" className="w-56 bg-hui-background border-r border-hui-border flex flex-col h-full">

            {/* Top bar — back link (hidden when collapsed) */}
            {!sidebarCollapsed && (
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
            {!sidebarCollapsed && <>

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

            {/* Lead Link - Prominent */}
            <div className="px-3 pt-3 pb-1 shrink-0">
                {currentLead ? (
                    <div className="group/lead">
                        <Link
                            href={`/leads/${currentLead.id}`}
                            className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 hover:from-amber-100 hover:to-orange-100 transition"
                        >
                            <div className="w-7 h-7 bg-amber-100 rounded-lg flex items-center justify-center shrink-0">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.5">
                                    <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" />
                                    <circle cx="9" cy="7" r="4" />
                                    <path d="M22 21v-2a4 4 0 00-3-3.87" />
                                    <path d="M16 3.13a4 4 0 010 7.75" />
                                </svg>
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider">Lead</p>
                                <p className="text-xs font-medium text-amber-800 truncate">{currentLead.name}</p>
                            </div>
                            <svg className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                        </Link>
                        <button
                            onClick={handleUnlinkLead}
                            className="w-full text-center text-[10px] text-slate-400 hover:text-red-500 mt-1 transition opacity-0 group-hover/lead:opacity-100"
                        >
                            Unlink lead
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => setShowLinkModal(true)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-slate-50 border border-dashed border-slate-300 hover:border-amber-300 hover:bg-amber-50 transition text-slate-400 hover:text-amber-600 group"
                    >
                        <div className="w-7 h-7 bg-slate-100 group-hover:bg-amber-100 rounded-lg flex items-center justify-center shrink-0 transition">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M12 5v14M5 12h14" />
                            </svg>
                        </div>
                        <div className="text-left">
                            <p className="text-[10px] font-semibold uppercase tracking-wider">Link Lead</p>
                            <p className="text-[10px]">Connect to a lead</p>
                        </div>
                    </button>
                )}
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
        </div>

        {/* Link Lead Modal (fixed overlay, outside sizing divs) */}
        {showLinkModal && (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-5 max-h-[70vh] flex flex-col">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-base font-bold text-hui-textMain">Link Lead to Project</h3>
                        <button onClick={() => setShowLinkModal(false)} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
                    </div>

                    <input
                        type="text"
                        placeholder="Search leads..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="hui-input w-full mb-3 text-sm"
                        autoFocus
                    />

                    <div className="flex-1 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                        {filtered.length === 0 ? (
                            <div className="p-4 text-center text-sm text-slate-400">No leads found</div>
                        ) : (
                            filtered.map(l => (
                                <button
                                    key={l.id}
                                    onClick={() => handleLinkLead(l.id)}
                                    disabled={linking}
                                    className="w-full text-left px-4 py-3 hover:bg-amber-50 transition flex items-center justify-between group disabled:opacity-50"
                                >
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-hui-textMain truncate">{l.name}</p>
                                        <p className="text-xs text-slate-400">{l.client?.name || "No client"} · {l.stage}</p>
                                    </div>
                                    <span className="text-xs text-amber-600 font-medium opacity-0 group-hover:opacity-100 transition shrink-0 ml-2">
                                        Link →
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            </div>
        )}
        </>
    );
}
