import { getLead, getContract } from "@/lib/actions";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ContractEditPage({ params }: {
    params: Promise<{ id: string; contractId: string }>;
}) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);
    const contract = await getContract(resolvedParams.contractId);

    if (!lead || !contract) notFound();

    // If the contract doesn't belong to this lead, redirect
    if (contract.leadId !== lead.id) {
        redirect(`/leads/${lead.id}/contracts`);
    }

    // Redirect to the contracts list page — the editor opens inline
    redirect(`/leads/${lead.id}/contracts`);
}
