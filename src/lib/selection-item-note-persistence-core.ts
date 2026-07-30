import { normalizeSelectionItemNote } from "./selection-item-notes";

type SelectionItemNote = {
    id: string;
    projectId: string;
    deletedAt: Date | null;
};

type PersistSelectionItemNoteDependencies = {
    findItem: (itemId: string) => Promise<SelectionItemNote | null>;
    assertAccess: (projectId: string) => Promise<unknown>;
    updateNote: (itemId: string, normalizedNote: string | null) => Promise<void>;
    revalidate: (projectId: string) => void;
};

export async function persistSelectionItemNote(
    itemId: string,
    note: unknown,
    dependencies: PersistSelectionItemNoteDependencies,
): Promise<{ success: true; note: string | null }> {
    const normalizedNote = normalizeSelectionItemNote(note);
    const item = await dependencies.findItem(itemId);
    if (!item || item.deletedAt) {
        throw new Error("Item not found");
    }

    await dependencies.assertAccess(item.projectId);
    await dependencies.updateNote(item.id, normalizedNote);
    dependencies.revalidate(item.projectId);

    return { success: true, note: normalizedNote };
}
