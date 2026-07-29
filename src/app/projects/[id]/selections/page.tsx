import { getProjectDecisions, getRecentlyDeletedDecisions, getRecentlyDeletedItems } from "@/lib/actions";
import TeamDecisionsSection from "./TeamDecisionsSection";

export default async function SelectionsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;
    const [decisionsData, recentlyDeleted, recentlyDeletedItems] = await Promise.all([
        getProjectDecisions(id),
        getRecentlyDeletedDecisions(id),
        getRecentlyDeletedItems(id),
    ]);

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
            />
        </div>
    );
}
