export const dynamic = "force-dynamic";
import { getCompanySettings } from "@/lib/actions";
import NotificationsClient from "./NotificationsClient";

export default async function NotificationsPage() {
    const settings = await getCompanySettings();
    return (
        <div className="max-w-[600px] py-8 px-6">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-hui-textMain">Notifications</h1>
                <p className="text-sm text-hui-textMuted mt-1">Configure when and how you receive email alerts.</p>
            </div>
            <NotificationsClient initialEmail={settings?.notificationEmail ?? ""} />
        </div>
    );
}
