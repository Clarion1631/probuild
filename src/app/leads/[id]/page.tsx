import Avatar from "@/components/Avatar";
import { getLead, convertLeadToProject } from "@/lib/actions";
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

            {/* Lead Primary Context Column */}
            <div className="flex-1 flex flex-col border-r border-hui-border bg-white">
                <div className="p-6 border-b border-hui-border flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Avatar name={lead.client.name} color="blue" />
                        <h1 className="text-xl font-bold text-hui-textMain">{lead.name}</h1>
                    </div>
                    <form action={handleConvert}>
                        <button type="submit" className="hui-btn hui-btn-primary">
                            Convert to Project
                        </button>
                    </form>
                </div>

                {/* Lead Messaging Flow Mock */}
                <div className="flex-1 overflow-auto p-6 bg-hui-background">
                    <div className="hui-card p-6 mb-6">
                        <div className="flex gap-4">
                            <Avatar name={lead.client.name} color="blue" />
                            <div>
                                <strong className="text-sm text-hui-textMain block mb-1">Contact Name: {lead.client.name}</strong>
                                <p className="text-xs text-hui-textMuted mb-4">Project Location: {lead.location}</p>
                                <p className="text-sm text-hui-textMain leading-relaxed bg-hui-background p-4 rounded border border-hui-border">
                                    Hi there, <br /><br />
                                    I have a piece of land where I would like to build a new home, and I also have another property where I'm planning a full house remodel. I'm interested in scheduling a consultation to discuss both projects.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="hui-card p-4 flex gap-4 mt-auto">
                        <input type="text" placeholder="Type a message..." className="hui-input flex-1" />
                        <button className="hui-btn hui-btn-primary">Send</button>
                    </div>
                </div>
            </div>

            {/* Lead Secondary Navbar/Details */}
            <div className="w-80 bg-white overflow-y-auto">
                <div className="p-6 border-b border-hui-border">
                    <h3 className="font-semibold text-hui-textMain text-sm mb-4 flex justify-between">Client Details <span className="text-hui-primary font-normal cursor-pointer text-xs">Edit</span></h3>
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between"><span className="text-hui-textMuted">Name</span><span className="text-hui-textMain font-medium">{lead.client.name}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Email</span><span className="text-hui-textMain">{lead.client.email || "N/A"}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Phone</span><span className="text-hui-textMain">N/A</span></div>
                    </div>
                </div>

                <div className="p-6 border-b border-hui-border">
                    <h3 className="font-semibold text-hui-textMain text-sm mb-4">Lead Details</h3>
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between"><span className="text-hui-textMuted">Lead Stage</span><span className="font-medium text-hui-textMain">{lead.stage}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Lead Source</span><span className="text-hui-textMain">{lead.source}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Expected Start Date</span><span className="text-blue-600 cursor-pointer text-xs">+ Add</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Target Revenue</span><span className="text-blue-600 cursor-pointer text-xs">+ Add</span></div>
                    </div>
                </div>

                {/* Important Workflow connection to Estimates */}
                <div className="p-6">
                    <h3 className="font-semibold text-hui-textMain text-sm mb-4">Financials & Planning</h3>
                    <ul className="space-y-2 text-sm">
                        <li><a href="#" className="flex justify-between items-center text-hui-textMuted hover:text-blue-600 py-1 transition"><span>Estimates</span><span className="bg-hui-background text-xs px-2 rounded-full border border-hui-border">{lead.estimates.length}</span></a></li>
                        <li><a href="#" className="flex justify-between items-center text-hui-textMuted hover:text-blue-600 py-1 transition"><span>Takeoffs</span><span className="bg-hui-background text-xs px-2 rounded-full border border-hui-border">0</span></a></li>
                        <li><a href="#" className="flex justify-between items-center text-hui-textMuted hover:text-blue-600 py-1 transition"><span>Contracts</span><span className="bg-hui-background text-xs px-2 rounded-full border border-hui-border">0</span></a></li>
                    </ul>
                </div>

            </div>
        </div>
    );
}
