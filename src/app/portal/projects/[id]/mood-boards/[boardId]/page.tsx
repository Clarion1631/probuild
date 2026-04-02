import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getPortalVisibility, getMoodBoard } from "@/lib/actions";
import Link from "next/link";
import PortalMoodBoardViewer from "./PortalMoodBoardViewer";

export default async function PortalMoodBoardCanvasPage(props: { params: Promise<{ id: string; boardId: string }> }) {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email?.toLowerCase();

    if (!email) {
        return <div className="p-8 text-center">Please log in to access your portal.</div>;
    }

    const { id, boardId } = await props.params;

    const visibility = await getPortalVisibility(id);
    if (!visibility.isPortalEnabled || !visibility.showMoodBoards) {
        return notFound();
    }

    const board = await getMoodBoard(boardId);
    if (!board || board.projectId !== id) return notFound();

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
                <PortalMoodBoardViewer items={board.items} />
            </div>
        </div>
    );
}
