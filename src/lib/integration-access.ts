// Who may touch an INTEGRATION: its OAuth connection, its tokens, and the
// mappings that decide where money and hours are filed.
//
// P0 (review round 10): /api/quickbooks/gl-mappings had no role check of any
// kind. The proxy proves a signed-in staff session and nothing more, so ANY
// active account - FIELD_CREW included - could POST a whole new GL map and
// silently re-file every synced invoice line into an account of their
// choosing. /api/quickbooks/auth, /callback and /sync were open the same way:
// start an OAuth flow, complete a callback that writes access tokens, or push
// documents into the company books.
//
// This is the SAME gate src/lib/gusto-access.ts already applied to the Gusto
// half of the integration settings - ADMIN or the financialReports permission -
// and requireGustoAccess now delegates here so the two can never drift into
// different answers about who may act.

import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "./permissions";

export type IntegrationViewer = { id: string; role: string };

/**
 * Returns the viewer, or a NextResponse to return immediately.
 *
 *   const gate = await requireIntegrationAccess();
 *   if ("response" in gate) return gate.response;
 */
export async function requireIntegrationAccess(): Promise<
    { viewer: IntegrationViewer } | { response: NextResponse }
> {
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (user.role !== "ADMIN" && !hasPermission(user, "financialReports")) {
        return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { viewer: { id: user.id, role: user.role } };
}

/** True when this viewer may see or change an integration. For server components. */
export async function canAccessIntegrations(): Promise<boolean> {
    const user = await getCurrentUserWithPermissions();
    if (!user) return false;
    return user.role === "ADMIN" || hasPermission(user, "financialReports");
}

/**
 * A caller-supplied map of string keys to string values, validated hard enough
 * to be written into the integration blob.
 *
 * `typeof x === "object"` was the whole check on the GL mappings endpoint, and
 * it is true of `null`, of every array, and of an object whose prototype the
 * caller chose. So `null` reached saveQBSettings and wiped the map, an array
 * was stored as an array, and a body carrying __proto__ was merged into the
 * settings document.
 *
 * The rules, each closing one of those:
 *   - a PLAIN object, by prototype identity. Rejects null, arrays, class
 *     instances, and Object.create(null) alike - the last is not an attack but
 *     is also not a shape this document should carry;
 *   - no inherited-name keys (__proto__, constructor, prototype), which JSON
 *     can carry as ordinary own properties;
 *   - a bounded number of keys, and bounded key and value lengths, so one
 *     request cannot make the encrypted settings row unbounded.
 */
export type StringMapLimits = { maxKeys: number; maxKeyLength: number; maxValueLength: number };

export const DEFAULT_STRING_MAP_LIMITS: StringMapLimits = {
    maxKeys: 500,
    maxKeyLength: 128,
    maxValueLength: 512,
};

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function validateStringMap(
    value: unknown,
    label: string,
    limits: StringMapLimits = DEFAULT_STRING_MAP_LIMITS
): { ok: true; map: Record<string, string> } | { ok: false; error: string } {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: `${label} must be an object.` };
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
        return { ok: false, error: `${label} must be a plain object.` };
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxKeys) {
        return { ok: false, error: `${label} has too many entries (max ${limits.maxKeys}).` };
    }
    // NULL-PROTOTYPE. The forbidden-key check below is the actual guarantee;
    // this is the belt to its braces, so a key nobody thought of cannot reach a
    // setter that a `{}` literal inherits.
    const map: Record<string, string> = Object.create(null);
    for (const [key, entry] of entries) {
        if (FORBIDDEN_KEYS.has(key)) {
            return { ok: false, error: `${label} may not contain the key ${key}.` };
        }
        if (!key || key.length > limits.maxKeyLength) {
            return { ok: false, error: `${label} has a key that is empty or too long.` };
        }
        if (typeof entry !== "string" || entry.length > limits.maxValueLength) {
            return { ok: false, error: `${label} values must be strings of at most ${limits.maxValueLength} characters.` };
        }
        map[key] = entry;
    }
    return { ok: true, map };
}
