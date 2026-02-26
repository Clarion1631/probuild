import { getEstimateForPortal, getCompanySettings } from "@/lib/actions";
import { notFound } from "next/navigation";
import PortalEstimateClient from "./PortalEstimateClient";

export default async function PortalEstimatePage({ params }: { params: { id: string } }) {
    // Next.js 15: wait for params
    const resolvedParams = await Promise.resolve(params);
    const estimate = await getEstimateForPortal(resolvedParams.id);
    const settings = await getCompanySettings();

    if (!estimate) {
        return notFound();
    }

    return <PortalEstimateClient initialEstimate={estimate} companySettings={settings} />;
}
