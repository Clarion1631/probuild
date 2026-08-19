import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

export type CreateDailyLogCoreInput = {
    projectId: string;
    actorUserId: string;
    date: string;
    weather?: string;
    crewOnSite?: string;
    workPerformed: string;
    materialsDelivered?: string;
    issues?: string;
    nextSteps?: string;
    photoUrls?: Array<{ url: string; caption?: string }>;
};

type DailyLogDb = Pick<Prisma.TransactionClient, "dailyLog">;

export async function createDailyLogCore(
    input: CreateDailyLogCoreInput,
    tx: DailyLogDb = prisma,
) {
    const {
        projectId,
        actorUserId,
        date,
        weather,
        crewOnSite,
        workPerformed,
        materialsDelivered,
        issues,
        nextSteps,
        photoUrls,
    } = input;
    return tx.dailyLog.create({
        data: {
            projectId,
            date: new Date(date),
            weather: weather || null,
            crewOnSite: crewOnSite || null,
            workPerformed,
            materialsDelivered: materialsDelivered || null,
            issues: issues || null,
            nextSteps: nextSteps || null,
            createdById: actorUserId,
            photos: photoUrls && photoUrls.length > 0 ? {
                create: photoUrls.map(photo => ({
                    url: photo.url,
                    caption: photo.caption || null,
                })),
            } : undefined,
        },
        include: { photos: true },
    });
}
