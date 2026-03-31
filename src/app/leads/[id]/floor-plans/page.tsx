import { getLead, createDraftFloorPlan } from "@/lib/actions";
import { redirect } from "next/navigation";
import { BoxSelect } from "lucide-react";
import LeadSidebar from "../LeadSidebar";
import LeadDetailsSidebar from "../LeadDetailsSidebar";
import { prisma } from "@/lib/prisma";

export default async function LeadFloorPlansPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);

    if (!lead) return <div className="p-6">Lead not found</div>;

    const floorPlans = lead.floorPlans || [];

    const leadFull = await prisma.lead.findUnique({
        where: { id: lead.id },
        select: { message: true },
    });

    async function handleNewFloorPlan() {
        "use server";
        const result = await createDraftFloorPlan(resolvedParams.id);
        redirect(`/leads/${resolvedParams.id}/floor-plans/${result.id}`);
    }

    async function handleConvert() {
        "use server";
        const { convertLeadToProject } = await import("@/lib/actions");
        await convertLeadToProject(lead!.id);
        redirect(`/`);
    }

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            {/* Left Sidebar - Navigation */}
            <LeadSidebar
                leadId={lead.id}
                leadName={lead.name}
                clientName={lead.client.name}
                onConvert={handleConvert}
            />

            {/* Center - Floor Plans Board */}
            <div className="flex-1 overflow-auto bg-slate-50 relative p-6">
                <div className="max-w-4xl mx-auto w-full">
                    <div className="flex items-center justify-between mb-8">
                        <div>
                            <h1 className="text-2xl font-bold text-slate-800">3D Floor Plans</h1>
                            <p className="text-sm text-slate-500 mt-1">Design layouts for this lead before converting to a project.</p>
                        </div>
                        <form action={handleNewFloorPlan}>
                            <button type="submit" className="bg-slate-800 text-white px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm hover:bg-slate-900 transition flex items-center gap-2">
                                <BoxSelect className="w-4 h-4" />
                                Create Floor Plan
                            </button>
                        </form>
                    </div>

                    {floorPlans.length === 0 ? (
                        <div className="bg-white border text-center border-slate-200 rounded-xl p-16 shadow-sm flex flex-col items-center mt-12">
                            <div className="bg-slate-50 text-slate-400 p-6 rounded-full mb-6 border border-slate-100">
                                <BoxSelect className="w-12 h-12" />
                            </div>
                            <h3 className="font-bold text-slate-800 text-xl mb-3">No Floor Plans yet</h3>
                            <p className="text-sm text-slate-500 max-w-md mx-auto mb-8 leading-relaxed">
                                Get ahead of the design! You can start drafting 2D/3D floor plans now. Once the client signs, these will automatically transfer to their active Project space.
                            </p>
                            <form action={handleNewFloorPlan}>
                                <button type="submit" className="bg-slate-800 text-white px-8 py-3 rounded-lg text-sm font-bold shadow hover:bg-slate-900 transition flex items-center gap-2">
                                    <BoxSelect className="w-4 h-4" />
                                    Start Designing
                                </button>
                            </form>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {floorPlans.map((fp: any) => (
                                <a key={fp.id} href={`/leads/${lead.id}/floor-plans/${fp.id}`} className="group relative bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden block">
                                    <div className="bg-slate-50 aspect-video flex items-center justify-center border-b group-hover:bg-slate-100 transition">
                                        <BoxSelect className="w-12 h-12 text-slate-300 group-hover:text-slate-500 transition-colors" />
                                    </div>
                                    <div className="p-5">
                                        <h3 className="font-bold text-slate-800 mb-1.5">{fp.name}</h3>
                                        <p className="text-xs text-slate-500 font-medium">
                                            Last modified: {new Date(fp.updatedAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                </a>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Right Sidebar - Details */}
            <LeadDetailsSidebar
                leadId={lead.id}
                leadName={lead.name}
                leadSource={lead.source}
                leadStage={lead.stage}
                expectedStartDate={lead.expectedStartDate?.toISOString().split("T")[0] || null}
                targetRevenue={lead.targetRevenue}
                location={lead.location}
                projectType={lead.projectType}
                clientId={lead.client.id}
                clientName={lead.client.name}
                clientEmail={lead.client.email}
                clientPhone={(lead.client as any).primaryPhone || null}
                clientAddress={(lead.client as any).addressLine1 || null}
                clientCity={(lead.client as any).city || null}
                clientState={(lead.client as any).state || null}
                clientZip={(lead.client as any).zipCode || null}
                initialMessage={leadFull?.message || null}
            />
        </div>
    );
}
