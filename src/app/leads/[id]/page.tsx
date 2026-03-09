import Avatar from "@/components/Avatar";
import { getLead, convertLeadToProject, createDraftLeadEstimate, deleteEstimate } from "@/lib/actions";
import { redirect } from "next/navigation";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);
    if (!lead) return <div className="p-6">Lead not found</div>;

    async function handleConvert() {
        "use server";
        const project = await convertLeadToProject(lead!.id);
        redirect(`/`); // Redirect to dashboard until projects details are fully built
    }

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            {/* Lead Dashboard Column */}
            <div className="flex-1 flex flex-col border-r border-hui-border bg-white overflow-y-auto">
                <div className="p-6 border-b border-hui-border flex items-center justify-between sticky top-0 bg-white z-10 shadow-sm">
                    <div className="flex items-center gap-4">
                        <Avatar name={lead.client.name} color="blue" />
                        <div>
                            <h1 className="text-xl font-bold text-hui-textMain">{lead.name}</h1>
                            <p className="text-sm text-hui-textMuted">{lead.client.name} • Stage: {lead.stage}</p>
                        </div>
                    </div>
                    <form action={handleConvert}>
                        <button type="submit" className="hui-btn hui-btn-primary">
                            Convert to Project
                        </button>
                    </form>
                </div>

                <div className="p-6 space-y-6 bg-slate-50 min-h-full">
                    {/* Cards for Details */}
                    <div className="grid grid-cols-2 gap-6">
                        <div className="hui-card p-6">
                            <h3 className="font-semibold text-hui-textMain text-sm mb-4 flex justify-between">Client Details <span className="text-hui-primary font-normal cursor-pointer text-xs">Edit</span></h3>
                            <div className="space-y-3 text-sm">
                                <div className="flex justify-between"><span className="text-hui-textMuted">Name</span><span className="text-hui-textMain font-medium">{lead.client.name}</span></div>
                                <div className="flex justify-between"><span className="text-hui-textMuted">Email</span><span className="text-hui-textMain">{lead.client.email || "N/A"}</span></div>
                                <div className="flex justify-between"><span className="text-hui-textMuted">Phone</span><span className="text-hui-textMain">N/A</span></div>
                            </div>
                        </div>
                        <div className="hui-card p-6">
                            <h3 className="font-semibold text-hui-textMain text-sm mb-4">Lead Details</h3>
                            <div className="space-y-3 text-sm">
                                <div className="flex justify-between"><span className="text-hui-textMuted">Lead Stage</span><span className="font-medium text-hui-textMain">{lead.stage}</span></div>
                                <div className="flex justify-between"><span className="text-hui-textMuted">Lead Source</span><span className="text-hui-textMain">{lead.source}</span></div>
                                <div className="flex justify-between"><span className="text-hui-textMuted">Expected Start Date</span><span className="text-blue-600 cursor-pointer text-xs">+ Add</span></div>
                                <div className="flex justify-between"><span className="text-hui-textMuted">Target Revenue</span><span className="text-blue-600 cursor-pointer text-xs">+ Add</span></div>
                            </div>
                        </div>
                    </div>

                    {/* Estimates Section */}
                    <div className="hui-card p-6 shadow-sm">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="font-semibold text-hui-textMain text-lg">Estimates</h3>
                            <form action={async () => {
                                "use server";
                                const est = await createDraftLeadEstimate(lead.id);
                                redirect(`/leads/${lead.id}/estimates/${est.id}`);
                            }}>
                                <button className="hui-btn hui-btn-primary text-sm shadow-sm hover:shadow transition">+ Create Estimate</button>
                            </form>
                        </div>

                        {lead.estimates.length === 0 ? (
                            <div className="text-center py-8 border border-dashed border-hui-border rounded-lg bg-slate-50">
                                <p className="text-sm text-hui-textMuted">No estimates created for this lead yet.</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-hui-border border border-hui-border rounded-lg bg-white overflow-hidden shadow-sm">
                                {lead.estimates.map((est: any) => (
                                    <div key={est.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition group">
                                        <div>
                                            <h4 className="font-medium text-sm text-hui-textMain mb-1 hover:text-blue-600"><a href={`/leads/${lead.id}/estimates/${est.id}`}>{est.title || "Draft Estimate"} ({est.code})</a></h4>
                                            <p className="text-xs text-hui-textMuted">
                                                Total: ${est.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} • Status: <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wider uppercase border ${est.status === 'Draft' ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-green-50 text-green-700 border-green-200'}`}>{est.status}</span>
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition">
                                            <a href={`/leads/${lead.id}/estimates/${est.id}`} className="text-hui-textMuted hover:text-blue-600 text-sm font-medium transition px-2 py-1">Edit</a>
                                            <form action={async () => {
                                                "use server";
                                                await deleteEstimate(est.id);
                                            }}>
                                                <button className="text-hui-textMuted hover:text-red-600 text-sm font-medium transition px-2 py-1">Delete</button>
                                            </form>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Lead Messaging Flow Mock (Right Sidebar) */}
            <div className="w-[450px] bg-hui-background flex flex-col z-10 shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.05)] border-l border-hui-border">
                <div className="p-5 border-b border-hui-border bg-white flex justify-between items-center shadow-sm">
                    <h3 className="font-semibold text-hui-textMain">Messages</h3>
                </div>
                
                <div className="flex-1 overflow-auto p-5 space-y-4 bg-slate-50/50">
                    <div className="hui-card p-4 shadow-sm">
                        <div className="flex gap-4">
                            <Avatar name={lead.client.name} color="blue" />
                            <div>
                                <strong className="text-sm text-hui-textMain block mb-0.5">{lead.client.name}</strong>
                                <p className="text-[10px] text-hui-textMuted mb-3 uppercase tracking-wider font-semibold">Today, 10:42 AM</p>
                                <p className="text-sm text-hui-textMain leading-relaxed bg-white p-3 rounded-lg border border-slate-200 shadow-sm text-slate-700">
                                    Hi there, <br /><br />
                                    I have a piece of land where I would like to build a new home, and I also have another property where I'm planning a full house remodel. I'm interested in scheduling a consultation to discuss both projects.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="p-4 border-t border-hui-border bg-white">
                    <div className="flex gap-3">
                        <input type="text" placeholder="Type a message..." className="hui-input flex-1 bg-slate-50 border-slate-200 focus:bg-white transition shadow-inner" />
                        <button className="hui-btn hui-btn-primary shadow-md hover:shadow-lg transition">Send</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
