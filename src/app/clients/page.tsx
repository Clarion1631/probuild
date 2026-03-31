import { getClients } from "@/lib/actions";
import Link from "next/link";
import Avatar from "@/components/Avatar";
import AddClientModalClientWrapper from "./AddClientModalClientWrapper";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
    const clients = await getClients();

    // Calculate metrics
    const totalClients = clients.length;
    let activeClients = 0;
    let totalRevenue = 0;

    const enrichedClients = clients.map(client => {
        let clientRevenue = 0;
        let hasOpenProjects = false;

        client.projects.forEach(project => {
            if (project.status === "In Progress" || project.status === "Paid Ready to Start") {
                hasOpenProjects = true;
            }
            project.estimates.forEach(est => {
                if (est.status !== "Draft") {
                    clientRevenue += est.totalAmount || 0;
                }
            });
        });

        if (hasOpenProjects) activeClients++;
        totalRevenue += clientRevenue;

        return {
            ...client,
            clientRevenue,
            hasOpenProjects,
            projectsCount: client.projects.length
        };
    });

    return (
        <div className="p-6 max-w-7xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-hui-textMain">Clients</h1>
                <AddClientModalClientWrapper />
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="hui-card p-4 flex flex-col">
                    <span className="text-sm text-hui-textMuted font-medium">Total Clients</span>
                    <span className="text-2xl font-bold text-hui-textMain mt-1">{totalClients}</span>
                </div>
                <div className="hui-card p-4 flex flex-col">
                    <span className="text-sm text-hui-textMuted font-medium">Active Clients</span>
                    <span className="text-2xl font-bold text-hui-textMain mt-1">{activeClients}</span>
                </div>
                <div className="hui-card p-4 flex flex-col">
                    <span className="text-sm text-hui-textMuted font-medium">Total Revenue</span>
                    <span className="text-2xl font-bold text-hui-textMain mt-1">
                        ${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </div>
            </div>

            {/* List */}
            <div className="hui-card overflow-hidden">
                <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-slate-50 border-b border-hui-border text-hui-textMuted">
                        <tr>
                            <th className="px-4 py-3 font-semibold">Client Name</th>
                            <th className="px-4 py-3 font-semibold">Company</th>
                            <th className="px-4 py-3 font-semibold">Contact</th>
                            <th className="px-4 py-3 font-semibold text-right">Projects</th>
                            <th className="px-4 py-3 font-semibold text-right">Total Revenue</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {enrichedClients.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="p-8 text-center text-hui-textMuted">
                                    No clients found. Add one to get started.
                                </td>
                            </tr>
                        ) : (
                            enrichedClients.map((client) => (
                                <tr key={client.id} className="hover:bg-slate-50 transition relative group">
                                    <td className="px-4 py-3">
                                        <Link href={`/clients/${client.id}`} className="absolute inset-0" />
                                        <div className="flex items-center gap-3">
                                            <Avatar initials={client.initials} size="sm" />
                                            <span className="font-medium text-hui-textMain group-hover:text-hui-primary transition">
                                                {client.name}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMuted">{client.companyName || "—"}</td>
                                    <td className="px-4 py-3">
                                        <div className="flex flex-col">
                                            <span className="text-hui-textMain">{client.email || "—"}</span>
                                            <span className="text-xs text-hui-textMuted">{client.primaryPhone || ""}</span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-medium ${client.projectsCount > 0 ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                                            {client.projectsCount} {client.projectsCount === 1 ? 'Project' : 'Projects'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-right font-medium text-hui-textMain">
                                        ${client.clientRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
