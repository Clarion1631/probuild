import { getContractForPortal, getCompanySettings, getPortalVisibility, getExecutedContractPdf } from "@/lib/actions";
import { notFound } from "next/navigation";
import PortalContractClient from "./PortalContractClient";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function PortalContractPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ token?: string }>;
}) {
    const resolvedParams = await params;
    const resolvedSearch = await searchParams;

    // Ownership gate: either a valid access token (from email magic link) or a portal
    // session whose email matches the lead/project client. Returns null on both miss — never
    // leak existence with a 403.
    const contract = await getContractForPortal(resolvedParams.id, resolvedSearch.token);
    if (!contract) {
        notFound();
    }

    const settings = await getCompanySettings();

    // Check portal visibility if contract belongs to a project
    if (contract!.projectId) {
        const visibility = await getPortalVisibility(contract!.projectId);
        if (!visibility.showContracts) {
            return (
                <div className="max-w-lg mx-auto py-16 text-center">
                    <div className="hui-card p-10">
                        <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-5">
                            <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                        </div>
                        <h2 className="text-xl font-bold text-hui-textMain mb-2">This section is not available</h2>
                        <p className="text-hui-textMuted text-sm mb-6">Contracts are not currently visible for this project. Please contact your project manager for more information.</p>
                        <Link href="/portal" className="hui-btn hui-btn-secondary">Back to Portal</Link>
                    </div>
                </div>
            );
        }
    }

    // Fetch the executed PDF file (if this contract has been signed & archived) so the client
    // can download it from the portal page instead of hunting through email.
    const archivedFile = await getExecutedContractPdf({
        id: contract.id,
        title: contract.title,
        projectId: contract.projectId,
        leadId: contract.leadId,
    });

    return (
        <PortalContractClient
            initialContract={contract}
            companySettings={settings}
            archivedPdfUrl={archivedFile?.url || null}
            accessToken={resolvedSearch.token || null}
        />
    );
}
