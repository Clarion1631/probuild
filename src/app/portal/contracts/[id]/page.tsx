import { getContract, getCompanySettings } from "@/lib/actions";
import { notFound } from "next/navigation";
import PortalContractClient from "./PortalContractClient";

export const dynamic = "force-dynamic";

export default async function PortalContractPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const contract = await getContract(resolvedParams.id);
    const settings = await getCompanySettings();

    if (!contract) {
        notFound();
    }

    return <PortalContractClient initialContract={contract} companySettings={settings} />;
}
