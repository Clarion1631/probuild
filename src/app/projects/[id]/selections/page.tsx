import { getSelectionBoards, getSelectionProposals, getProjectFavorites, getProjectDecisions } from "@/lib/actions";
import SelectionsClient from "./SelectionsClient";
import ClientSuggestions from "./ClientSuggestions";
import ProjectFavoritesSection from "./ProjectFavoritesSection";
import TeamDecisionsSection from "./TeamDecisionsSection";

export default async function SelectionsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;
    const [boards, proposals, favorites, decisionsData] = await Promise.all([
        getSelectionBoards(id),
        getSelectionProposals(id),
        getProjectFavorites(id),
        getProjectDecisions(id),
    ]);

    const boardsJson = JSON.parse(JSON.stringify(boards));

    return (
        <>
            <SelectionsClient projectId={id} initialBoards={boardsJson} />
            <div className="max-w-5xl mx-auto mt-10">
                <TeamDecisionsSection
                    projectId={id}
                    initialDecisions={JSON.parse(JSON.stringify(decisionsData.decisions))}
                />
            </div>
            <div className="max-w-5xl mx-auto mt-10">
                <ClientSuggestions
                    projectId={id}
                    initialProposals={JSON.parse(JSON.stringify(proposals))}
                    boards={boardsJson}
                />
            </div>
            <div className="max-w-5xl mx-auto mt-10">
                <ProjectFavoritesSection
                    projectId={id}
                    initialFavorites={JSON.parse(JSON.stringify(favorites))}
                />
            </div>
        </>
    );
}
