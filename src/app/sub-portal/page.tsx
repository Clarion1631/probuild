import { redirect } from "next/navigation";
import { getSubPortalSession } from "@/lib/sub-portal-auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import SubPortalCoiCard from "./SubPortalCoiCard";
import SubSafetyTipsCard from "./SubSafetyTipsCard";

export default async function SubPortalDashboard() {
    const sub = await getSubPortalSession();
    if (!sub) redirect("/sub-portal/login");

    // Find all project accesses for this sub
    const projectAccesses = await prisma.subcontractorProjectAccess.findMany({
        where: { subcontractorId: sub.id },
        include: {
            project: {
                select: { id: true, name: true, status: true, location: true, createdAt: true, color: true },
            }
        }
    });

    // Find all task assignments to calculate task counts and status
    const assignments = await prisma.subTaskAssignment.findMany({
        where: { subcontractorId: sub.id },
        include: { task: true }
    });

    const projectMap = new Map<string, {
        id: string;
        name: string;
        status: string;
        location: string | null;
        createdAt: Date;
        color: string | null;
        taskCount: number;
    }>();

    // Initialize map with all accessed projects
    for (const access of projectAccesses) {
        const p = access.project;
        projectMap.set(p.id, {
            id: p.id,
            name: p.name,
            status: p.status,
            location: p.location,
            createdAt: p.createdAt,
            color: p.color,
            taskCount: 0,
        });
    }

    // Add task counts
    for (const a of assignments) {
        const existing = a.task.projectId ? projectMap.get(a.task.projectId) : undefined;
        if (existing) {
            existing.taskCount += 1;
        }
    }

    const projects = Array.from(projectMap.values());

    return (
        <div className="max-w-6xl mx-auto py-8">
            {/* Welcome Header */}
            <div className="flex items-center gap-4 mb-8">
                <div className="w-14 h-14 bg-emerald-100 rounded-2xl flex items-center justify-center shadow-sm">
                    <span className="text-xl font-bold text-emerald-700">
                        {(sub.contactName || sub.companyName).charAt(0).toUpperCase()}
                    </span>
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">
                        Welcome back, {(sub.contactName || sub.companyName).split(" ")[0]}!
                    </h1>
                    <p className="text-hui-textMuted text-sm">
                        {sub.companyName} · {sub.trade || "Subcontractor"}
                    </p>
                </div>
            </div>

            {/* Stats Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                <div className="hui-card p-5 flex items-center gap-4">
                    <div className="w-11 h-11 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-hui-textMain">{projects.length}</p>
                        <p className="text-xs text-hui-textMuted font-medium">Active Projects</p>
                    </div>
                </div>
                <div className="hui-card p-5 flex items-center gap-4">
                    <div className="w-11 h-11 bg-emerald-50 rounded-xl flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-hui-textMain">{assignments.length}</p>
                        <p className="text-xs text-hui-textMuted font-medium">Assigned Tasks</p>
                    </div>
                </div>
                <div className="hui-card p-5 flex items-center gap-4">
                    <div className="w-11 h-11 bg-amber-50 rounded-xl flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-hui-textMain">
                            {assignments.filter(a => a.task.status === "In Progress").length}
                        </p>
                        <p className="text-xs text-hui-textMuted font-medium">In Progress</p>
                    </div>
                </div>
            </div>

            {/* AI Safety Tips */}
            <SubSafetyTipsCard subcontractorId={sub.id} />

            {/* Compliance COI Card */}
            <SubPortalCoiCard 
                subId={sub.id} 
                coiUploaded={sub.coiUploaded} 
                coiExpiresAt={sub.coiExpiresAt} 
                coiFileUrl={sub.coiFileUrl}
            />

            {/* Projects Grid */}
            <h2 className="text-lg font-bold text-hui-textMain mb-4">Your Projects</h2>

            {projects.length === 0 ? (
                <div className="col-span-full hui-card p-12 text-center flex flex-col items-center">
                    <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                        <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    </div>
                    <p className="text-hui-textMuted mb-1 font-medium">No projects yet</p>
                    <p className="text-sm text-hui-textMuted">Projects will appear here once you are invited to them.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {projects.map((p) => (
                        <Link
                            href={`/sub-portal/projects/${p.id}`}
                            key={p.id}
                            className="hui-card group overflow-hidden hover:shadow-md transition flex flex-col"
                        >
                            {/* Project Color Bar */}
                            <div className="h-28 relative overflow-hidden flex items-center justify-center"
                                 style={{ background: `linear-gradient(135deg, ${p.color || '#4c9a2a'}22, ${p.color || '#4c9a2a'}08)` }}>
                                <div className="absolute top-3 left-3">
                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                                        p.status === "Completed" ? "bg-emerald-100 text-emerald-700" :
                                        p.status === "In Progress" ? "bg-blue-100 text-blue-700" :
                                        "bg-slate-100 text-slate-600"
                                    }`}>
                                        {p.status}
                                    </span>
                                </div>
                                <span className="text-5xl font-bold tracking-tighter group-hover:scale-110 transition duration-500"
                                      style={{ color: `${p.color || '#4c9a2a'}20` }}>
                                    {p.name.charAt(0)}
                                </span>
                            </div>

                            <div className="p-5 flex-1">
                                <h3 className="font-semibold text-hui-textMain group-hover:text-hui-primary transition truncate mb-2" title={p.name}>
                                    {p.name}
                                </h3>
                                {p.location && (
                                    <p className="text-xs text-hui-textMuted flex items-center gap-1 mb-3">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                        {p.location}
                                    </p>
                                )}
                                <div className="flex items-center gap-2 text-xs text-hui-textMuted">
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                                    <span className="font-medium">{p.taskCount} assigned task{p.taskCount !== 1 ? "s" : ""}</span>
                                </div>
                            </div>

                            <div className="px-5 py-3 border-t border-hui-border bg-slate-50/50 flex justify-between items-center group-hover:bg-emerald-50/50 transition mt-auto">
                                <span className="text-xs text-hui-textMuted">Started {new Date(p.createdAt).toLocaleDateString()}</span>
                                <span className="text-sm font-medium text-hui-primary flex items-center gap-1">
                                    View <svg className="w-4 h-4 transform group-hover:translate-x-1 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                </span>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}
