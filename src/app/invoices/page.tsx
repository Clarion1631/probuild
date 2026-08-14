export const dynamic = "force-dynamic";
import { getAllInvoices } from "@/lib/actions";
import GlobalInvoiceListClient from "./GlobalInvoiceListClient";

export default async function GlobalInvoicesPage() {
    // Invoice money fields are Prisma Decimals — serialize before crossing the server->client boundary.
    const invoices = JSON.parse(JSON.stringify(await getAllInvoices()));

    return (
        <div className="flex h-full bg-hui-background">
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-7xl mx-auto space-y-6">
                    <GlobalInvoiceListClient invoices={invoices} />
                </div>
            </div>
        </div>
    );
}

