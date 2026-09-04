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
import { canAccessIntegrations, requireIntegrationAccess, validateStringMap } from "./integration-access";
import { isPayrollEligibleRole } from "./payroll-config";

export type GustoViewer = { id: string; role: string };

/**
 * Returns the viewer, or a NextResponse to return immediately.
 *
 *   const gate = await requireGustoAccess();
 *   if ("response" in gate) return gate.response;
 */
export async function requireGustoAccess(): Promise<{ viewer: GustoViewer } | { response: NextResponse }> {
    // ONE expression, shared with the QuickBooks half of the integration
    // settings (src/lib/integration-access.ts). It was written here first; the
    // QuickBooks routes had no gate at all, and giving them a second copy of
    // this rule is how the two would come to disagree about who may act.
    return requireIntegrationAccess();
}

/** True when this viewer may see or change the Gusto integration. For server components. */
export async function canAccessGusto(): Promise<boolean> {
    return canAccessIntegrations();
}

/**
 * The Gusto id claimed by more than one member, if any.
 *
 * Two members pointing at the same Gusto employee means one person's hours are
 * filed under another's: the export emits two summary rows for one employee and
 * Gusto keeps the last. Empty values are how the UI CLEARS a mapping, so any
 * number of them is fine.
 *
 * Pure, and checked before the user lookup — a bad map should not cost a
 * database round trip.
 */
export function findDuplicateGustoId(mappings: Record<string, string>): string | null {
    const seen = new Set<string>();
    for (const gustoId of Object.values(mappings)) {
        if (!gustoId) continue;
        if (seen.has(gustoId)) return gustoId;
        seen.add(gustoId);
    }
    return null;
}

export type MappingValidation =
    | { ok: true; mappings: Record<string, string> }
    | { ok: false; error: string };

/** The Gusto id charset: word characters and dashes, or empty to CLEAR a mapping. */
const GUSTO_ID = /^[\w-]*$/;

/** Bounds for the map itself. Values are Gusto ids, which are short. */
const GUSTO_MAPPING_LIMITS = { maxKeys: 500, maxKeyLength: 128, maxValueLength: 64 };

/**
 * Validate an employeeMappings payload.
 *
 * Keys must be REAL user ids. The map is keyed by ProBuild user id and decides
 * whose hours are filed under which Gusto employee, so an unrecognised key is
 * either a typo that silently does nothing or an attempt to plant a mapping for
 * an id that does not exist yet. Values are opaque Gusto ids — bounded, but not
 * something this side can verify.
 *
 * THE PROTOTYPE HOLE (round 13, finding 3). This used to hand-roll its own
 * object check and then copy every key straight into a `{}` literal. A body of
 * `{"__proto__": "..."}` therefore hit the prototype SETTER instead of creating
 * a property: `Object.keys` came back empty, the duplicate scan saw nothing, the
 * "are these real users" lookup was skipped because there were no ids, and the
 * route cheerfully saved `employeeMappings: {}` — WIPING every mapping in the
 * integration record. Nothing errored and the caller got `{ success: true }`.
 *
 * The check is now the same hardened one the QuickBooks GL-mapping route uses
 * (validateStringMap: plain-object prototype, forbidden keys, bounded key and
 * value lengths, result built on a null prototype), with only the Gusto-specific
 * id charset layered on top. One validator, so the two integration surfaces
 * cannot drift apart on what a safe key is.
 */
export async function validateEmployeeMappings(raw: unknown): Promise<MappingValidation> {
    const base = validateStringMap(raw, "employeeMappings", GUSTO_MAPPING_LIMITS);
    if (!base.ok) return { ok: false, error: base.error };

    const mappings: Record<string, string> = Object.create(null);
    for (const [userId, gustoId] of Object.entries(base.map)) {
        if (!GUSTO_ID.test(gustoId)) {
            return { ok: false, error: `"${userId}" has an invalid Gusto employee id.` };
        }
        // An empty value is how the UI clears a mapping.
        mappings[userId] = gustoId;
    }

    const duplicate = findDuplicateGustoId(mappings);
    if (duplicate) {
        return {
            ok: false,
            error: `Two team members are mapped to the same Gusto employee (${duplicate}). One person's hours would be filed under another's.`,
        };
    }

    const ids = Object.keys(mappings);
    if (ids.length > 0) {
        const { prisma } = await import("./prisma");
        // EXISTENCE WAS NOT ENOUGH (round 14, finding 2). A portal CLIENT account
        // is a real row, so a customer id passed this check and was written into
        // the map that decides whose hours are filed under which Gusto employee.
        // The role comes back with the row and is judged by the SAME predicate
        // the export roster, the rates panel, the CSV importer and the rate
        // writer use — a mapping is a payroll fact, so the answer to "may this
        // account appear on payroll" has to be the one answer.
        const known = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true } });
        const byId = new Map(known.map((row) => [row.id, row.role]));
        const unknown = ids.filter((id) => !byId.has(id));
        if (unknown.length > 0) {
            return {
                ok: false,
                error: `These are not team members: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}`,
            };
        }
        // Named separately from "unknown": "that id does not exist" and "that
        // account is a customer" are different problems with different fixes,
        // and telling somebody their customer is a typo helps nobody.
        const nonStaff = ids.filter((id) => !isPayrollEligibleRole(byId.get(id) ?? ""));
        if (nonStaff.length > 0) {
            return {
                ok: false,
                error: `These are not employees, so they cannot be mapped to a Gusto employee: ${nonStaff.slice(0, 5).join(", ")}${nonStaff.length > 5 ? "…" : ""}`,
            };
        }
    }

    return { ok: true, mappings };
}
