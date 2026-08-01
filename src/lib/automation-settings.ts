import { prisma } from "@/lib/prisma";

/**
 * Command Center pause switches.
 *
 * SAFETY INVARIANT — pause-only: the DB toggle can stop a pipeline but can
 * never start one. Effective-enabled is always
 *
 *     (env master switch) AND NOT (paused here)
 *
 * so the UI cannot turn books-writing on; the env vars remain the opt-in
 * masters (QBO_RECEIPT_PUSH_ENABLED === "true" strictly for the push,
 * QBO_EXPENSE_SYNC_CRON_ENABLED !== "false" for the sync).
 *
 * FAIL-CLOSED on read errors: if the settings lookup fails, the pipeline is
 * treated as PAUSED. An operator pauses because something is booking WRONG
 * (bad account mapping, duplicates) — a DB blip is exactly when that
 * instruction must not be ignored. Nothing strands either way: a "paused"
 * push books via the bot's email path (Marge books it by hand), and a
 * skipped cron run retries in 4 hours.
 */

export const PAUSE_KEYS = {
    receiptPush: "receiptPushPaused",
    qboSync: "qboSyncPaused",
} as const;

export type PauseKey = (typeof PAUSE_KEYS)[keyof typeof PAUSE_KEYS];

export async function isPaused(key: PauseKey): Promise<boolean> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key } });
        return row?.value === "true";
    } catch (error) {
        console.error("automation setting read failed (fail-CLOSED: treating as paused)", key, error instanceof Error ? error.name : "UnknownError");
        return true;
    }
}

/** Both switches in one round-trip for the dashboard. */
export async function pauseStates(): Promise<{ receiptPushPaused: boolean; qboSyncPaused: boolean }> {
    try {
        const rows = await prisma.automationSetting.findMany({
            where: { key: { in: [PAUSE_KEYS.receiptPush, PAUSE_KEYS.qboSync] } },
        });
        const map = new Map(rows.map(r => [r.key, r.value]));
        return {
            receiptPushPaused: map.get(PAUSE_KEYS.receiptPush) === "true",
            qboSyncPaused: map.get(PAUSE_KEYS.qboSync) === "true",
        };
    } catch {
        // Dashboard display only — surface the safe assumption, matching isPaused.
        return { receiptPushPaused: true, qboSyncPaused: true };
    }
}

export async function setPaused(key: PauseKey, paused: boolean): Promise<void> {
    await prisma.automationSetting.upsert({
        where: { key },
        update: { value: paused ? "true" : "false" },
        create: { key, value: paused ? "true" : "false" },
    });
}
