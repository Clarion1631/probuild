import { getMoodBoard } from "@/lib/actions";
import { notFound } from "next/navigation";
import Link from "next/link";
import MoodBoardEditor from "./MoodBoardEditor";

export default async function MoodBoardCanvasPage(props: { params: Promise<{ id: string; boardId: string }> }) {
    const { id, boardId } = await props.params;
    const board = await getMoodBoard(boardId);

    if (!board || board.projectId !== id) {
        return notFound();
    }

    return (
        <div className="h-[calc(100vh-8rem)] flex flex-col">
            <div className="flex items-center justify-between mb-4 shrink-0">
                <div className="flex items-center gap-4">
                    <Link href={`/projects/${id}/mood-boards`} className="text-slate-500 hover:text-slate-800 transition">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <h1 className="text-2xl font-bold text-hui-textMain">{board.title}</h1>
                </div>
            </div>

            {/* The Editor takes over the remaining height */}
            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl overflow-hidden shadow-inner relative">
                <MoodBoardEditor board={JSON.parse(JSON.stringify(board))} />
            </div>
        </div>
    );
}
