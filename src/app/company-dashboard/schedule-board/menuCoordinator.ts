// One schedule-board menu (a project bar's Actions menu, a task block's
// menu, an empty-cell "Schedule here…" menu, etc.) open at a time, across
// components and across trigger kinds (click OR right-click/keyboard context
// menu) — item 1's "opening a context menu closes any click menu and vice
// versa". A module-level singleton is simpler and more robust here than
// lifting menu-open state into a shared ancestor: outside-pointerdown-close
// (FloatingPopover) already handles most cross-menu cases for mouse-driven
// opens, but the keyboard ContextMenu/Shift+F10 path has no pointerdown to
// piggyback on, so an explicit "close whatever was open" call is needed.
let activeMenuClose: (() => void) | null = null;

/**
 * Call when a menu opens (in a `useEffect` keyed on its own open flag —
 * see ProjectBar/TaskBlockSegment). Closes whatever schedule-board menu was
 * previously open, then registers this menu's own closer as the active one.
 */
export function activateExclusiveMenu(close: () => void): void {
    if (activeMenuClose && activeMenuClose !== close) activeMenuClose();
    activeMenuClose = close;
}

/**
 * Call from the same effect's cleanup so a closed menu's closer is never
 * left registered as "active" (and never fired against an already-closed
 * menu by a later, unrelated activation).
 */
export function deactivateExclusiveMenu(close: () => void): void {
    if (activeMenuClose === close) activeMenuClose = null;
}
