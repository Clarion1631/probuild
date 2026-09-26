import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The `speedToLeadPaused` kill switch (spec Dispatch "Kill switch"). A
 * separate AutomationSetting key from the existing PAUSE_KEYS in
 * automation-settings.ts — this feature shares no tables, flags or imports
 * with the receipt/QBO pipelines those keys gate (spec "Verified code
 * facts").
 */
const PAUSE_KEY = "speedToLeadPaused";

export async function setSpeedToLeadPaused(paused: boolean, db: PrismaClient = prisma): Promise<void> {
    const value = paused ? "true" : "false";
    await db.automationSetting.upsert({ where: { key: PAUSE_KEY }, create: { key: PAUSE_KEY, value }, update: { value } });
}

export async function isSpeedToLeadPaused(db: PrismaClient = prisma): Promise<boolean> {
    try {
        const row = await db.automationSetting.findUnique({ where: { key: PAUSE_KEY } });
        return row?.value === "true";
    } catch {
        // Fail-closed, same convention as automation-settings.ts's isPaused.
        return true;
    }
}
