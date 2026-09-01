import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { currentStaffUserOrNull, isAdminOrManager } from "@/lib/permissions";
import { percentCompleteNeedsReview } from "@/lib/percent-complete";
import FinancialOverviewContent from "./components/financial-overview-content";
import PercentCompleteCard from "./components/PercentCompleteCard";

export const metadata = {
  title: "Financial Overview | ProBuild",
};

export default async function FinancialOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin");
  }

  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: { percentCompleteUpdatedBy: { select: { name: true, email: true } } },
  });

  if (!project) {
    redirect("/projects");
  }

  // Editing percent complete is ADMIN/MANAGER. Everyone else who can reach this
  // page still SEES the card — read-only — because the number explains the
  // earned-margin figures below it.
  const viewer = await currentStaffUserOrNull();
  const canEdit = !!viewer && isAdminOrManager(viewer);

  // Decimal columns must not cross to the client component as Prisma Decimals.
  const percentComplete = project.percentComplete === null ? null : Number(project.percentComplete);
  const percentCompleteAuto = project.percentCompleteAuto === null ? null : Number(project.percentCompleteAuto);
  const percentCompleteAutoAtOverride =
    project.percentCompleteAutoAtOverride === null ? null : Number(project.percentCompleteAutoAtOverride);
  const source = (project.percentCompleteSource ?? null) as "AUTO" | "MANUAL" | null;

  // The client component will fetch the actual data via SWR or fetch
  // to support the 'includeUnissued' toggle interactively without full page reloads.

  return (
    <div className="flex-1 w-full flex flex-col h-full bg-[#fcfcfc] overflow-y-auto">
      <div className="px-6 pt-6">
        <PercentCompleteCard
          projectId={project.id}
          percentComplete={percentComplete}
          source={source}
          asOf={project.percentCompleteAsOf ? project.percentCompleteAsOf.toISOString() : null}
          auto={percentCompleteAuto}
          needsReview={percentCompleteNeedsReview({
            source,
            auto: percentCompleteAuto,
            autoAtOverride: percentCompleteAutoAtOverride,
          })}
          editorName={project.percentCompleteUpdatedBy?.name ?? project.percentCompleteUpdatedBy?.email ?? null}
          canEdit={canEdit}
        />
      </div>
      <FinancialOverviewContent projectId={project.id} projectName={project.name} />
    </div>
  );
}
