import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import FinancialOverviewContent from "./components/financial-overview-content";

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
  });

  if (!project) {
    redirect("/projects");
  }

  // The client component will fetch the actual data via SWR or fetch
  // to support the 'includeUnissued' toggle interactively without full page reloads.

  return (
    <div className="flex-1 w-full flex flex-col h-full bg-[#fcfcfc] overflow-y-auto">
      <FinancialOverviewContent projectId={project.id} projectName={project.name} />
    </div>
  );
}
