import Avatar from "@/components/Avatar";
import { getLeads } from "@/lib/actions";
import Link from "next/link";
import AddLeadButton from "./AddLeadButton";

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
    const resolvedParams = await searchParams;
    const view = resolvedParams.view || 'table';
    const leads = await getLeads();

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-hui-background -m-6">
            <div className="bg-white border-b border-hui-border">
                <div className="flex items-center justify-between px-6 py-4">
                    <h1 className="text-xl font-bold text-hui-textMain">Active Leads</h1>
                    <div className="flex items-center gap-3">
                        <button className="hui-btn hui-btn-secondary">Contact Form</button>
                        <button className="hui-btn hui-btn-secondary">Insights</button>
                        <AddLeadButton />
                    </div>
                </div>
            </div>

            <div className="p-6 flex-1 flex">
                <div className="w-56 pr-6 hidden md:block">
                    <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-4">Active Leads</h3>
                    <ul className="space-y-1 text-sm">
                        <li className="flex justify-between items-center bg-hui-background border border-hui-border px-3 py-2 rounded text-hui-textMain font-medium cursor-pointer">
                            <span>All Active Leads</span>
                            <span>59</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-hui-textMuted transition cursor-pointer">
                            <span>New</span>
                            <span>15</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-hui-textMuted transition cursor-pointer">
                            <span>Closed</span>
                            <span>9</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-hui-textMuted transition cursor-pointer">
                            <span>Followed Up</span>
                            <span>6</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-hui-textMuted transition cursor-pointer">
                            <span>Estimate Sent</span>
                            <span>13</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-hui-textMuted transition cursor-pointer">
                            <span>Won</span>
                            <span>15</span>
                        </li>
                    </ul>
                </div>

                <div className="flex-1 hui-card overflow-hidden flex flex-col">
                    <div className="border-b border-hui-border p-4 flex justify-between items-center">
                        <div className="flex items-center gap-4 flex-1">
                            <input type="text" placeholder="Search" className="hui-input w-64" />
                            <select className="hui-input w-auto"><option>All Project Types</option></select>
                            <select className="hui-input w-auto"><option>All Lead Sources</option></select>
                            <select className="hui-input w-auto"><option>Tags</option></select>
                        </div>
                        <div className="flex border border-hui-border rounded overflow-hidden bg-white">
                            <Link href="?view=table" className={`px-3 py-1.5 text-xs font-medium border-r border-hui-border transition ${view === 'table' ? 'bg-hui-background text-hui-textMain' : 'text-hui-textMuted hover:bg-slate-50'}`}>Table</Link>
                            <Link href="?view=kanban" className={`px-3 py-1.5 text-xs font-medium transition ${view === 'kanban' ? 'bg-hui-background text-hui-textMain' : 'text-hui-textMuted hover:bg-slate-50'}`}>Kanban</Link>
                        </div>
                    </div>

                    <div className="flex-1 overflow-auto bg-hui-background">
                        {leads.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-hui-textMuted p-12">
                                <p className="mb-4">No leads found. Create your first lead to get started.</p>
                                <AddLeadButton />
                            </div>
                        ) : view === 'table' ? (
                            <table className="w-full text-sm text-left bg-white">
                                <thead className="text-xs text-hui-textMuted border-b border-hui-border bg-white sticky top-0">
                                    <tr>
                                        <th className="px-4 py-3 font-medium">Lead Name</th>
                                        <th className="px-4 py-3 font-medium">Stage</th>
                                        <th className="px-4 py-3 font-medium">Client Name</th>
                                        <th className="px-4 py-3 font-medium">Location</th>
                                        <th className="px-4 py-3 font-medium">Lead Source</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border bg-white">
                                    {leads.map((l: any) => (
                                        <tr key={l.id} className="hover:bg-slate-50 cursor-pointer transition">
                                            <td className="px-4 py-4 font-medium text-hui-textMain"><Link href={`/leads/${l.id}`} className="hover:text-hui-primary transition">{l.name}</Link></td>
                                            <td className="px-4 py-4"><span className="bg-slate-100 text-hui-textMain text-xs px-2 py-1 rounded border border-hui-border">{l.stage}</span></td>
                                            <td className="px-4 py-4">
                                                <div className="flex items-center gap-2">
                                                    <Avatar name={l.client.name} color="blue" />
                                                    <span className="text-hui-textMain">{l.client.name}</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-4 text-hui-textMuted">{l.location}</td>
                                            <td className="px-4 py-4 text-hui-textMuted">{l.source}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="flex gap-4 h-full overflow-x-auto p-4 bg-hui-background">
                                {['New', 'Followed Up', 'Estimate Sent', 'Won', 'Closed'].map(stage => (
                                    <div key={stage} className="w-72 flex-shrink-0 flex flex-col gap-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="font-semibold text-hui-textMain text-sm">{stage}</h3>
                                            <span className="bg-slate-200 text-slate-600 text-xs px-2 py-0.5 rounded-full">{leads.filter((l: any) => l.stage === stage).length}</span>
                                        </div>
                                        {leads.filter((l: any) => l.stage === stage).map((l: any) => (
                                            <div key={l.id} className="hui-card p-4 hover:shadow-md transition cursor-pointer">
                                                <Link href={`/leads/${l.id}`} className="font-semibold text-hui-primary block mb-2 hover:underline">{l.name}</Link>
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Avatar name={l.client.name} color="blue" />
                                                    <p className="text-xs text-hui-textMain">{l.client.name}</p>
                                                </div>
                                                <p className="text-xs text-hui-textMuted">{l.location}</p>
                                            </div>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
