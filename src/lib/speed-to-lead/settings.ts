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
    // Ensure-then-lock the SAME row dispatch.ts's lockAutomationSettings takes
    // FOR UPDATE (its own ensure-insert makes this idempotent either way) — a
    // bare upsert() against a not-yet-existing key does not serialize against
    // a concurrent dispatch that is discovering the row absent at the same
    // instant (the first-ever pause race dispatch.ts's comment describes).
    await db.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO "AutomationSetting" (key, value) VALUES (${PAUSE_KEY}, ${value}) ON CONFLICT (key) DO NOTHING`;
        await tx.$executeRaw`SELECT key FROM "AutomationSetting" WHERE key = ${PAUSE_KEY} FOR UPDATE`;
        await tx.automationSetting.update({ where: { key: PAUSE_KEY }, data: { value } });
    });
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
