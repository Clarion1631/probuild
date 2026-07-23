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
                    is the one place to see every job, move dates, and assign crew.
                </p>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Reading the board</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>Every <strong>In Progress</strong> or scheduled job is a colored bar across its days. The labeled blocks inside the bar are its phases — Framing, Drywall, Paint — each with the crew initials working it.</li>
                    <li>Phases can overlap (concrete curing while the deck gets framed) — they stack inside the bar.</li>
                    <li><strong>Month</strong> shows a calendar; <strong>Timeline</strong> shows one straight row per job. Same jobs, same edits — use whichever reads better. The board remembers your choice.</li>
                    <li>A red badge on a bar means someone is double-booked across two jobs that day.</li>
                    <li>The blue line is today. Use <strong>← Prev / Today / Next →</strong> to change months.</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Scheduling a job</h2>
                <Step n={1} title="Drag it from the Unscheduled shelf onto a day">
                    <p>Jobs that are ready but have no start date sit in the <strong>Unscheduled</strong> shelf above the calendar. Drag one onto the day it starts — its whole task schedule comes with it.</p>
                </Step>
                <Step n={2} title="Adjust dates by dragging">
                    <p>Drag a whole bar to move the job. Drag a single phase block to move just that phase. Drag a block&apos;s edge to make it longer or shorter. Nothing is saved yet while you do this — pending moves show with a dashed outline.</p>
                </Step>
                <Step n={3} title="Hit Save when it looks right">
                    <p>A bar appears showing how many unsaved changes you have — <strong>Save</strong> writes them all at once, <strong>Discard</strong> puts everything back. If you move a job that&apos;s already In Progress, it asks whether to move just the start marker or also shift the work that hasn&apos;t started yet.</p>
                </Step>
                <Step n={4} title="Assign the crew">
                    <p>In the <strong>Schedule &amp; crew</strong> table below the calendar, use the crew buttons to set who&apos;s on the job — expand a row (+) to assign people to individual tasks. The <strong>By crew</strong> view on the Timeline then shows each person&apos;s week across all jobs.</p>
                </Step>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Good to know</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>Clicking a bar opens its menu (dates, crew, <em>Open project</em>). It never jumps you into the project by accident.</li>
                    <li>Every move is logged on the project&apos;s activity feed — nothing here emails a customer.</li>
                    <li>Diamond markers and the money toggles (Income, Expenses, Projected CO, Hours) only appear for admin logins.</li>
                    <li>Anything more detailed — dependencies, baselines, punch lists — lives on the job&apos;s own Schedule page (menu → Open project → Schedule).</li>
                </ul>
            </div>

            <div className="hui-card p-6 mb-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-4">Planning with the availability grid</h2>
                <ul className="text-sm text-hui-textMuted space-y-2 list-disc pl-5">
                    <li>Below the calendar, <strong>Crew availability</strong> shows the next 14 days per person. A solid chip means they&apos;re assigned to a task that day; an outlined chip means they&apos;re on the job crew with no specific task yet; a blank cell means they&apos;re free.</li>
                    <li>A car icon on a chip means that job is far enough from the shop to plan for a longer day (drive time eats into the work day).</li>
                    <li>The <strong>Planned $/day</strong> row (admin/manager only) is what that day costs in labor — everyone with a chip that day, at their burdened rate for an 8-hour paid day.</li>
                    <li>Click a person&apos;s name to jump to their week on the Timeline&apos;s <strong>By crew</strong> view.</li>
                </ul>
            </div>

            <Link href="/company-dashboard" className="hui-btn hui-btn-primary">Open the schedule board →</Link>
        </div>
    );
}
