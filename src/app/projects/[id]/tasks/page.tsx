export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getScheduleTasks, getTeamMembers } from "@/lib/actions";
import TasksClient from "./TasksClient";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function ProjectTasksPage({ params }: Props) {
    const { id } = await params;
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const [tasks, teamMembers] = await Promise.all([
        getScheduleTasks(id),
        getTeamMembers(),
    ]);

    // Task total is a Prisma Decimal — serialize before crossing the server->client boundary.
    return <TasksClient projectId={id} initialTasks={JSON.parse(JSON.stringify(tasks))} teamMembers={teamMembers} />;
}
