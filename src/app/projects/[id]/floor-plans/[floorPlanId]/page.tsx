import FloorPlanEditor from "@/components/FloorPlan/FloorPlanEditor";

export default async function FloorPlanPage({ params }: { params: Promise<{ id: string, floorPlanId: string }> }) {
    const resolvedParams = await params;
    return <FloorPlanEditor floorPlanId={resolvedParams.floorPlanId} />;
}
