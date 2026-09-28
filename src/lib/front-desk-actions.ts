"use server";

import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertActiveStaff } from "@/lib/permissions";
import { encryptObject } from "@/lib/crypto";
import { logLeadEvent } from "@/lib/speed-to-lead/audit";
import { getUsersMe, getOrganization, getEventTypes } from "@/lib/front-desk/calendly";

/**
 * Front Desk v1 §2.4 — every action here requires `assertActiveStaff()` AND
 * `role === "ADMIN"` (Justin and Richard; §7-J7 flags Richard's role as
 * unverified). A dedicated file per project convention (matching
 * speed-to-lead-actions.ts), so src/lib/actions.ts needs no changes.
 */
async function assertFrontDeskAdmin(): Promise<{ email: string }> {
    const user = await assertActiveStaff();
    if (user?.role !== "ADMIN") throw new Error("Unauthorized");
    const session = await getServerSession(authOptions);
    const email = session?.user?.email ?? user?.email ?? "unknown";
    return { email };
}

const TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,4096}$/;

export interface SaveCalendlyTokenResult {
    ok: boolean;
    error?: string;
}

/**
 * §2.4 "Paste and save": three read-only checks BEFORE anything is stored —
 * `/users/me` (→ `frontDeskCalendlyUserUri`), the organization (→ `plan`),
 * and `/event_types` (must succeed, so the pickers have something to show).
 * Only on all three passing does the ciphertext get written. The token
 * itself is never returned to the client and never logged — only the
 * category-free `front-desk-calendly-token-set` audit event.
 */
export async function saveCalendlyTokenAction(token: string): Promise<SaveCalendlyTokenResult> {
    const { email } = await assertFrontDeskAdmin();
    const trimmed = token.trim();
    if (!TOKEN_PATTERN.test(trimmed)) return { ok: false, error: "That doesn't look like a Calendly personal access token." };

    const me = await getUsersMe(trimmed);
    if (me.kind !== "ok") return { ok: false, error: "Calendly rejected the token (checked /users/me)." };
    const userUri = me.data.resource.uri;

    const org = await getOrganization(trimmed, me.data.resource.current_organization);
    const plan = org.kind === "ok" ? (org.data.resource.plan ?? null) : null;

    const eventTypes = await getEventTypes(trimmed, userUri);
    if (eventTypes.kind !== "ok") return { ok: false, error: "Calendly rejected the token (checked /event_types)." };

    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: {
            frontDeskCalendlyTokenEnc: encryptObject({ token: trimmed }),
            frontDeskCalendlyTokenSetBy: email,
            frontDeskCalendlyTokenSetAt: new Date(),
            frontDeskCalendlyUserUri: userUri,
            frontDeskCalendlyPlan: plan,
            frontDeskCalendlyAuthFailedAt: null,
        },
    });
    await logLeadEvent(prisma, { kind: "front-desk-calendly-token-set", actor: email });
    revalidatePath("/settings/front-desk");
    return { ok: true };
}

/** §2.4 "Clear token": the instant booking off-switch, no redeploy. */
export async function clearCalendlyTokenAction(): Promise<void> {
    const { email } = await assertFrontDeskAdmin();
    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: {
            frontDeskCalendlyTokenEnc: null,
            frontDeskCalendlyTokenSetBy: null,
            frontDeskCalendlyTokenSetAt: null,
            frontDeskCalendlyUserUri: null,
            frontDeskCalendlyPlan: null,
            frontDeskCalendlyAuthFailedAt: null,
        },
    });
    await logLeadEvent(prisma, { kind: "front-desk-calendly-token-cleared", actor: email });
    revalidatePath("/settings/front-desk");
}

/** §2.4 "Pickers": the live event and the secret test event. */
export async function setFrontDeskEventTypesAction(liveEventTypeUri: string, testEventTypeUri: string): Promise<void> {
    const { email } = await assertFrontDeskAdmin();
    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: {
            frontDeskCalendlyEventTypeUri: liveEventTypeUri.trim() || null,
            frontDeskCalendlyTestEventTypeUri: testEventTypeUri.trim() || null,
        },
    });
    await logLeadEvent(prisma, { kind: "front-desk-event-types-set", actor: email });
    revalidatePath("/settings/front-desk");
}

/** §4 "Richard taking transfers" — the no-redeploy transfer off switch and his holiday control. */
export async function setFrontDeskTakingTransfersAction(taking: boolean): Promise<void> {
    const { email } = await assertFrontDeskAdmin();
    await prisma.companySettings.update({
        where: { id: "singleton" },
        data: { frontDeskTakingTransfers: taking, frontDeskTakingTransfersBy: email, frontDeskTakingTransfersAt: new Date() },
    });
    await logLeadEvent(prisma, { kind: "front-desk-taking-transfers-set", actor: email, detail: { taking } });
    revalidatePath("/settings/front-desk");
}
