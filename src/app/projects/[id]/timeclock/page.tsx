import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import TimeClockClient from "./TimeClockClient";

export default async function TimeClockPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id: projectId } = await params;
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        redirect("/login");
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
    });

    if (!user) redirect("/login");

    // Check project access and permission
    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
        const permission = await prisma.userPermission.findUnique({
            where: { userId: user.id }
        });
        if (!permission?.timeClock) {
            redirect(`/projects/${projectId}`);
        }
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true }
    });

    if (!project) redirect("/projects");

    // Fetch required data for client
    const timeEntries = await prisma.timeEntry.findMany({
        where: { projectId },
        include: {
            user: { select: { id: true, name: true, email: true } },
            costCode: { select: { id: true, name: true, code: true } }
        },
        orderBy: { startTime: 'desc' }
    });

    const costCodes = await prisma.costCode.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' }
    });
    
    const teamMembersRaw = await prisma.user.findMany({
        where: { status: { not: "DISABLED" } },
        select: { id: true, name: true, email: true, hourlyRate: true },
        orderBy: { name: 'asc' }
    });
    const teamMembers = teamMembersRaw.map(u => ({
        ...u,
        hourlyRate: Number(u.hourlyRate),
    }));

    return (
        <TimeClockClient
            project={project}
            initialEntries={JSON.parse(JSON.stringify(timeEntries))}
            costCodes={JSON.parse(JSON.stringify(costCodes))}
            teamMembers={JSON.parse(JSON.stringify(teamMembers))}
            currentUser={{id: user.id, role: user.role, name: user.name || user.email}}
        />
    );
}
