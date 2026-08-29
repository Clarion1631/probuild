import { notFound, redirect } from "next/navigation";
import { ProcurementImportForm } from "@/components/ProcurementImportForm";
import { prisma } from "@/lib/prisma";
import { canAccessProject, currentStaffUserOrNull } from "@/lib/permissions";

export default async function ProcurementImportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentStaffUserOrNull();
  if (!user) redirect("/login");
  if (!["ADMIN", "MANAGER"].includes(user.role)) notFound();

  const { id } = await params;
  if (!canAccessProject(user, id)) notFound();
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!project) notFound();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <nav className="mb-5 text-sm text-stone-600"><a className="underline" href={`/projects/${project.id}`}>← {project.name}</a></nav>
      <ProcurementImportForm projectId={project.id} projectName={project.name} />
      <aside className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">Safety rail</p>
        <p className="mt-1">Blank source jobs and job mismatches stay visible as holds. This staging screen cannot approve, order, receive, or send data to QuickBooks.</p>
      </aside>
    </main>
  );
}
