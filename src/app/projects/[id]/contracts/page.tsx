import { getProject, getDocumentTemplates } from "@/lib/actions";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import ProjectContractsClient from "./ProjectContractsClient";

export const dynamic = "force-dynamic";

export default async function ProjectContractsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) notFound();

    const templates = await getDocumentTemplates();

    // Lead/project parity (see lead-side page.tsx): fetch all executed PDF
    // ProjectFiles for this project in one pass, then match to contracts by the
    // naming convention set in /api/portal/contracts/[id]/finalize/route.ts.
    // New files embed the contractId (`Executed_Contract_{contractId}.pdf`);
    // legacy files use the safe-title prefix.
    const executedFiles = await prisma.projectFile.findMany({
        where: {
            projectId: project.id,
            mimeType: "application/pdf",
            name: { contains: "Executed_Contract_" },
        },
        orderBy: { createdAt: "desc" },
        select: { name: true, url: true },
    });

    const findExecutedPdfUrl = (contractId: string, title: string) => {
        const exactName = `Executed_Contract_${contractId}.pdf`;
        const byId = executedFiles.find(f => f.name === exactName);
        if (byId) return byId.url;
        const safeName = `Executed_Contract_${title.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        return executedFiles.find(f => f.name.startsWith(safeName))?.url || null;
    };

    const contracts = (project.contracts || []).map((c: any) => ({
        ...c,
        executedPdfUrl: findExecutedPdfUrl(c.id, c.title),
    }));

    return (
        <div className="max-w-5xl mx-auto">
            <ProjectContractsClient
                projectId={id}
                projectName={project.name}
                clientName={project.client?.name || "Client"}
                contracts={JSON.parse(JSON.stringify(contracts))}
                templates={JSON.parse(JSON.stringify(templates || []))}
            />
        </div>
    );
}
