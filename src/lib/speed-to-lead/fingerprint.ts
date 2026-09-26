import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Spec "Release — Fingerprint / Activation": a prebuild step
 * (scripts/speed-to-lead-fingerprint.mjs) writes SPEED_TO_LEAD_FINGERPRINT —
 * the sha256 of the code this feature's LIVE behavior depends on. Read here
 * at runtime; the sha256 itself is computed at build time so it reflects the
 * exact deployed bundle, not whatever happens to be on disk when a server
 * process starts.
 */
export function currentFingerprint(env: NodeJS.ProcessEnv = process.env): string | null {
    const value = env.SPEED_TO_LEAD_FINGERPRINT;
    return value && value.trim() ? value.trim() : null;
}

export interface LiveActivation {
    fingerprint: string;
    deploySha: string | null;
    activatedAt: string;
    activatedBy: string;
}

const LIVE_ACTIVATION_KEY = "liveActivation";

function parseActivation(value: string | null | undefined): LiveActivation | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<LiveActivation>;
        if (typeof parsed.fingerprint !== "string" || typeof parsed.activatedAt !== "string") return null;
        return {
            fingerprint: parsed.fingerprint,
            deploySha: typeof parsed.deploySha === "string" ? parsed.deploySha : null,
            activatedAt: parsed.activatedAt,
            activatedBy: typeof parsed.activatedBy === "string" ? parsed.activatedBy : "",
        };
    } catch {
        return null;
    }
}

export async function readLiveActivation(db: Db = prisma): Promise<LiveActivation | null> {
    const row = await db.automationSetting.findUnique({ where: { key: LIVE_ACTIVATION_KEY } });
    return parseActivation(row?.value ?? null);
}

/**
 * "LIVE only has effect ... after Justin activates it for the current code
 * fingerprint" and "A changed fingerprint lapses LIVE back to TEST behavior
 * until readiness passes again."
 */
export async function isLiveActivatedForCurrentFingerprint(env: NodeJS.ProcessEnv = process.env, db: Db = prisma): Promise<boolean> {
    const fp = currentFingerprint(env);
    if (!fp) return false;
    const activation = await readLiveActivation(db);
    return !!activation && activation.fingerprint === fp;
}

/**
 * Justin-only activation (spec Release "Activation"): "succeeds only with a
 * PASSED record for the current fingerprint."
 */
export async function activateLive(
    params: { activatedBy: string; env?: NodeJS.ProcessEnv },
    db: PrismaClient = prisma,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const fp = currentFingerprint(params.env);
    if (!fp) return { ok: false, reason: "no fingerprint available for this deploy" };
    const passed = await db.readinessRecord.findFirst({
        where: { fingerprint: fp, passed: true },
        orderBy: { createdAt: "desc" },
    });
    if (!passed) return { ok: false, reason: "no PASSED readiness record for the current fingerprint" };
    await db.automationSetting.upsert({
        where: { key: LIVE_ACTIVATION_KEY },
        create: { key: LIVE_ACTIVATION_KEY, value: JSON.stringify({ fingerprint: fp, deploySha: passed.deploySha, activatedAt: new Date().toISOString(), activatedBy: params.activatedBy }) },
        update: { value: JSON.stringify({ fingerprint: fp, deploySha: passed.deploySha, activatedAt: new Date().toISOString(), activatedBy: params.activatedBy }) },
    });
    return { ok: true };
}
