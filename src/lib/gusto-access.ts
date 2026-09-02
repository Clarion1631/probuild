// Who may touch the Gusto integration.
//
// P0 (review round 10): /api/gusto/employee-mappings, /api/gusto/auth and
// /api/gusto/callback shipped with NO role check of any kind. The proxy's
// session gate was the only thing in front of them, so ANY signed-in
// account — including FIELD_CREW — could:
//
//   - rewrite employeeMappings, which decides which Gusto employee each
//     ProBuild worker's hours are filed under. The payroll export now consumes
//     that map, so a bad entry pays the wrong person;
//   - start an OAuth flow and complete a callback that writes access tokens
//     into the integration settings.
//
// Same gate as everything else in this phase: ADMIN or the financialReports
// permission. Deliberately the identical expression, so the settings page, the
// mapping write and the export can never disagree about who may act.

import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "./permissions";

export type GustoViewer = { id: string; role: string };

/**
 * Returns the viewer, or a NextResponse to return immediately.
 *
 *   const gate = await requireGustoAccess();
 *   if ("response" in gate) return gate.response;
 */
export async function requireGustoAccess(): Promise<{ viewer: GustoViewer } | { response: NextResponse }> {
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (user.role !== "ADMIN" && !hasPermission(user, "financialReports")) {
        return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { viewer: { id: user.id, role: user.role } };
}

/** True when this viewer may see or change the Gusto integration. For server components. */
export async function canAccessGusto(): Promise<boolean> {
    const user = await getCurrentUserWithPermissions();
    if (!user) return false;
    return user.role === "ADMIN" || hasPermission(user, "financialReports");
}

export type MappingValidation =
    | { ok: true; mappings: Record<string, string> }
    | { ok: false; error: string };

/**
 * Validate an employeeMappings payload.
 *
 * Keys must be REAL user ids. The map is keyed by ProBuild user id and decides
 * whose hours are filed under which Gusto employee, so an unrecognised key is
 * either a typo that silently does nothing or an attempt to plant a mapping for
 * an id that does not exist yet. Values are opaque Gusto ids — bounded, but not
 * something this side can verify.
 */
export async function validateEmployeeMappings(raw: unknown): Promise<MappingValidation> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "employeeMappings must be an object" };
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 500) {
        return { ok: false, error: "Too many mappings." };
    }

    const mappings: Record<string, string> = {};
    for (const [userId, gustoId] of entries) {
        if (typeof gustoId !== "string" || gustoId.length > 64 || !/^[\w-]*$/.test(gustoId)) {
            return { ok: false, error: `"${userId}" has an invalid Gusto employee id.` };
        }
        // An empty value is how the UI clears a mapping.
        mappings[userId] = gustoId;
    }

    const ids = Object.keys(mappings);
    if (ids.length > 0) {
        const { prisma } = await import("./prisma");
        const known = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
        const knownIds = new Set(known.map((row) => row.id));
        const unknown = ids.filter((id) => !knownIds.has(id));
        if (unknown.length > 0) {
            return {
                ok: false,
                error: `These are not team members: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}`,
            };
        }
    }

    return { ok: true, mappings };
}
