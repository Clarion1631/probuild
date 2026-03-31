import { getChangeOrder, getProject } from "@/lib/actions";
import { notFound } from "next/navigation";
import ChangeOrderEditor from "./ChangeOrderEditor";

export const dynamic = "force-dynamic";

export default async function ChangeOrderPage({
    params
}: {
    params: Promise<{ id: string; coId: string }>
}) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);
    const co = await getChangeOrder(resolvedParams.coId);

    if (!project) return <div>Project not found</div>;
    if (!co) { 
        notFound();
    }

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden">
            <div className="flex-1 bg-slate-50 overflow-hidden flex flex-col">
                <ChangeOrderEditor
                    context={{
                        projectId: project.id,
                        projectName: project.name,
                        clientName: project.client.name,
                        clientEmail: project.client.email || undefined,
                        location: project.location || undefined
                    }}
                    initialData={co}
                />
            </div>
        </div>
    );
}
