export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getCompanySettings } from "@/lib/actions";
import SalesTaxesClient from "./SalesTaxesClient";

export default async function SalesTaxesPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const settings = await getCompanySettings();
    const taxes = settings?.salesTaxes ? JSON.parse(settings.salesTaxes) : [];
    return <SalesTaxesClient initialTaxes={taxes} />;
}
