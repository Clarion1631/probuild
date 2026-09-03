import Link from "next/link";
import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// Plain-English "how to use" for the company schedule board — written so a
// PM/field lead can be sent this link cold (probuild.goldentouchremodeling.com
// /company-dashboard/guide) and start scheduling. Same gate as the dashboard.
const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <div className="flex gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-hui-primary text-white flex items-center justify-center text-sm font-bold">{n}</div>
        <div className="pb-6">
            <h3 className="text-sm font-semibold text-hui-textMain mb-1">{title}</h3>
            <div className="text-sm text-hui-textMuted space-y-1">{children}</div>
        </div>
    </div>
);

export default async function CompanyDashboardGuidePage() {
    const session = await getSessionOrDev();
    const user = session?.user?.email ? await getUserWithPermissionsByEmail(session.user.email) : null;
    const effectiveUser = user ?? (process.env.NODE_ENV === "development" ? { role: "ADMIN", permissions: null } : null);
    if (!effectiveUser || (!hasPermission(effectiveUser, "financialReports") && !hasPermission(effectiveUser, "schedules"))) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }

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
                    <li><strong>Day</strong> shows one card per job with work on that day: the task, its status and progress, who&apos;s on it, and a materials count. People with nothing assigned sit on the <strong>Available</strong> bench up top. Use the <strong>←</strong> <strong>→</strong> arrows to plan tomorrow or next Monday the same way; <strong>Today</strong> jumps back.</li>
                    <li>The strip above the cards is the day checklist — it flags jobs with no one on them, tasks with no lead, double-bookings, and anything Blocked. Click a flag to jump to the problem. &quot;Day clear&quot; means the selected day runs.</li>
                    <li><strong>Week</strong> flips it: one row per person across the week, so you can see everyone&apos;s week at a glance. Click an empty day to give someone a task.</li>
                    <li><strong>Drag a crew chip onto a task</strong> to assign them. Chip changes pile up as drafts just like date moves.</li>
                    <li><strong>Review dispatch</strong> shows every change in plain English — &quot;Kevin → Framing (add)&quot; — before anything commits. One confirm saves it all together, or nothing at all if the schedule changed under you. Your drafts survive either way.</li>
                    <li>The <strong>Task bank</strong> lists estimate items that have no task yet, with a count like &quot;7 of 9 scheduled&quot; — so nothing that was sold goes unplanned.</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-1">Dispatch day, in order</h2>
                <p className="text-sm text-hui-textMuted mb-5">The crew app only shows what you confirm here. A job with no task for the selected day is an empty screen for whoever is standing on it.</p>
                <ol className="list-none p-0 m-0">
                    <li>
                        <Step n={1} title="Check the strip">
                            <p>Unstaffed, Crewless job, Needs review, No field update. Click a flag to jump to it.</p>
                        </Step>
                    </li>
                    <li>
                        <Step n={2} title="Give every job a task for the selected day">
                            <p>A card that says &quot;No task planned for this day&quot; has crew but nothing to do. Click <strong>+ Task</strong> on the card, or pick the project in the Task bank and hit <strong>Schedule</strong> next to an unscheduled item. Planning ahead? Arrow to that day first.</p>
                        </Step>
                    </li>
                    <li>
                        <Step n={3} title="Put people on tasks">
                            <p>Drag chips from the Available bench onto tasks. Use <strong>Week</strong> to plan the rest of the week.</p>
                        </Step>
                    </li>
                    <li>
                        <Step n={4} title="Review dispatch, then confirm">
                            <p>Nothing is saved while you arrange. One confirm saves it all. Crew see it in the app on their next refresh.</p>
                        </Step>
                    </li>
                    <li>
                        <Step n={5} title="Staging queue for tomorrow&apos;s truck">
                            <p>Big checkboxes, grouped by job. Works on a phone.</p>
                        </Step>
                    </li>
                </ol>
                <p className="text-sm text-hui-textMuted">Daily logs don&apos;t move the schedule by themselves. If a phase slips or finishes early, update the task here.</p>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">What the crew sees</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>In the ProBuild Field app, the <strong>Today</strong> tab lists today&apos;s tasks by job, with a <strong>YOU</strong> badge on theirs. Tapping a task opens details, comments, and photos.</li>
                    <li><strong>This Week</strong> shows one week at a time, Sunday to Saturday (same as the pay period), with arrows to look ahead. The Week grid on this board starts on Monday, so the two views cover slightly different days.</li>
                    <li>The app has its own short how-to behind the <strong>?</strong> on the Today tab.</li>
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
                    <li>Who shows up on the bench and in the Week rows is a switch per person: <strong>Company → Team members → Show on dispatch board</strong>. Turn it on for anyone who works in the field, off for office-only or test logins.</li>
                    <li>Every move is logged on the project&apos;s activity feed — <strong>nothing here emails a customer</strong>. Clients only ever see saved work on their portal, never your drafts.</li>
                    <li>Diamond markers and the money toggles (Income, Expenses, Projected CO, Hours) only appear for admin logins.</li>
                    <li>Anything deeper — dependencies, baselines, punch lists — lives on the job&apos;s own Schedule page (panel → Open project).</li>
                </ul>
            </div>

            <Link href="/company-dashboard" className="hui-btn hui-btn-primary">Open the schedule board →</Link>
        </div>
    );
}
