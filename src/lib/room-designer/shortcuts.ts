// Centralized shortcut registry. The `?` modal renders from this list, and the
// individual key handlers live in useAssetSelection / useUndoRedo — the entries
// here are the "spec" that keeps the docs and the handlers aligned.
//
// Keep this ordered by grouping (navigation → editing → tools → help) rather
// than alphabetically; the modal renders rows in order.

export interface Shortcut {
    key: string;
    desc: string;
    /** Optional grouping label — rendered as a small header row in the modal. */
    group?: string;
}

export const SHORTCUTS: Shortcut[] = [
    // View
    { group: "View", key: "V", desc: "Toggle 2D / 3D view" },
    { key: "M", desc: "Toggle measurements overlay" },
    { key: "L", desc: "Toggle layers panel" },
    { key: "B", desc: "Before / After preview" },

    // Editing
    { group: "Editing", key: "Ctrl+Z", desc: "Undo" },
    { key: "Ctrl+Y", desc: "Redo" },
    { key: "Ctrl+S", desc: "Force save" },
    { key: "Ctrl+D", desc: "Duplicate selected" },
    { key: "R", desc: "Rotate 90° (Shift+R = 45°)" },
    { key: "Delete", desc: "Remove selected" },
    { key: "Arrows", desc: "Nudge (Shift = large step)" },

    // Tool mode
    { group: "Tools", key: "1", desc: "Translate mode" },
    { key: "2", desc: "Rotate mode" },
    { key: "3", desc: "Scale mode" },
    { key: "Escape", desc: "Deselect / cancel" },

    // Help
    { group: "Help", key: "?", desc: "Show this shortcut legend" },
];
