import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { getPortalVisibility, getMoodBoards } from "@/lib/actions";
import Link from "next/link";

export default async function PortalMoodBoardsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;

    const visibility = await getPortalVisibility(id);
    if (!visibility.isPortalEnabled || !visibility.showMoodBoards) {
        return (
            <div className="max-w-3xl mx-auto py-16 px-4 text-center">
                <div className="bg-white border border-slate-200 rounded-xl p-8 shadow-sm">
                    <h2 className="text-xl font-bold text-slate-800 mb-2">Mood Boards Not Available</h2>
                    <p className="text-slate-500 mb-4">Mood boards are not currently enabled for this project.</p>
                    <Link href={`/portal/projects/${id}`} className="hui-btn hui-btn-primary">
                        Back to Project
                    </Link>
                </div>
            </div>
        );
    }

    const boards = await getMoodBoards(id);

    return (
        <div className="max-w-5xl mx-auto py-8 px-4">
            <div className="mb-6">
                <Link
                    href={`/portal/projects/${id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm w-fit"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Project
                </Link>
            </div>

            <div className="mb-8">
                <h1 className="text-3xl font-bold text-hui-textMain mb-2">Visual Mood Boards</h1>
                <p className="text-sm text-hui-textMuted">
                    Explore design concepts and material presentations.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {boards.map(board => (
                    <Link
                        key={board.id}
                        href={`/portal/projects/${id}/mood-boards/${board.id}`}
                        className="hui-card p-6 flex flex-col hover:border-hui-primary hover:shadow-md transition"
                    >
                        <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mb-4">
                            <svg className="w-6 h-6 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                        </div>
                        <h3 className="text-lg font-bold text-slate-800 mb-1">{board.title}</h3>
                        <p className="text-sm text-slate-500">{board.items.length} items</p>
                    </Link>
                ))}

                {boards.length === 0 && (
                    <div className="col-span-full py-12 text-center text-slate-500 hui-card">
                        No mood boards have been shared yet.
                    </div>
                )}
            </div>
        </div>
    );
}
