import { getEstimate, getProject } from "@/lib/actions";
import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";
import EstimateEditor from "./EstimateEditor";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EstimatePage({ params }: { params: Promise<{ id: string, estimateId: string }> }) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);
    const estimate = await getEstimate(resolvedParams.estimateId);

    if (!project || !estimate) {
        notFound();
    }

    return (
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden">
            <ProjectInnerSidebar projectId={resolvedParams.id} />

            <div className="flex-1 overflow-auto bg-slate-50">
                <EstimateEditor project={project} initialEstimate={estimate} />
            </div>
        </div>
    );
}
