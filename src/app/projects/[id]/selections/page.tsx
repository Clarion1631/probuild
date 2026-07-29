import { getProjectDecisions, getRecentlyDeletedDecisions } from "@/lib/actions";
import TeamDecisionsSection from "./TeamDecisionsSection";

export default async function SelectionsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;
    const [decisionsData, recentlyDeleted] = await Promise.all([
        getProjectDecisions(id),
        getRecentlyDeletedDecisions(id),
    ]);

    return (
        <div className="max-w-5xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-hui-textMain">Selections</h1>
            </div>
            <TeamDecisionsSection
                projectId={id}
                initialDecisions={JSON.parse(JSON.stringify(decisionsData.decisions))}
                initialRecentlyDeleted={JSON.parse(JSON.stringify(recentlyDeleted))}
            />
        </div>
    );
}
