import { getDailyLogs } from "@/lib/actions";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { notFound } from "next/navigation";
import DailyLogsClient from "./DailyLogsClient";

export default async function DailyLogsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true },
    });

    if (!project) notFound();

    const session = await getServerSession(authOptions);
    const user = session?.user?.email
        ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true, name: true } })
        : null;

    const logs = await getDailyLogs(id);

    return (
        <DailyLogsClient
            projectId={id}
            projectName={project.name}
            logs={JSON.parse(JSON.stringify(logs))}
            currentUserId={user?.id || ""}
            currentUserName={user?.name || "Unknown"}
        />
    );
}
