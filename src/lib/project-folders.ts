import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

export const STANDARD_PROJECT_FOLDERS = [
    "01 Plans & Specs",
    "02 Permits & Inspections",
    "03 Contracts & Estimates",
    "04 RFIs & RFQs",
    "05 Daily Logs & Field Notes",
    "06 Photos",
    "07 Meeting Notes",
    "08 Closeout",
] as const;

type FolderDb = Pick<Prisma.TransactionClient, "fileFolder">;

function folderKey(name: string): string {
    return name.trim().toLocaleLowerCase();
}

export async function ensureStandardFolders(
    projectId: string,
    tx: FolderDb = prisma,
): Promise<{ created: string[]; existing: string[] }> {
    const current = await tx.fileFolder.findMany({
        where: { projectId, parentId: null },
        select: { name: true },
    });
    const existingKeys = new Set(current.map(folder => folderKey(folder.name)));
    const missing = STANDARD_PROJECT_FOLDERS.filter(name => !existingKeys.has(folderKey(name)));

    const created: string[] = [];
    for (const name of missing) {
        await tx.fileFolder.create({
            data: {
                projectId,
                parentId: null,
                name,
                visibility: "team",
            },
            select: { id: true },
        });
        created.push(name);
        existingKeys.add(folderKey(name));
    }

    return {
        created,
        existing: current.map(folder => folder.name),
    };
}
