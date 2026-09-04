import { getGustoSettings } from "@/lib/integration-store";
import { prisma } from "@/lib/prisma";
import { canAccessGusto } from "@/lib/gusto-access";
import { payrollEligibleUserWhere } from "@/lib/payroll-config";
import GustoClient from "./GustoClient";

export const dynamic = "force-dynamic";

export default async function GustoSettingsPage({
    searchParams,
}: {
    searchParams: Promise<{ success?: string; error?: string }>;
}) {
    // The page renders the employee map and the connection state, and it is the
    // only surface that drives the (previously ungated) mapping write. Same gate
    // as the routes and the payroll export.
    if (!(await canAccessGusto())) {
        return <div className="p-8 text-red-500">Access Denied. Payroll access required.</div>;
    }

    const params = await searchParams;
    const [gustoSettings, users] = await Promise.all([
        getGustoSettings(),
        prisma.user.findMany({
            // STAFF ONLY. This list is the whole menu the mapping editor offers,
            // and a portal CLIENT is a customer, not an employee — offering one
            // here is offering to file a customer's "hours" under a Gusto
            // employee (round 14, finding 2). The same predicate the export
            // roster, the rates panel, the CSV importer and the rate writer use,
            // so all five agree on who can appear on payroll at all.
            where: { status: { not: "DISABLED" }, ...payrollEligibleUserWhere() },
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
