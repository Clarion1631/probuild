export const dynamic = "force-dynamic";
import { getCompanySettings } from "@/lib/actions";
import CompanySettingsClient from "./CompanySettingsClient";

export default async function CompanySettingsPage() {
    const initialSettings = await getCompanySettings();

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-[600px] py-8 px-6">
                <div className="mb-8">
                    <h1 className="text-2xl font-bold text-hui-textMain">Company Settings</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Manage your company's profile information. This data will be used on estimates, invoices, and the customer portal.</p>
                </div>

                <CompanySettingsClient initialData={initialSettings} />
            </div>
        </div>
    );
}
