import { getInvoiceForPortal, getCompanySettings } from "@/lib/actions";
import { notFound } from "next/navigation";
import PortalInvoiceClient from "./PortalInvoiceClient";

export default async function PortalInvoicePage({ params }: { params: { id: string } }) {
    const resolvedParams = await Promise.resolve(params);
    const invoice = await getInvoiceForPortal(resolvedParams.id);
    const settings = await getCompanySettings();

    if (!invoice) {
        return notFound();
    }

    return <PortalInvoiceClient initialInvoice={invoice} companySettings={settings} />;
}
