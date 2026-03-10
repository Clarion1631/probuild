import { getProject, getDocumentTemplates, getContractSigningHistory, createContractFromTemplate, sendContractToClient, deleteContract } from "@/lib/actions";
import { notFound } from "next/navigation";
import ProjectContractsClient from "./ProjectContractsClient";

export const dynamic = "force-dynamic";

export default async function ProjectContractsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) notFound();

    const templates = await getDocumentTemplates();

    return (
        <div className="max-w-5xl mx-auto">
            <ProjectContractsClient
                projectId={id}
                projectName={project.name}
                clientName={project.client?.name || "Client"}
                contracts={JSON.parse(JSON.stringify(project.contracts || []))}
                templates={JSON.parse(JSON.stringify(templates || []))}
            />
        </div>
    );
}
