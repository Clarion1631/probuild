import { getGustoSettings } from "@/lib/integration-store";
import { prisma } from "@/lib/prisma";
import GustoClient from "./GustoClient";

export const dynamic = "force-dynamic";

export default async function GustoSettingsPage({
    searchParams,
}: {
    searchParams: Promise<{ success?: string; error?: string }>;
}) {
    const params = await searchParams;
    const [gustoSettings, users] = await Promise.all([
        getGustoSettings(),
        prisma.user.findMany({
            where: { status: { not: "DISABLED" } },
            select: { id: true, name: true, email: true, role: true },
            orderBy: { name: "asc" },
        }),
    ]);

    return (
        <div className="max-w-3xl py-8 px-6">
            <div className="mb-8">
                <div className="flex items-center gap-3 mb-1">
                    <div className="w-10 h-10 rounded-lg bg-pink-100 flex items-center justify-center">
                        <span className="text-lg font-bold text-pink-700">GT</span>
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain">Gusto Payroll</h1>
                        <p className="text-sm text-hui-textMuted">Export time entries for payroll processing.</p>
                    </div>
                </div>
            </div>

            <GustoClient
                isConnected={gustoSettings.connected}
                connectedAt={gustoSettings.connectedAt}
                companyId={gustoSettings.companyId}
                employeeMappings={gustoSettings.employeeMappings || {}}
                users={users}
                successParam={params.success}
                errorParam={params.error}
            />
        </div>
    );
}
