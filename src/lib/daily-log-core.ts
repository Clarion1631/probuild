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
    chatMessageName?: string;
};

export function normalizeDailyLogChatMessage(value?: string): string | null {
    if (value === undefined) return null;
    const name = value.trim();
    if (!/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/.test(name) || name.length > 500) {
        throw new Error("Chat message must be a spaces/{space}/messages/{message} resource name");
    }
    return name;
}

export function assertDailyLogChatProject(messageName: string | null, spaceId: string | null) {
    if (!messageName) return;
    const spaceName = spaceId?.startsWith("spaces/") ? spaceId : spaceId ? `spaces/${spaceId}` : null;
    if (!spaceName || !messageName.startsWith(`${spaceName}/messages/`)) {
        throw new Error("Chat message must belong to this project's linked Google Chat space");
    }
}

type DailyLogDb = Pick<Prisma.TransactionClient, "dailyLog">;

export async function createDailyLogCore(
    input: CreateDailyLogCoreInput,
    tx: DailyLogDb = prisma,
) {
    const chatMessageName = normalizeDailyLogChatMessage(input.chatMessageName);
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
            source: chatMessageName ? "google_chat" : "manual",
            chatMessageName,
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
