import { getQBSettings } from "@/lib/integration-store";
import { prisma } from "@/lib/prisma";
import QuickBooksClient from "./QuickBooksClient";

export const dynamic = "force-dynamic";

export default async function QuickBooksSettingsPage({
    searchParams,
}: {
    searchParams: Promise<{ success?: string; error?: string }>;
}) {
    const params = await searchParams;
    const [qbSettings, costCodes] = await Promise.all([
        getQBSettings(),
        prisma.costCode.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    ]);

    return (
        <div className="max-w-3xl py-8 px-6">
            <div className="mb-8">
                <div className="flex items-center gap-3 mb-1">
                    <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
                        <span className="text-lg font-bold text-green-700">QB</span>
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain">QuickBooks Online</h1>
                        <p className="text-sm text-hui-textMuted">Sync invoices, estimates, and expenses with QuickBooks.</p>
                    </div>
                </div>
            </div>

            <QuickBooksClient
                isConnected={qbSettings.connected}
                connectedAt={qbSettings.connectedAt}
                realmId={qbSettings.realmId}
                glMappings={qbSettings.glMappings || {}}
                costCodes={costCodes}
                successParam={params.success}
                errorParam={params.error}
            />
        </div>
    );
}
