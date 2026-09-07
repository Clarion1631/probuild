
import { nonVoidedTimeEntryWhere } from "@/lib/time-entry-void";
export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { rerouteLogisticsEntry } from "@/lib/actions";
import { LOGISTICS_CATEGORY_LABELS, type LogisticsCategory } from "@/lib/logistics-formalize";
import { PROJECT_STATUS_IN_PROGRESS } from "@/lib/project-status";

// Plan 02 (decision D2): Logistics is the overhead bucket. This is where a
// manager sees every logistics punch of the week — what the worker said, what
// the AI made of it, and where the hours landed — and can re-route with one
// click (to a real job = that job's 31-LOGISTICS labor; back = overhead).
// Mac/Beverly read this too.

interface Props {
    searchParams: Promise<{ weeks?: string }>;
}

export default async function ManagerLogisticsPage({ searchParams }: Props) {
    const session = await getSessionOrDev();
    if (!session || !session.user) return redirect("/login");
    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    // Deny-by-default: no matching User (outside local dev) is not a manager.
    if (!user ? process.env.NODE_ENV !== "development" : user.role !== "MANAGER" && user.role !== "ADMIN") {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    const { weeks = "1" } = await searchParams;
    const since = new Date(Date.now() - Math.max(1, Math.min(8, Number(weeks) || 1)) * 7 * 86400000);

    const [entries, jobs] = await Promise.all([
        prisma.timeEntry.findMany({
            where: nonVoidedTimeEntryWhere({
                startTime: { gte: since },
                OR: [{ project: { isLogistics: true } }, { routedFromProjectId: { not: null } }],
            }),
            include: { user: { select: { name: true, email: true } }, project: { select: { id: true, name: true, isLogistics: true } } },
            orderBy: { startTime: "desc" },
            take: 300,
        }),
        prisma.project.findMany({
            where: { status: PROJECT_STATUS_IN_PROGRESS, isLogistics: false },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
        }),
    ]);

    const totalHours = entries.reduce((sum, e) => sum + (e.durationHours ?? 0), 0);
    const overheadHours = entries.filter((e) => e.project.isLogistics).reduce((sum, e) => sum + (e.durationHours ?? 0), 0);
    const fmt = (d: Date) => new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Logistics</h1>
                    <p className="text-sm text-hui-textMuted">
                        Shop time, runs and driving — the overhead bucket. Route a run to the job it was for; the rest stays overhead.
                    </p>
                </div>
                <div className="flex items-center gap-3 text-sm">
                    <Link href="/manager/logistics?weeks=1" className={weeks === "1" ? "font-semibold text-hui-primary" : "text-hui-textMuted"}>This week</Link>
                    <Link href="/manager/logistics?weeks=4" className={weeks === "4" ? "font-semibold text-hui-primary" : "text-hui-textMuted"}>4 weeks</Link>
                    <Link href="/manager/time-entries" className="hui-btn hui-btn-secondary text-sm">Time entries</Link>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
                <div className="hui-card p-4"><div className="text-xs text-hui-textMuted">Logistics punches</div><div className="text-2xl font-bold text-hui-textMain">{entries.length}</div></div>
                <div className="hui-card p-4"><div className="text-xs text-hui-textMuted">Hours still overhead</div><div className="text-2xl font-bold text-hui-textMain">{overheadHours.toFixed(1)}</div></div>
                <div className="hui-card p-4"><div className="text-xs text-hui-textMuted">Hours routed to jobs</div><div className="text-2xl font-bold text-hui-textMain">{(totalHours - overheadHours).toFixed(1)}</div></div>
            </div>

            <div className="hui-card overflow-hidden">
                {entries.length === 0 ? (
                    <div className="p-8 text-center text-hui-textMuted">No logistics time in this window.</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="border-b border-hui-border text-hui-textMuted text-left">
                                <tr>
                                    <th className="px-4 py-3 font-medium">Who / when</th>
                                    <th className="px-4 py-3 font-medium">What they said</th>
                                    <th className="px-4 py-3 font-medium">Cleaned up</th>
                                    <th className="px-4 py-3 font-medium">Category</th>
                                    <th className="px-4 py-3 font-medium text-right">Hrs</th>
                                    <th className="px-4 py-3 font-medium">Costed to</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border">
                                {entries.map((e) => {
                                    const category = e.logisticsCategory as LogisticsCategory | null;
                                    return (
                                        <tr key={e.id} className="align-top">
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <div className="font-medium text-hui-textMain">{e.user?.name || e.user?.email}</div>
                                                <div className="text-xs text-hui-textMuted">{fmt(e.startTime)}{e.endTime ? ` – ${new Date(e.endTime).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" })}` : " (open)"}</div>
                                            </td>
                                            <td className="px-4 py-3 max-w-xs text-hui-textMuted whitespace-pre-wrap">{e.rawNote || e.notes || <span className="italic">—</span>}</td>
                                            <td className="px-4 py-3 max-w-xs text-hui-textMain whitespace-pre-wrap">{e.formalizedNote || <span className="italic text-hui-textMuted">not cleaned up</span>}</td>
                                            <td className="px-4 py-3 whitespace-nowrap text-xs">{category ? LOGISTICS_CATEGORY_LABELS[category] ?? category : <span className="text-hui-textMuted">—</span>}</td>
                                            <td className="px-4 py-3 text-right tabular-nums">{e.durationHours != null ? e.durationHours.toFixed(2) : "—"}</td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <form action={async (fd: FormData) => { "use server"; const v = String(fd.get("target") ?? ""); await rerouteLogisticsEntry(e.id, v ? v : null); }} className="flex items-center gap-2">
                                                    <select name="target" defaultValue={e.project.isLogistics ? "" : e.project.id} className="hui-input text-xs py-1">
                                                        <option value="">Overhead (Logistics)</option>
                                                        {!e.project.isLogistics && !jobs.some((j) => j.id === e.project.id) && (
                                                            // Routed to a job that has since left In Progress: show where it
                                                            // sits; a re-route is still one of the active jobs or overhead.
                                                            <option value={e.project.id} disabled>{e.project.name} (closed)</option>
                                                        )}
                                                        {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                                                    </select>
                                                    <button type="submit" className="hui-btn hui-btn-secondary text-xs">Route</button>
                                                </form>
                                                {e.routedFromProjectId && <div className="text-[11px] text-green-700 mt-1">routed{e.routedAt ? ` ${fmt(e.routedAt)}` : ""}</div>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
