export const dynamic = "force-dynamic";
import { getProjects } from "@/lib/actions";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import DashboardClient from "./DashboardClient";

export default async function Dashboard() {
  const [projects, session] = await Promise.all([
    getProjects(),
    getServerSession(authOptions),
  ]);

  const userName = (session?.user as any)?.name ?? null;

  return <DashboardClient projects={projects} userName={userName} />;
}
