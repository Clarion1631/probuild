import { getCompanySettings } from "@/lib/actions";
import CompanySettingsClient from "./CompanySettingsClient";

export default async function CompanySettingsPage() {
    const initialSettings = await getCompanySettings();

    return (
        <div className="max-w-3xl mx-auto py-8">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-slate-900">Company Settings</h1>
                <p className="text-sm text-slate-500 mt-1">Manage your company's profile information. This data will be used on estimates, invoices, and the customer portal.</p>
            </div>

            <CompanySettingsClient initialData={initialSettings} />
        </div>
    );
}
