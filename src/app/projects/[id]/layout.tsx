import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";
import { getProjectLead } from "@/lib/actions";

export default async function ProjectLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const lead = await getProjectLead(id);

    return (
        <div className="flex h-full -mx-6 -my-6 bg-slate-50">
            <ProjectInnerSidebar projectId={id} lead={lead ? { id: lead.id, name: lead.name } : null} />
            <div className="flex-1 p-6 overflow-y-auto w-full">
                {children}
            </div>
        </div>
    );
}
