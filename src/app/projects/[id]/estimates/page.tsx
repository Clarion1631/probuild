import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";
import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Avatar from "@/components/Avatar";
import { getProject, createDraftEstimate } from "@/lib/actions";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function EstimatesPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);

    if (!project) return <div className="p-6">Project not found</div>;

    const estimates = project.estimates;

    async function handleNewEstimate() {
        "use server";
        const result = await createDraftEstimate(resolvedParams.id);
        redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
    }

    return (
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden">
            <ProjectInnerSidebar projectId={resolvedParams.id} />

            <div className="flex-1 overflow-auto p-6 bg-white flex justify-between gap-6">
                <div className="flex-1">
                    <div className="flex items-center justify-between mb-6">
                        <h1 className="text-xl font-bold text-slate-800">Estimates</h1>
                        <form action={handleNewEstimate}>
                            <button type="submit" className="bg-slate-900 text-white px-4 py-1.5 rounded text-sm font-medium shadow-sm hover:bg-slate-800 transition">
                                New Estimate
                            </button>
                        </form>
                    </div>

                    <div className="flex items-center gap-4 mb-4">
                        <input type="text" placeholder="Search" className="border border-slate-300 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-1 focus:ring-slate-400" />
                        <select className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white"><option>Date Created: 01/...</option></select>
                        <select className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white"><option>Type: Active</option></select>
                    </div>

                    <div className="border border-slate-200 rounded-md">
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-slate-500 bg-white border-b border-slate-200">
                                <tr>
                                    <th className="px-4 py-3 font-medium">Title</th>
                                    <th className="px-4 py-3 font-medium">Recipient</th>
                                    <th className="px-4 py-3 font-medium">Code</th>
                                    <th className="px-4 py-3 font-medium">Status</th>
                                    <th className="px-4 py-3 font-medium">Shared</th>
                                    <th className="px-4 py-3 font-medium">Created</th>
                                    <th className="px-4 py-3 font-medium text-right">Total</th>
                                    <th className="px-4 py-3 font-medium text-right">Balance</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {estimates.map((e: any) => (
                                    <tr key={e.id} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-4 font-medium text-blue-600 hover:underline">
                                            <Link href={`/projects/${project.id}/estimates/${e.id}`}>
                                                {e.title}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-4">
                                            <div className="flex items-center gap-2">
                                                <Avatar name={project.client.name} color="green" />
                                                <span className="text-slate-700">{project.client.name}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-4 text-slate-600 text-xs font-mono">{e.code}</td>
                                        <td className="px-4 py-4"><StatusBadge status={e.status as StatusType} /></td>
                                        <td className="px-4 py-4 text-slate-600 text-xs"><span className="bg-slate-100 px-2 py-1 rounded text-slate-700 border border-slate-200">{e.privacy}</span></td>
                                        <td className="px-4 py-4 text-slate-600">{new Date(e.createdAt).toLocaleDateString()}</td>
                                        <td className="px-4 py-4 text-slate-800 font-medium text-right">${e.totalAmount?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                        <td className={`px-4 py-4 font-medium text-right ${e.balanceDue > 0 ? "text-red-500" : "text-slate-800"}`}>${e.balanceDue?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="w-72 flex flex-col gap-6">
                    <div className="bg-white border text-center border-slate-200 rounded-md p-6 shadow-sm">
                        <h3 className="font-semibold text-slate-800 mb-2">Budget</h3>
                        <p className="text-xs text-slate-500 mb-4 px-2">Track your estimated costs against your actual spend. It all starts with an estimate.</p>
                        <button className="bg-slate-900 w-full text-white px-4 py-2 rounded text-sm font-medium shadow-sm hover:bg-slate-800 transition">Create a Budget</button>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-md p-6 shadow-sm">
                        <h3 className="font-semibold text-slate-800 mb-2">Total Estimated Cost</h3>
                        <p className="text-2xl font-bold text-slate-900 mb-6">$258,806.88</p>

                        <div className="space-y-4 text-sm">
                            <div>
                                <p className="text-slate-500 text-xs mb-1">Material</p>
                                <p className="font-medium text-slate-800">$183,128.01</p>
                            </div>
                            <div>
                                <p className="text-slate-500 text-xs mb-1">Labor</p>
                                <p className="font-medium text-slate-800">$54,964.75</p>
                            </div>
                            <div>
                                <p className="text-slate-500 text-xs mb-1">Tax</p>
                                <p className="font-medium text-slate-800">$20,714.12</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
