export const dynamic = "force-dynamic";
import { getCompanySettings } from "@/lib/actions";
import PaymentMethodsClient from "./PaymentMethodsClient";

export default async function PaymentMethodsPage() {
    const settings = await getCompanySettings();
    return (
        <div className="max-w-[600px] py-8 px-6">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-hui-textMain">Payment Methods</h1>
                <p className="text-sm text-hui-textMuted mt-1">Configure how clients can pay invoices through the client portal.</p>
            </div>
            <PaymentMethodsClient initialSettings={settings} />
        </div>
    );
}
