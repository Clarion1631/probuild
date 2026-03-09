import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";

export default function ProjectLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: { id: string };
}) {
    return (
        <div className="flex h-full -mx-6 -my-6 bg-slate-50">
            {/* The Inner Sidebar expects to take up full height within its container */}
            <ProjectInnerSidebar projectId={params.id} />
            <div className="flex-1 p-6 overflow-y-auto w-full">
                {children}
            </div>
        </div>
    );
}
