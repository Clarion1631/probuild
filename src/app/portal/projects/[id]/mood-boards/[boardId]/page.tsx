import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import {
    getPortalVisibility,
    getMoodBoard,
    getProjectFavoritesForPortal,
    getSelectionProposalsForPortal,
    getPortalMoodBoardAccess,
} from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import Link from "next/link";
import PortalMoodBoardViewer from "./PortalMoodBoardViewer";

export default async function PortalMoodBoardCanvasPage(props: { params: Promise<{ id: string; boardId: string }> }) {
    const { id, boardId } = await props.params;

    const visibility = await getPortalVisibility(id);
    if (!visibility.isPortalEnabled || !visibility.showMoodBoards) {
        return notFound();
    }

    // Ownership check: PortalVisibility only gates whether mood boards are
    // enabled for the project, not whether this session may see THIS
    // project's boards — without this a client authenticated on a different
    // project could read another project's board by id. Runs before
    // getMoodBoard both to avoid a wasted query for unauthorized visitors and
    // because getMoodBoard now runs its own ownership check (on the board's
    // actual project, which may differ from `id` for a bogus boardId) —
    // sharing this try/catch means that throw is caught too.
    let isStaff: boolean;
    let board: Awaited<ReturnType<typeof getMoodBoard>>;
    try {
        ({ isStaff } = await getPortalMoodBoardAccess(id));
        board = await getMoodBoard(boardId);
    } catch (e) {
        if (e instanceof Error && e.message === "Unauthorized") return notFound();
        throw e;
    }
    if (!board || board.projectId !== id) return notFound();

    // Staff add images from their own editor (MoodBoardEditor.tsx) — the
    // portal photo-upload tray posts to /api/portal/files, which always marks
    // uploads as client-originated, so staff must not see that upload option
    // here.
    const canUpload = visibility.showFiles && !isStaff;

    // Library content the client can toggle onto the board: project selection
    // option images grouped by category, plus their own favorites/suggestions
    // — but favorites and proposals are gated on showSelections, which can be
    // off while mood boards stay on, so both are best-effort and fall back to
    // [] rather than taking the whole page down.
    const [selectionCategories, favorites, proposals] = await Promise.all([
        prisma.selectionCategory.findMany({
            where: { board: { projectId: id } },
            orderBy: [{ board: { createdAt: "asc" } }, { order: "asc" }],
            select: {
                name: true,
                options: {
                    orderBy: { order: "asc" },
                    select: { id: true, name: true, imageUrl: true, price: true },
                },
            },
        }),
        getProjectFavoritesForPortal(id).catch(() => [] as Awaited<ReturnType<typeof getProjectFavoritesForPortal>>),
        getSelectionProposalsForPortal(id).catch(() => [] as Awaited<ReturnType<typeof getSelectionProposalsForPortal>>),
    ]);

    // Dedupe by imageUrl WITHIN each group only — an option and a favorite may
    // legitimately share the same image, so dedup must not cross groups.
    function dedupeByImageUrl<T extends { imageUrl: string }>(entries: T[]): T[] {
        const seen = new Set<string>();
        const out: T[] = [];
        for (const entry of entries) {
            if (seen.has(entry.imageUrl)) continue;
            seen.add(entry.imageUrl);
            out.push(entry);
        }
        return out;
    }

    const categories = selectionCategories
        .map((cat) => ({
            categoryName: cat.name,
            items: dedupeByImageUrl(
                cat.options
                    .filter((opt) => isHttpUrl(opt.imageUrl))
                    .map((opt) => ({
                        key: `option-${opt.id}`,
                        name: opt.name,
                        imageUrl: opt.imageUrl as string,
                        price: opt.price != null ? Number(opt.price) : undefined,
                    }))
            ),
        }))
        .filter((cat) => cat.items.length > 0);

    const suggestions = dedupeByImageUrl(
        proposals
            .filter((prop) => isHttpUrl((prop as any).imageUrl))
            .map((prop) => ({ key: `proposal-${prop.id}`, name: (prop as any).name || "Suggestion", imageUrl: (prop as any).imageUrl as string }))
    );

    const favoriteEntries = dedupeByImageUrl(
        favorites
            .filter((fav) => isHttpUrl((fav as any).product?.imageUrl))
            .map((fav) => ({ key: `favorite-${fav.id}`, name: (fav as any).product?.name || "Favorite", imageUrl: (fav as any).product.imageUrl as string }))
    );

    const library = { categories, suggestions, favorites: favoriteEntries };

    return (
        <div className="h-[calc(100vh-8rem)] flex flex-col p-4">
            <div className="flex items-center justify-between mb-4 shrink-0">
                <div className="flex items-center gap-4">
                    <Link href={`/portal/projects/${id}/mood-boards`} className="text-slate-500 hover:text-slate-800 transition">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <h1 className="text-2xl font-bold text-hui-textMain">{board.title}</h1>
                </div>
            </div>

            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl overflow-hidden shadow-inner relative">
                <PortalMoodBoardViewer
                    boardId={boardId}
                    projectId={id}
                    items={JSON.parse(JSON.stringify(board.items))}
                    isStaff={isStaff}
                    canUpload={canUpload}
                    library={JSON.parse(JSON.stringify(library))}
                />
            </div>
        </div>
    );
}
