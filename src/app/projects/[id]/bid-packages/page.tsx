export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getProjectBidPackages } from "@/lib/actions";
import { prisma } from "@/lib/prisma";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import BidPackagesClient from "./BidPackagesClient";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function BidPackagesPage({ params }: Props) {
    const { id } = await params;

    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");
    const user = await getCurrentUserWithPermissions();
    const devAllowed = await canUseDevAuthFallback();
    if ((!user || !hasPermission(user, "financialReports")) && !devAllowed) {
        return redirect(`/projects/${id}`);
    }

    const [packages, project] = await Promise.all([
        getProjectBidPackages(id),
        prisma.project.findUnique({ where: { id }, select: { name: true } }),
    ]);

    if (!project) return redirect("/projects");

    return <BidPackagesClient projectId={id} projectName={project.name} initialPackages={JSON.parse(JSON.stringify(packages))} />;
}
