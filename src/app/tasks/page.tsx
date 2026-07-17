import { getSessionOrDev } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getOfficeTasksBoard } from "@/lib/actions";
import TasksBoardClient from "./TasksBoardClient";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
    const session = await getSessionOrDev();
    if (!session?.user?.email) redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user && process.env.NODE_ENV !== "development") redirect("/login");
    const effectiveUser = user ?? { role: "ADMIN" };

    if (effectiveUser.role !== "ADMIN" && effectiveUser.role !== "MANAGER") {
        redirect("/projects");
    }

    const { columns, tasks, archived, users } = await getOfficeTasksBoard();

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <TasksBoardClient initialColumns={columns} initialTasks={tasks} initialArchived={archived} users={users} />
        </div>
    );
}
