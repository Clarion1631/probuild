import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, isAdminOrManager } from "@/lib/permissions";
import { PAUSE_KEYS, type PauseKey } from "@/lib/automation-settings";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const VALID_KEYS = new Set<string>(Object.values(PAUSE_KEYS));

/**
 * Command Center pause toggles. Gated by isAdminOrManager — DELIBERATELY
 * including MANAGER: ADMIN_ROLES = [ADMIN, MANAGER] is this app's one
 * privileged cohort everywhere (a 4-person company; the managers ARE the
 * owners). Pause-only by design —
 * see src/lib/automation-settings.ts for the safety invariant. Every flip is
 * itself an audit event so the activity history shows who paused what, when.
 */
export async function POST(request: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    if (!isAdminOrManager(user)) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    let parsed: unknown;
    try {
        parsed = await request.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (typeof parsed !== "object" || parsed === null) {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    const body = parsed as { key?: unknown; paused?: unknown };
    if (typeof body.key !== "string" || !VALID_KEYS.has(body.key) || typeof body.paused !== "boolean") {
        return NextResponse.json({ ok: false, reason: "invalid-fields" }, { status: 400 });
    }
    const key = body.key as PauseKey;
    const paused = body.paused;
    const value = paused ? "true" : "false";

    try {
        const changed = await prisma.$transaction(async tx => {
            const current = await tx.automationSetting.findUnique({ where: { key } });
            // Reposting the same value is a no-op — never record a
            // fictitious paused/resumed transition.
            if ((current?.value === "true") === paused) return false;
            await tx.automationSetting.upsert({
                where: { key },
                update: { value },
                create: { key, value },
            });
            // Audit IN the same transaction: a control flip either commits
            // with its audit row or not at all. (Ordinary pipeline logging
            // stays fire-and-forget; control changes are the exception.)
            await tx.automationEvent.create({
                data: {
                    kind: "setting",
                    status: paused ? "paused" : "resumed",
                    source: `manual:${user.id}`,
                    reason: `${key}=${paused ? "paused" : "resumed"}`,
                    detail: JSON.stringify({ setting: key, paused, by: user.name || user.email || undefined }),
                },
            });
            return true;
        });
        return NextResponse.json({ ok: true, key, paused, changed });
    } catch (error) {
        console.error("automation setting write failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "write-failed" }, { status: 500 });
    }
}
