export const dynamic = "force-dynamic";
import { getAllEstimates } from "@/lib/actions";
import Avatar from "@/components/Avatar";
import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Link from "next/link";
import NewEstimateButton from "./NewEstimateButton";
import { formatCurrency } from "@/lib/utils";
export default async function EstimatesPage() {
    const estimates = await getAllEstimates();

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-hui-background -m-6">
            <div className="bg-white border-b border-hui-border">
                <div className="flex items-center justify-between px-6 py-4">
                    <h1 className="text-xl font-bold text-hui-textMain">Estimates</h1>
                    <div className="flex items-center gap-3">
                        <NewEstimateButton />
                    </div>
                </div>
            </div>

            <div className="p-6 flex-1 flex flex-col">
                <div className="hui-card flex-1 flex flex-col overflow-hidden">
                    <div className="border-b border-hui-border p-4 flex items-center gap-4">
                        <input type="text" placeholder="Search" className="hui-input w-64" />
                        <select className="hui-input w-auto"><option>Date Created: All</option></select>
                        <select className="hui-input w-auto"><option>Type: All</option></select>
                    </div>

                    <div className="flex-1 overflow-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-hui-textMuted bg-slate-50 border-b border-hui-border sticky top-0 z-10">
                                <tr>
                                    <th className="px-4 py-3 font-medium">Title</th>
                                    <th className="px-4 py-3 font-medium">Recipient</th>
                                    <th className="px-4 py-3 font-medium">Project / Lead</th>
                                    <th className="px-4 py-3 font-medium">Code</th>
                                    <th className="px-4 py-3 font-medium">Status</th>
                                    <th className="px-4 py-3 font-medium">Shared</th>
                                    <th className="px-4 py-3 font-medium">Created</th>
                                    <th className="px-4 py-3 font-medium text-right">Total</th>
                                    <th className="px-4 py-3 font-medium text-right">Balance</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border">
                                {estimates.map((e: any) => {
                                    const recipientName = e.project?.client?.name || e.lead?.client?.name || "Unknown";
                                    const projectName = e.project?.name || e.lead?.name || "Unknown";
                                    const linkHref = e.projectId 
                                        ? `/projects/${e.projectId}/estimates/${e.id}`
                                        : `/leads/${e.leadId}`; // Basic fallback

                                    return (
                                        <tr key={e.id} className="hover:bg-slate-50 transition cursor-pointer">
                                            <td className="px-4 py-4 font-medium text-hui-textMain">
                                                <Link href={linkHref} className="hover:text-hui-primary hover:underline transition">
                                                    {e.title}
                                                </Link>
                                            </td>
                                            <td className="px-4 py-4">
                                                <div className="flex items-center gap-2">
                                                    <Avatar name={recipientName} color="green" />
                                                    <span className="text-hui-textMain">{recipientName}</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-4 text-hui-textMuted">{projectName}</td>
                                            <td className="px-4 py-4 text-hui-textMuted text-xs font-mono">{e.code}</td>
                                            <td className="px-4 py-4"><StatusBadge status={e.status as StatusType} /></td>
                                            <td className="px-4 py-4"><span className="bg-slate-100 px-2 py-1 rounded text-hui-textMuted text-xs border border-hui-border">{e.privacy}</span></td>
                                            <td className="px-4 py-4 text-hui-textMuted">{new Date(e.createdAt).toLocaleDateString()}</td>
                                            <td className="px-4 py-4 text-hui-textMain font-medium text-right">{formatCurrency(e.totalAmount)}</td>
                                            <td className={`px-4 py-4 font-medium text-right ${e.balanceDue > 0 ? "text-red-500" : "text-hui-textMain"}`}>{formatCurrency(e.balanceDue)}</td>
                                        </tr>
                                    );
                                })}
                                {estimates.length === 0 && (
                                    <tr>
                                        <td colSpan={9} className="px-4 py-8 text-center text-hui-textMuted">
                                            No estimates found.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}
