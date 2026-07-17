import FileBrowser from "@/components/FileBrowser";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function LeadFilesPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUserWithPermissions();
    const canSeeFinancial = user ? hasPermission(user, "financialReports") : false;

    return (
        <div className="max-w-6xl mx-auto">
            <FileBrowser leadId={id} canSeeFinancial={canSeeFinancial} showVisibilityTabs />
        </div>
    );
}
