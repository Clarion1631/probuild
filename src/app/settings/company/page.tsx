import { getCompanySettings } from "@/lib/actions";
import CompanySettingsClient from "./CompanySettingsClient";

export default async function CompanySettingsPage() {
    const initialSettings = await getCompanySettings();

    return (
        <div className="flex h-full">
            {/* Secondary Sidebar */}
            <div className="w-64 border-r border-hui-border bg-hui-background flex-shrink-0 h-full overflow-y-auto">
                <div className="p-6">
                    <h2 className="text-xl font-bold text-hui-textMain mb-6">Settings</h2>
                    
                    <div className="mb-6">
                        <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-3">Company Settings</h3>
                        <ul className="space-y-1">
                            <li><a href="#" className="block px-3 py-2 text-sm font-medium bg-slate-200 text-hui-textMain rounded-md">Company Info</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Business Documents</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Workday Exceptions</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Communications</a></li>
                        </ul>
                    </div>
                    
                    <div className="mb-6">
                        <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-3">Account Settings</h3>
                        <ul className="space-y-1">
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Subscriptions</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Account Billing</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Notifications</a></li>
                        </ul>
                    </div>
                    
                    <div>
                        <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-3">Integrations</h3>
                        <ul className="space-y-1">
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Clipper Tool</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Calendar</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Google Drive</a></li>
                            <li><a href="#" className="block px-3 py-2 text-sm text-hui-textMuted hover:bg-slate-100 rounded-md">Zapier</a></li>
                        </ul>
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-[600px] py-8 px-6">
                    <div className="mb-8">
                        <h1 className="text-2xl font-bold text-hui-textMain">Company Settings</h1>
                        <p className="text-sm text-hui-textMuted mt-1">Manage your company's profile information. This data will be used on estimates, invoices, and the customer portal.</p>
                    </div>

                    <CompanySettingsClient initialData={initialSettings} />
                </div>
            </div>
        </div>
    );
}
