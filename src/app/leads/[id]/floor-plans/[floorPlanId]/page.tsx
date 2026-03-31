import { getLead, getFloorPlan, saveFloorPlanData } from "@/lib/actions";
import { redirect } from "next/navigation";
import FloorPlanEditor from "@/components/FloorPlan/FloorPlanEditor";

export default async function LeadFloorPlanEditorPage({ params }: { params: Promise<{ id: string, floorPlanId: string }> }) {
    const resolvedParams = await params;
    
    // Auth Check
    const lead = await getLead(resolvedParams.id);
    if (!lead) return redirect("/leads");
    
    // File Check
    const floorPlan = await getFloorPlan(resolvedParams.floorPlanId);
    if (!floorPlan) return redirect(`/leads/${resolvedParams.id}/floor-plans`);

    // Override the generic FloorPlanEditor to use Lead routing
    return (
        <div className="absolute inset-0 bg-white z-[100]">
            <FloorPlanEditor 
                floorPlanId={resolvedParams.floorPlanId} 
                projectId={resolvedParams.id} 
                isLead={true}
            />
        </div>
    );
}
