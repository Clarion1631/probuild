import FileBrowser from "@/components/FileBrowser";

export const dynamic = "force-dynamic";

export default async function ProjectFilesPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <div className="max-w-6xl mx-auto">
            <FileBrowser projectId={id} />
        </div>
    );
}
