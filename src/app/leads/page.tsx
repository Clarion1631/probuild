import Avatar from "@/components/Avatar";
import { getLeads } from "@/lib/actions";

export default async function LeadsPage() {
    const leads = await getLeads();

    return (
        <div className="flex flex-col h-full bg-slate-50">
            <div className="bg-white border-b border-hui-border">
                <div className="flex items-center justify-between p-6">
                    <h1 className="text-xl font-bold text-hui-textMain">Active Leads</h1>
                    <div className="flex items-center gap-3">
                        <button className="hui-btn hui-btn-secondary">Contact Form</button>
                        <button className="hui-btn hui-btn-secondary">Insights</button>
                        <button className="hui-btn hui-btn-primary">Add Leads</button>
                    </div>
                </div>
            </div>

            <div className="p-6 flex-1 flex">
                <div className="w-56 pr-6 hidden md:block">
                    <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-4">Active Leads</h3>
                    <ul className="space-y-1 text-sm">
                        <li className="flex justify-between items-center bg-slate-200 px-3 py-2 rounded text-slate-800 font-medium cursor-pointer">
                            <span>All Active Leads</span>
                            <span>59</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-slate-600 transition cursor-pointer">
                            <span>New</span>
                            <span>15</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-slate-600 transition cursor-pointer">
                            <span>Closed</span>
                            <span>9</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-slate-600 transition cursor-pointer">
                            <span>Followed Up</span>
                            <span>6</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-slate-600 transition cursor-pointer">
                            <span>Estimate Sent</span>
                            <span>13</span>
                        </li>
                        <li className="flex justify-between items-center hover:bg-slate-200/50 px-3 py-2 rounded text-slate-600 transition cursor-pointer">
                            <span>Won</span>
                            <span>15</span>
                        </li>
                    </ul>
                </div>

                <div className="flex-1 hui-card overflow-hidden flex flex-col">
                    <div className="border-b border-hui-border p-4">
                        <div className="flex items-center gap-4">
                            <input type="text" placeholder="Search" className="hui-input w-64" />
                            <select className="hui-input w-auto"><option>All Project Types</option></select>
                            <select className="hui-input w-auto"><option>All Lead Sources</option></select>
                            <select className="hui-input w-auto"><option>Tags</option></select>
                        </div>
                    </div>

                    <div className="flex-1 overflow-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-hui-textMuted border-b border-hui-border">
                                <tr>
                                    <th className="px-4 py-3 font-medium font-normal">Lead Name</th>
                                    <th className="px-4 py-3 font-medium font-normal">Stage</th>
                                    <th className="px-4 py-3 font-medium font-normal">Client Name</th>
                                    <th className="px-4 py-3 font-medium font-normal">Location</th>
                                    <th className="px-4 py-3 font-medium font-normal">Lead Source</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {leads.map((l: any) => (
                                    <tr key={l.id} className="hover:bg-slate-50 cursor-pointer transition">
                                        <td className="px-4 py-4 font-medium text-hui-textMain"><a href={`/leads/${l.id}`} className="hover:text-hui-primary">{l.name}</a></td>
                                        <td className="px-4 py-4 text-slate-700">{l.stage}</td>
                                        <td className="px-4 py-4">
                                            <div className="flex items-center gap-2">
                                                <Avatar name={l.client.name} color="blue" />
                                                <span className="text-slate-700">{l.client.name}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-4 text-slate-600">{l.location}</td>
                                        <td className="px-4 py-4 text-slate-600">{l.source}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}
