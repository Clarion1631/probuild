export const SELECTION_ITEM_NOTE_MAX_LENGTH = 2000 as const;

export function normalizeSelectionItemNote(value: unknown): string | null {
    if (typeof value !== "string") {
        throw new Error("Note must be text.");
    }
    const trimmed = value.trim();
    if (trimmed.length > SELECTION_ITEM_NOTE_MAX_LENGTH) {
        throw new Error("Note must be 2,000 characters or fewer.");
    }
    return trimmed || null;
}
