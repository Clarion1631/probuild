import { getMoodBoards, createMoodBoard, deleteMoodBoard } from "@/lib/actions";
import Link from "next/link";
import { revalidatePath } from "next/cache";

export default async function MoodBoardsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;
    const boards = await getMoodBoards(id);

    async function handleCreate(formData: FormData) {
        "use server";
        const title = formData.get("title") as string;
        if (title) {
            await createMoodBoard(id, title);
            revalidatePath(`/projects/${id}/mood-boards`);
        }
    }

    async function handleDelete(boardId: string) {
        "use server";
        await deleteMoodBoard(boardId);
        revalidatePath(`/projects/${id}/mood-boards`);
    }

    return (
        <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Mood Boards</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Visual presentation canvases for design concepts.
                    </p>
                </div>
            </div>

            {/* Create Board Form */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 mb-8 shadow-sm">
                <form action={handleCreate} className="flex gap-4">
                    <input
                        type="text"
                        name="title"
                        placeholder="New Mood Board Title (e.g. Master Bath Concept)"
                        className="hui-input flex-1"
                        required
                    />
                    <button type="submit" className="hui-btn hui-btn-green shrink-0">
                        Create Mood Board
                    </button>
                </form>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {boards.map(board => (
                    <div key={board.id} className="hui-card flex flex-col overflow-hidden hover:shadow-md transition">
                        <Link href={`/projects/${id}/mood-boards/${board.id}`} className="flex-1 p-6 bg-slate-50 relative group">
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/5">
                                <span className="bg-white px-3 py-1.5 rounded-md text-sm font-semibold text-slate-800 shadow-sm">
                                    Open Canvas
                                </span>
                            </div>
                            <h3 className="text-lg font-bold text-slate-800 mb-1">{board.title}</h3>
                            <p className="text-sm text-slate-500">{board.items.length} items</p>
                            <p className="text-xs text-slate-400 mt-4">
                                Created {new Date(board.createdAt).toLocaleDateString()}
                            </p>
                        </Link>
                        <div className="border-t border-slate-100 px-4 py-3 bg-white flex justify-end">
                            <form action={handleDelete.bind(null, board.id)}>
                                <button type="submit" className="text-sm text-red-500 hover:text-red-700 font-medium">
                                    Delete
                                </button>
                            </form>
                        </div>
                    </div>
                ))}

                {boards.length === 0 && (
                    <div className="col-span-full py-12 text-center text-slate-500">
                        No mood boards created yet.
                    </div>
                )}
            </div>
        </div>
    );
}
