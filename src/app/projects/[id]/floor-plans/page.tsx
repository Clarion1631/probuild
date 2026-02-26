import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";
import Avatar from "@/components/Avatar";
import { getProject, createDraftFloorPlan } from "@/lib/actions";
import { redirect } from "next/navigation";
import { BoxSelect } from "lucide-react";

export default async function FloorPlansPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);

    if (!project) return <div className="p-6">Project not found</div>;

    const floorPlans = project.floorPlans || [];

    async function handleNewFloorPlan() {
        "use server";
        const result = await createDraftFloorPlan(resolvedParams.id);
        redirect(`/projects/${resolvedParams.id}/floor-plans/${result.id}`);
    }

    return (
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden">
            <ProjectInnerSidebar projectId={resolvedParams.id} />

            <div className="flex-1 overflow-auto p-6 bg-slate-50 flex flex-col items-center">
                <div className="w-full max-w-5xl">
                    <div className="flex items-center justify-between mb-8">
                        <h1 className="text-2xl font-bold text-slate-800">3D Floor Plans</h1>
                        <form action={handleNewFloorPlan}>
                            <button type="submit" className="bg-blue-600 text-white px-5 py-2 rounded-md text-sm font-medium shadow-sm hover:bg-blue-700 transition flex items-center gap-2">
                                <BoxSelect className="w-4 h-4" />
                                Create Floor Plan
                            </button>
                        </form>
                    </div>

                    {floorPlans.length === 0 ? (
                        <div className="bg-white border text-center border-slate-200 rounded-lg p-12 shadow-sm flex flex-col items-center">
                            <div className="bg-blue-50 text-blue-600 p-4 rounded-full mb-4">
                                <BoxSelect className="w-8 h-8" />
                            </div>
                            <h3 className="font-semibold text-slate-800 text-lg mb-2">No Floor Plans yet</h3>
                            <p className="text-sm text-slate-500 max-w-md mx-auto mb-6">Create stunning 2D and 3D floor plans to help your clients visualize their space. You can start from scratch or upload a RoomScan.</p>
                            <form action={handleNewFloorPlan}>
                                <button type="submit" className="bg-slate-900 text-white px-5 py-2 rounded-md text-sm font-medium shadow hover:bg-slate-800 transition">
                                    Start Designing
                                </button>
                            </form>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {floorPlans.map((fp: any) => (
                                <a key={fp.id} href={`/projects/${project.id}/floor-plans/${fp.id}`} className="group relative bg-white border border-slate-200 rounded-lg shadow-sm hover:shadow-md transition overflow-hidden block">
                                    <div className="bg-slate-100 aspect-video flex items-center justify-center border-b group-hover:bg-slate-200 transition">
                                        <BoxSelect className="w-10 h-10 text-slate-300 group-hover:text-white transition" />
                                    </div>
                                    <div className="p-4">
                                        <h3 className="font-semibold text-slate-800 mb-1">{fp.name}</h3>
                                        <p className="text-xs text-slate-500 flex items-center gap-2">
                                            Last modified: {new Date(fp.updatedAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                </a>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
