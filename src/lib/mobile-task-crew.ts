/**
 * Pure helpers for shaping TaskAssignment rows into the `crew` array shared
 * by GET /api/mobile/schedule/today and GET /api/mobile/tasks/:id.
 */

export type MobileCrewMember = {
    id: string;
    name: string;
    role: "lead" | "assigned";
};

type AssignmentInput = {
    role: string;
    user: { id: string; name: string | null } | null;
};

/**
 * Extracts the first token of a display name for the crew app's compact
 * chip labels. Falls back to "Crew" when there's no usable name.
 */
export function firstName(name: string | null | undefined): string {
    const trimmed = name?.trim();
    if (!trimmed) return "Crew";
    return trimmed.split(/\s+/)[0];
}

/**
 * Shapes raw TaskAssignment rows (with joined user) into the mobile crew
 * list: first-name-only, lead members first, then alphabetical by name.
 */
export function toMobileCrew(assignments: AssignmentInput[]): MobileCrewMember[] {
    return assignments
        .filter(a => a.user)
        .map(a => ({
            id: a.user!.id,
            name: firstName(a.user!.name),
            role: a.role === "lead" ? ("lead" as const) : ("assigned" as const),
        }))
        .sort((a, b) => {
            if (a.role !== b.role) return a.role === "lead" ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
}
