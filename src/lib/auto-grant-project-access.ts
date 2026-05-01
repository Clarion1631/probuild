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
    }
}
