import { getSessionOrDev } from "@/lib/auth";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { prisma } from "@/lib/prisma";

export type PortalVisibilityKey = "showSchedule" | "showDailyLogs";

export type PortalProjectAccessInput = {
    projectId: string;
    isStaff: boolean;
    clientId: string | null;
    visibility: PortalVisibilityKey;
};

type PortalVisibilityAccess = {
    isPortalEnabled: boolean;
    showSchedule: boolean;
    showDailyLogs: boolean;
};

export function portalVisibilityAllows(
    visibility: PortalVisibilityAccess | null,
    visibilityKey: PortalVisibilityKey,
): boolean {
    if (!visibility) return visibilityKey === "showSchedule";
    return visibility.isPortalEnabled && visibility[visibilityKey];
}

/**
 * Session-free portal ownership/visibility assertion.
 *
 * Verification scripts call this core with explicit identities; runtime
 * surfaces must call assertPortalProjectAccess, which derives identity from
 * the authenticated session or client magic-link cookie.
 */
export async function assertPortalProjectAccessCore({
    projectId,
    isStaff,
    clientId,
    visibility: visibilityKey,
}: PortalProjectAccessInput): Promise<void> {
    // Staff preview is intentionally allowed even while a client-facing
    // section is disabled, matching the established schedule behavior.
    if (isStaff) return;
    if (!clientId) throw new Error("Unauthorized");

    const project = await prisma.project.findFirst({
        where: { id: projectId, clientId },
        select: { id: true },
    });
    if (!project) throw new Error("Unauthorized");

    const visibility = await prisma.portalVisibility.findUnique({
        where: { projectId },
        select: {
            isPortalEnabled: true,
            showSchedule: true,
            showDailyLogs: true,
        },
    });

    // Keep the established defaults: schedule is on when no row exists, while
    // daily logs require an explicit opt-in.
    if (!portalVisibilityAllows(visibility, visibilityKey)) {
        throw new Error("Unauthorized");
    }
}

export async function assertPortalProjectAccess(
    projectId: string,
    visibility: PortalVisibilityKey,
): Promise<void> {
    const session = await getSessionOrDev();
    const role = ((session?.user as { role?: string } | undefined)?.role ?? null);
    const isStaff = role === "ADMIN" || role === "MANAGER";
    const clientId = isStaff ? null : await resolveSessionClientId();

    await assertPortalProjectAccessCore({
        projectId,
        isStaff,
        clientId,
        visibility,
    });
}
