import { prisma } from "@/lib/prisma";

export async function autoGrantProjectAccessToEligibleUsers(projectId: string) {
    const eligible = await prisma.userPermission.findMany({
        where: { autoGrantNewProjects: true },
        select: { userId: true },
    });
    if (eligible.length > 0) {
        await prisma.projectAccess.createMany({
            data: eligible.map((u) => ({ userId: u.userId, projectId })),
            skipDuplicates: true,
        });
        // Also add to crew assignments so Time Clock sees the project
        await prisma.project.update({
            where: { id: projectId },
            data: {
                crew: {
                    connect: eligible.map((u) => ({ id: u.userId })),
                },
            },
        });
    }
}
