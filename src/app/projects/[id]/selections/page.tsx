import { getProjectDecisions, getRecentlyDeletedDecisions, getRecentlyDeletedItems, listProjectScheduleTasksForLinking } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, isAdminOrManager } from "@/lib/permissions";
import TeamDecisionsSection from "./TeamDecisionsSection";

export default async function SelectionsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;
    const [decisionsData, recentlyDeleted, recentlyDeletedItems, scheduleTasks] = await Promise.all([
        getProjectDecisions(id),
        getRecentlyDeletedDecisions(id),
        getRecentlyDeletedItems(id),
        listProjectScheduleTasksForLinking(id),
    ]);

    // ADMIN/MANAGER-only manual due-date override input (Phase 3 —
    // docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md) —
    // dev sessions without a matching User row default to ADMIN, same
    // passthrough other staff-gated pages use.
    const session = await getSessionOrDev();
    const user = session?.user?.email ? await getUserWithPermissionsByEmail(session.user.email) : null;
    const effectiveUser = user ?? (process.env.NODE_ENV === "development" ? { role: "ADMIN" } : { role: "" });

    return (
        <div className="max-w-5xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-hui-textMain">Selections</h1>
            </div>
            <TeamDecisionsSection
                projectId={id}
                initialDecisions={JSON.parse(JSON.stringify(decisionsData.decisions))}
                // Everything the client has clipped but not yet sorted into a
                // decision. This used to be dropped on the floor here, which
                // made every clipped item (they all land Unsorted) — and the
                // client's note on it — invisible to the team until the client
                // filed it themselves.
                initialUnsorted={JSON.parse(JSON.stringify(decisionsData.unsorted))}
                initialRecentlyDeleted={JSON.parse(JSON.stringify(recentlyDeleted))}
                initialRecentlyDeletedItems={JSON.parse(JSON.stringify(recentlyDeletedItems))}
                isAdminOrManager={isAdminOrManager(effectiveUser)}
                scheduleTasks={JSON.parse(JSON.stringify(scheduleTasks))}
            />
        </div>
    );
}
