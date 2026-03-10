import { getEstimate, getProject } from "@/lib/actions";
import EstimateEditor from "./EstimateEditor";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EstimatePage({
    params
}: {
    params: Promise<{ id: string; estimateId: string }>
}) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);
    const estimate = await getEstimate(resolvedParams.estimateId);

    if (!project) return <div>Project not found</div>;
    if (!estimate) { 
        notFound();
    }

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden">
            <div className="flex-1 bg-slate-50 overflow-hidden flex flex-col">
                <EstimateEditor
                    context={{
                        type: "project",
                        id: project.id,
                        name: project.name,
                        clientName: project.client.name,
                        clientEmail: project.client.email || undefined,
                        location: project.location || undefined
                    }}
                    initialEstimate={estimate}
                />
            </div>
        </div>
    );
}
