import Link from "next/link";
import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// Plain-English "how to use" for the company schedule board — written so a
// PM/field lead can be sent this link cold (probuild.goldentouchremodeling.com
// /company-dashboard/guide) and start scheduling. Same gate as the dashboard.
export default async function CompanyDashboardGuidePage() {
    const session = await getSessionOrDev();
    const user = session?.user?.email ? await getUserWithPermissionsByEmail(session.user.email) : null;
    const effectiveUser = user ?? (process.env.NODE_ENV === "development" ? { role: "ADMIN", permissions: null } : null);
    if (!effectiveUser || (!hasPermission(effectiveUser, "financialReports") && !hasPermission(effectiveUser, "schedules"))) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }

    const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
        <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-hui-primary text-white flex items-center justify-center text-sm font-bold">{n}</div>
            <div className="pb-6">
                <h3 className="text-sm font-semibold text-hui-textMain mb-1">{title}</h3>
                <div className="text-sm text-hui-textMuted space-y-1">{children}</div>
            </div>
        </div>
    );

    return (
        <div className="max-w-3xl mx-auto py-8 px-6">
            <div className="mb-6">
                <h1 className="text-xl font-bold text-hui-textMain">How to use the Project Schedule</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    The schedule board on the <Link href="/company-dashboard" className="text-hui-primary hover:underline">Company Dashboard</Link>{" "}
                    is the one place to see every job, move dates, assign crew, and plan each day.
                </p>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">The one rule: click it and the panel opens</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li><strong>Click any job bar or phase block</strong> and a panel slides in from the right with everything about it — dates, crew, status, notes, materials, color. Change what you need, close it with the ×, Escape, or a click anywhere else.</li>
                    <li>There are no little pop-up menus to hunt through anymore. One click, one panel, everything in a list.</li>
                    <li>Dragging still works exactly as you&apos;d expect: hold and move a bar or block to change its dates, pull its edge to stretch or shrink it. Press <strong>Escape</strong> mid-drag if you grabbed the wrong thing.</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Reading the board</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>Every <strong>In Progress</strong> or scheduled job is a colored bar across its days. The labeled blocks inside are its phases — Framing, Drywall, Paint — each with crew initials and a progress fill.</li>
                    <li>Three views, same jobs: <strong>Month</strong> (calendar), <strong>Timeline</strong> (one straight row per job), and <strong>Dispatch</strong> (who goes where — see below). The board remembers which one you use.</li>
                    <li>The weather row shows the next 10 days for Vancouver — rain chance where the crew is standing.</li>
                    <li>A red badge means someone is double-booked across two jobs that day. The blue line is today.</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Scheduling a job</h2>
                <Step n={1} title="Drag it from the Unscheduled shelf onto a day">
                    <p>Jobs that are ready but have no start date sit in the <strong>Unscheduled</strong> shelf above the calendar. Drag one onto the day it starts — its whole task schedule comes with it.</p>
                </Step>
                <Step n={2} title="Move dates by dragging; add tasks by clicking">
                    <p>Drag a bar to move the job, a block to move a phase, an edge to resize. Pending moves show a dashed outline — nothing is saved while you arrange.</p>
                    <p><strong>Click any empty day</strong> to add a task right there, or use the <strong>+ Task</strong> button up top. Tasks can also be appointments — an inspection or a sub visit with a time of day.</p>
                    <p>Drag the <strong>bar&apos;s own right edge</strong> to change the job&apos;s finish date — that one saves right away.</p>
                </Step>
                <Step n={3} title="Hit Save when it looks right">
                    <p>A bar shows how many unsaved changes you have — <strong>Save</strong> writes them all at once, <strong>Discard</strong> puts everything back. Moving a job that&apos;s already In Progress asks whether to shift its remaining work too.</p>
                </Step>
                <Step n={4} title="Assign the crew">
                    <p>Open a job or task&apos;s panel and tick people on or off the crew list. The star marks the lead. Or do it visually from the Dispatch view — drag a person&apos;s chip straight onto a task.</p>
                </Step>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Dispatch — running the day</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li><strong>Today</strong> shows one card per job with work on: the task, its status and progress, who&apos;s on it, and a materials count. People with nothing assigned sit on the <strong>Available</strong> bench up top.</li>
                    <li>The strip above the cards is the morning checklist — it flags jobs with no one on them, tasks with no lead, double-bookings, and anything Blocked. Click a flag to jump to the problem. &quot;Day clear&quot; means today runs.</li>
                    <li><strong>Week</strong> flips it: one row per person, Monday to Friday, so you can see everyone&apos;s week at a glance. Click an empty day to give someone a task.</li>
                    <li><strong>Drag a crew chip onto a task</strong> to assign them. Chip changes pile up as drafts just like date moves.</li>
                    <li><strong>Review dispatch</strong> shows every change in plain English — &quot;Kevin → Framing (add)&quot; — before anything commits. One confirm saves it all together, or nothing at all if the schedule changed under you. Your drafts survive either way.</li>
                    <li>The <strong>Task bank</strong> lists estimate items that have no task yet, with a count like &quot;7 of 9 scheduled&quot; — so nothing that was sold goes unplanned.</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Materials and the staging queue</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>Every task&apos;s panel has a <strong>Materials</strong> list — type items in, or pull them from the estimate with one click. Each item tracks where it is (shop, on site, pickup) and whether it&apos;s staged.</li>
                    <li>The <strong><Link href="/company-dashboard/staging" className="text-hui-primary hover:underline">Staging queue</Link></strong> is built for loading the truck: it shows tomorrow&apos;s materials across all jobs, grouped by job with the address, with big checkboxes to tick items staged and a Missing button when something isn&apos;t there.</li>
                    <li>It works great on a phone — that&apos;s the point.</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Planning with the availability grid</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>Below the calendar, <strong>Crew availability</strong> shows the next 14 days per person. A solid chip means they&apos;re assigned to a task that day; an outlined chip means they&apos;re on the job crew with no specific task yet; a blank cell means they&apos;re free.</li>
                    <li>A car icon means that job is far enough from the shop to plan for a longer day.</li>
                    <li>The <strong>Planned $/day</strong> row (admin/manager only) is what that day costs in labor — everyone with a chip that day, at their burdened rate for an 8-hour paid day.</li>
                    <li>Click a person&apos;s name to jump to their week on the Timeline&apos;s <strong>By crew</strong> view.</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Good to know</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>Hover any phase block for a quick three-line summary — dates, status, crew. The full story is one click away in its panel.</li>
                    <li>Right-clicking a phase block opens a small quick menu (dates, crew, note, delete) if you prefer it — same actions as the panel.</li>
                    <li>Every move is logged on the project&apos;s activity feed — <strong>nothing here emails a customer</strong>. Clients only ever see saved work on their portal, never your drafts.</li>
                    <li>Diamond markers and the money toggles (Income, Expenses, Projected CO, Hours) only appear for admin logins.</li>
                    <li>Anything deeper — dependencies, baselines, punch lists — lives on the job&apos;s own Schedule page (panel → Open project).</li>
                </ul>
            </div>

            <Link href="/company-dashboard" className="hui-btn hui-btn-primary">Open the schedule board →</Link>
        </div>
    );
}
