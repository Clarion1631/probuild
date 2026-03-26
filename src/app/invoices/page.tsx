import { getAllInvoices } from "@/lib/actions";
import GlobalInvoiceListClient from "./GlobalInvoiceListClient";

export default async function GlobalInvoicesPage() {
    const invoices = await getAllInvoices();

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
