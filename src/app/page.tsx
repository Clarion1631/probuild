export const dynamic = "force-dynamic";
import { getProjects } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import DashboardClient from "./DashboardClient";

export default async function Dashboard() {
  const [projects, session] = await Promise.all([
    getProjects(),
    getSessionOrDev(),
  ]);

  const userName = (session?.user as any)?.name ?? null;

  return <DashboardClient projects={projects} userName={userName} />;
}
