export const dynamic = "force-dynamic";
import { getAllInvoices } from "@/lib/actions";
import { listReceivables } from "@/lib/billing-core";
import GlobalInvoiceListClient from "./GlobalInvoiceListClient";
import InvoiceLifecycleRadar from "./InvoiceLifecycleRadar";

export default async function GlobalInvoicesPage() {
    const [invoices, receivables] = await Promise.all([getAllInvoices(), listReceivables()]);

    return (
        <div className="flex h-full bg-hui-background">
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-7xl mx-auto space-y-6">
                    <InvoiceLifecycleRadar receivables={receivables} />
                    <GlobalInvoiceListClient invoices={invoices} />
                </div>
            </div>
        </div>
    );
}

