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

    const board = await getMoodBoard(boardId);
    if (!board || board.projectId !== id) return notFound();

    // Ownership check: PortalVisibility only gates whether mood boards are
    // enabled for the project, not whether this session may see THIS
    // project's boards — without this a client authenticated on a different
    // project could read another project's board by id.
    let isStaff: boolean;
    try {
        ({ isStaff } = await getPortalMoodBoardAccess(id));
    } catch (e) {
        if (e instanceof Error && e.message === "Unauthorized") return notFound();
        throw e;
    }

    // Staff add images from their own editor (MoodBoardEditor.tsx) — the
    // portal photo-upload tray posts to /api/portal/files, which always marks
    // uploads as client-originated, so staff must not see that upload option
    // here.
    const canUpload = visibility.showFiles && !isStaff;

    // Tray content the client can drop onto the board: project selection
    // option images, plus their own favorites/suggestions — but favorites and
    // proposals are gated on showSelections, which can be off while mood
    // boards stay on, so both are best-effort and fall back to [] rather than
    // taking the whole page down.
    const [selectionImages, favorites, proposals] = await Promise.all([
        prisma.selectionOption.findMany({
            where: { category: { board: { projectId: id } }, imageUrl: { not: null } },
            select: { id: true, name: true, imageUrl: true },
        }),
        getProjectFavoritesForPortal(id).catch(() => [] as Awaited<ReturnType<typeof getProjectFavoritesForPortal>>),
        getSelectionProposalsForPortal(id).catch(() => [] as Awaited<ReturnType<typeof getSelectionProposalsForPortal>>),
    ]);

    const trayByKey = new Map<string, { key: string; name: string; imageUrl: string }>();
    for (const opt of selectionImages) {
        if (isHttpUrl(opt.imageUrl)) trayByKey.set(`selection-${opt.id}`, { key: `selection-${opt.id}`, name: opt.name, imageUrl: opt.imageUrl });
    }
    for (const fav of favorites) {
        const imageUrl = (fav as any).product?.imageUrl;
        if (isHttpUrl(imageUrl)) trayByKey.set(`favorite-${fav.id}`, { key: `favorite-${fav.id}`, name: (fav as any).product?.name || "Favorite", imageUrl });
    }
    for (const prop of proposals) {
        if (isHttpUrl((prop as any).imageUrl)) trayByKey.set(`proposal-${prop.id}`, { key: `proposal-${prop.id}`, name: (prop as any).name || "Suggestion", imageUrl: (prop as any).imageUrl });
    }
    const tray = Array.from(trayByKey.values());

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
                    tray={tray}
                />
            </div>
        </div>
    );
}
