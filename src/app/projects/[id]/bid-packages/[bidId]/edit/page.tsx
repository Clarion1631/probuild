export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getBidPackage } from "@/lib/actions";
import { getProjectSubcontractors } from "@/lib/subcontractor-actions";
import BidPackageEditor from "./BidPackageEditor";

interface Props {
    params: Promise<{ id: string; bidId: string }>;
}

export default async function BidPackageEditPage({ params }: Props) {
    const { id, bidId } = await params;

    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const [pkg, subs] = await Promise.all([
        getBidPackage(bidId),
        getProjectSubcontractors(id),
    ]);

    if (!pkg) return redirect(`/projects/${id}/bid-packages`);

    return <BidPackageEditor pkg={pkg} projectId={id} subcontractors={subs} />;
}
