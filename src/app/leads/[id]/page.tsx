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
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden bg-slate-50">

            {/* Lead Primary Context Column */}
            <div className="flex-1 flex flex-col border-r border-slate-200 bg-white">
                <div className="p-6 border-b border-slate-200 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Avatar name={lead.client.name} color="blue" />
                        <h1 className="text-xl font-bold text-slate-800">{lead.name}</h1>
                    </div>
                    <form action={handleConvert}>
                        <button type="submit" className="bg-slate-900 text-white px-4 py-2 rounded shadow-sm text-sm font-medium hover:bg-slate-800 transition">
                            Convert to Project
                        </button>
                    </form>
                </div>

                {/* Lead Messaging Flow Mock */}
                <div className="flex-1 overflow-auto p-6 bg-slate-50">
                    <div className="bg-white p-6 rounded-md shadow-sm border border-slate-200 mb-6">
                        <div className="flex gap-4">
                            <Avatar name={lead.client.name} color="blue" />
                            <div>
                                <strong className="text-sm text-slate-800 block mb-1">Contact Name: {lead.client.name}</strong>
                                <p className="text-xs text-slate-500 mb-4">Project Location: {lead.location}</p>
                                <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded border border-slate-100">
                                    Hi there, <br /><br />
                                    I have a piece of land where I would like to build a new home, and I also have another property where I'm planning a full house remodel. I'm interested in scheduling a consultation to discuss both projects.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="bg-white p-4 rounded-md shadow-sm border border-slate-200 flex gap-4 mt-auto">
                        <input type="text" placeholder="Type a message..." className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400" />
                        <button className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium shadow-sm hover:bg-blue-700 transition">Send</button>
                    </div>
                </div>
            </div>

            {/* Lead Secondary Navbar/Details */}
            <div className="w-80 bg-white overflow-y-auto">
                <div className="p-6 border-b border-slate-200">
                    <h3 className="font-semibold text-slate-800 text-sm mb-4 flex justify-between">Client Details <span className="text-blue-600 font-normal cursor-pointer text-xs">Edit</span></h3>
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between"><span className="text-slate-500">Name</span><span className="text-slate-800 font-medium">{lead.client.name}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Email</span><span className="text-slate-800">{lead.client.email || "N/A"}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Phone</span><span className="text-slate-800">N/A</span></div>
                    </div>
                </div>

                <div className="p-6 border-b border-slate-200">
                    <h3 className="font-semibold text-slate-800 text-sm mb-4">Lead Details</h3>
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between"><span className="text-slate-500">Lead Stage</span><span className="font-medium text-slate-800">{lead.stage}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Lead Source</span><span className="text-slate-800">{lead.source}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Expected Start Date</span><span className="text-blue-600 cursor-pointer text-xs">+ Add</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Target Revenue</span><span className="text-blue-600 cursor-pointer text-xs">+ Add</span></div>
                    </div>
                </div>

                {/* Important Workflow connection to Estimates */}
                <div className="p-6">
                    <h3 className="font-semibold text-slate-800 text-sm mb-4">Financials & Planning</h3>
                    <ul className="space-y-2 text-sm">
                        <li><a href="#" className="flex justify-between items-center text-slate-600 hover:text-blue-600 py-1 transition"><span>Estimates</span><span className="bg-slate-100 text-xs px-2 rounded-full border border-slate-200">{lead.estimates.length}</span></a></li>
                        <li><a href="#" className="flex justify-between items-center text-slate-600 hover:text-blue-600 py-1 transition"><span>Takeoffs</span><span className="bg-slate-100 text-xs px-2 rounded-full border border-slate-200">0</span></a></li>
                        <li><a href="#" className="flex justify-between items-center text-slate-600 hover:text-blue-600 py-1 transition"><span>Contracts</span><span className="bg-slate-100 text-xs px-2 rounded-full border border-slate-200">0</span></a></li>
                    </ul>
                </div>

            </div>
        </div>
    );
}
