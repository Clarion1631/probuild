const BLOCKED_CELL_TARGET_SELECTOR = [
    "[data-task-edit-block]",
    "[data-drag-visual-kind]",
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "form",
    "details",
    "[contenteditable=true]",
    '[role="button"]',
    '[role="menuitem"]',
].join(",");

export function isPrimaryUnmodifiedClick(event: {
    button: number;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}): boolean {
    return event.button === 0
        && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function isScheduleCellBackgroundTarget(
    target: EventTarget | null,
    currentTarget: HTMLElement,
): boolean {
    if (!(target instanceof Element)) return false;
    const blockedTarget = target.closest(BLOCKED_CELL_TARGET_SELECTOR);
    return blockedTarget === null || blockedTarget === currentTarget;
}
