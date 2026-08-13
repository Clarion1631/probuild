import { getChangeOrder, getProject } from "@/lib/actions";
import { notFound } from "next/navigation";
import ChangeOrderEditor from "./ChangeOrderEditor";
import { resolveDocUrl } from "@/lib/secure-storage";

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

    // totalAmount/balanceDue are Prisma Decimals — serialize before crossing the
    // server->client boundary (the portal twin already JSON-serializes the same shape).
    const initialData = JSON.parse(JSON.stringify({
        ...co,
        clientSignatureUrl: await resolveDocUrl((co as any).clientSignatureUrl),
        companySignatureUrl: await resolveDocUrl((co as any).companySignatureUrl),
    }));

    return (
        <div className="flex h-[calc(100%+48px)] -m-6 overflow-hidden">
            <div className="flex-1 bg-slate-50 overflow-hidden flex flex-col">
                <ChangeOrderEditor
                    context={{
                        projectId: project.id,
                        projectName: project.name,
                        clientName: project.client.name,
                        clientEmail: project.client.email || undefined,
                        location: project.location || undefined
                    }}
                    initialData={initialData}
                />
            </div>
        </div>
    );
}
