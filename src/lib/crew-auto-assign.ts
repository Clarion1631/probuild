// Pure rules for "who gets auto-assigned to an In Progress project".
//
// WHY THIS EXISTS: Justin's rule is "all field crew and CJ auto added" to the
// jobs that are actually being worked. Rather than sprinkle that predicate
// across the three project-status write paths and the four user role/status
// write paths, the whole decision lives here as a pure function with no
// Prisma / next-auth / next/headers imports, so it can be unit-tested for
// real (same split as access-rules.ts vs permissions.ts).
//
// The DB side — reading users, connecting them to projects, fail-soft error
// handling — lives in crew-auto-assign-sync.ts. This file never touches IO.
//
// WHICH RELATION: this drives `Project.crew` (Prisma relation
// "CrewAssignments", the User[] <-> Project[] join). That is the relation the
// field-facing surfaces already read as "who is on this job" — mobile auth
// (mobile-auth.ts `crew: { some: { id: user.id } }`), the dispatch board
// (DispatchView/DispatchJobCard filter `project.crew` for ACTIVATED
// FIELD_CREW), client messaging access, and manager job crew. `ProjectAccess`
// is the separate, narrower per-user page-visibility grant maintained by the
// Team Access screen; auto-assigning there would silently rewrite an
// admin-curated ACL. We only widen crew. (Note `accessibleProjectIds` in
// access-rules.ts unions both, so a crew connect already grants read access
// without us touching ProjectAccess.)

import { canonicalProjectStatus } from "./project-status";

/** The one project status that gets automatic crew assignment. */
export const AUTO_ASSIGN_PROJECT_STATUS = "In Progress";

/** The role that is auto-assigned wholesale. */
export const AUTO_ASSIGN_ROLE = "FIELD_CREW";

/** Only ACTIVATED users are ever auto-assigned — never PENDING, never DISABLED. */
export const AUTO_ASSIGN_USER_STATUS = "ACTIVATED";

/**
 * Users named here are auto-assigned regardless of role (still subject to the
 * ACTIVATED requirement). Justin asked for "CJ" by name; CJ is a
 * MANAGER/ADMIN, so the role rule alone would never reach him.
 *
 * ASSUMPTION, documented deliberately: there is no CJ-specific column, flag or
 * id anywhere in the schema — the only durable keys on User are `id`, `email`
 * and `name`. Hardcoding an id would be opaque and would not survive a
 * recreated account, so the default key is the NAME "cj", matched
 * case-insensitively and punctuation-insensitively (see nameMatchesAlwaysKey).
 * Override it without a code change by setting CREW_AUTO_ASSIGN_ALWAYS to a
 * comma-separated list of emails and/or names — an email is the more precise
 * key and is preferred once someone puts CJ's real address there.
 */
export const DEFAULT_ALWAYS_ASSIGN_KEYS = ["CJ"];

export type AutoAssignUser = {
    id: string;
    name?: string | null;
    email?: string | null;
    role?: string | null;
    status?: string | null;
};

export type AutoAssignOptions = {
    /** Emails and/or names always assigned. Defaults to DEFAULT_ALWAYS_ASSIGN_KEYS. */
    alwaysAssignKeys?: string[];
};

/** lowercase + collapse whitespace. */
function normalize(value: unknown): string {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** lowercase + drop everything that is not a letter or digit: "C.J." -> "cj". */
function compact(value: unknown): string {
    return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseAlwaysAssignKeys(raw: string | null | undefined): string[] {
    if (raw == null) return [...DEFAULT_ALWAYS_ASSIGN_KEYS];
    const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
    // An explicitly empty setting means "nobody extra" — that is a legitimate
    // configuration (role rule only), not a reason to fall back to the default.
    return keys;
}

/**
 * Does this user's NAME match an always-assign key?
 * Matches the whole name, or any single token of it, comparing both normalized
 * and punctuation-stripped forms. So key "CJ" matches "CJ", "cj",
 * "C.J. Adkins" and "Cj Adkins", but not "Cjay" or "Marcj".
 */
export function nameMatchesAlwaysKey(name: string | null | undefined, key: string): boolean {
    const n = normalize(name);
    if (!n) return false;
    const k = normalize(key);
    const kc = compact(key);
    if (!k && !kc) return false;
    if (n === k) return true;
    if (kc && compact(name) === kc) return true;
    const tokens = n.split(" ");
    if (k && tokens.includes(k)) return true;
    if (kc && tokens.some((t) => compact(t) === kc)) return true;
    return false;
}

/** Is this user one of the by-name/by-email always-assign people? */
export function isAlwaysAssignUser(user: AutoAssignUser, options: AutoAssignOptions = {}): boolean {
    const keys = options.alwaysAssignKeys ?? DEFAULT_ALWAYS_ASSIGN_KEYS;
    const email = normalize(user.email);
    return keys.some((key) => {
        const k = normalize(key);
        if (!k) return false;
        // A key containing "@" is an email key and must never fall through to a
        // fuzzy name match.
        if (k.includes("@")) return !!email && email === k;
        return nameMatchesAlwaysKey(user.name, key);
    });
}

/** Would this user be auto-assigned to an In Progress project? */
export function shouldAutoAssignUser(user: AutoAssignUser, options: AutoAssignOptions = {}): boolean {
    // Hard gate, applies to EVERYONE including the always-assign names: never
    // auto-assign a DISABLED (or still-PENDING) account.
    if (String(user.status ?? "") !== AUTO_ASSIGN_USER_STATUS) return false;
    if (String(user.role ?? "") === AUTO_ASSIGN_ROLE) return true;
    return isAlwaysAssignUser(user, options);
}

/** Filter a user set down to those who should be auto-assigned. */
export function selectAutoAssignUsers<T extends AutoAssignUser>(
    users: T[],
    options: AutoAssignOptions = {},
): T[] {
    return users.filter((u) => shouldAutoAssignUser(u, options));
}

/**
 * Does this project status get automatic crew assignment? Legacy inbound
 * values ("Open", "Active" — see LEGACY_PROJECT_STATUS_MAP) canonicalize to
 * "In Progress" and count.
 */
export function isAutoAssignProjectStatus(status: string | null | undefined): boolean {
    if (!status) return false;
    return canonicalProjectStatus(String(status)) === AUTO_ASSIGN_PROJECT_STATUS;
}

/**
 * The ids that still need connecting: everyone eligible, minus whoever is
 * already on the crew. Returning [] is the idempotency guarantee — a second
 * run has nothing to write.
 */
export function crewIdsToConnect(
    users: AutoAssignUser[],
    existingCrewIds: Iterable<string>,
    options: AutoAssignOptions = {},
): string[] {
    const existing = new Set(existingCrewIds);
    const ids = selectAutoAssignUsers(users, options)
        .map((u) => u.id)
        .filter((id) => !!id && !existing.has(id));
    return [...new Set(ids)];
}
