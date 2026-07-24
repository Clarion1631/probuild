export const DRAG_VISUAL_ACTIVE_EVENT = "gtr:schedule-drag-visual-active";

export type DragVisualKind =
    | "task-move"
    | "task-resize-left"
    | "task-resize-right"
    | "project-move"
    | "project-marker-move"
    | "project-end-resize";

export interface DragVisualLayerOptions {
    sourceElement: HTMLElement;
    sourceSelector: string;
    kind: DragVisualKind;
    startClientX: number;
    startClientY: number;
    cloneSelector?: string;
}

export interface DragVisualUpdate {
    clientX: number;
    clientY: number;
    deltaX?: number;
    sourceOffsetX?: number;
    label?: string | null;
    targetDate?: string | null;
}

export interface DragVisualLayer {
    update: (_update: DragVisualUpdate) => void;
    cleanup: () => void;
}

interface SavedSourceStyle {
    opacity: string;
}

interface SavedTargetStyle {
    element: HTMLElement;
    backgroundColor: string;
    boxShadow: string;
    outline: string;
    outlineOffset: string;
}

let activeVisualLayerCount = 0;

export function isDragVisualLayerActive(): boolean {
    return activeVisualLayerCount > 0;
}

function publishDragVisualActivity(active: boolean) {
    activeVisualLayerCount = Math.max(0, activeVisualLayerCount + (active ? 1 : -1));
    window.dispatchEvent(new CustomEvent(DRAG_VISUAL_ACTIVE_EVENT, {
        detail: { active: activeVisualLayerCount > 0 },
    }));
}

function escapeAttributeValue(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function taskDragSourceSelector(taskId: string): string {
    return `[data-drag-visual-kind="task"][data-drag-task-id="${escapeAttributeValue(taskId)}"]`;
}

export function projectDragSourceSelector(projectId: string): string {
    return `[data-drag-visual-kind="project"][data-drag-project-id="${escapeAttributeValue(projectId)}"]`;
}

export function projectMarkerDragSourceSelector(projectId: string): string {
    return `${projectDragSourceSelector(projectId)} [data-drag-project-title="true"]`;
}

function stripCloneInteractivity(root: HTMLElement) {
    root.removeAttribute("id");
    root.removeAttribute("tabindex");
    root.removeAttribute("aria-describedby");
    root.querySelectorAll<HTMLElement>("[id],[tabindex],[aria-describedby]").forEach(element => {
        element.removeAttribute("id");
        element.removeAttribute("tabindex");
        element.removeAttribute("aria-describedby");
    });
}

function findScheduleTarget(clientX: number, clientY: number, targetDate: string): HTMLElement | null {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
        const cell = element instanceof HTMLElement
            ? element.closest<HTMLElement>("[data-schedule-date]")
            : null;
        if (cell?.dataset.scheduleDate === targetDate) return cell;
    }

    // A refresh can briefly replace the element below the pointer before the
    // next layout pass. Fall back to the matching cell whose rect is nearest
    // the last pointer position; the following pointer/RAF update will refine
    // this once the new tree has settled.
    let nearest: HTMLElement | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    document.querySelectorAll<HTMLElement>(`[data-schedule-date="${escapeAttributeValue(targetDate)}"]`).forEach(cell => {
        const rect = cell.getBoundingClientRect();
        const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
        const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
        const distance = Math.hypot(dx, dy);
        if (distance < nearestDistance) {
            nearest = cell;
            nearestDistance = distance;
        }
    });
    return nearest;
}

export function createDragVisualLayer({
    sourceElement,
    sourceSelector,
    kind,
    startClientX,
    startClientY,
    cloneSelector,
}: DragVisualLayerOptions): DragVisualLayer {
    const resizeVisual = kind === "task-resize-left"
        || kind === "task-resize-right"
        || kind === "project-end-resize";
    const sourceForClone = cloneSelector
        ? sourceElement.querySelector<HTMLElement>(cloneSelector) ?? sourceElement
        : sourceElement;
    const sourceRect = sourceElement.getBoundingClientRect();
    const cloneRect = sourceForClone.getBoundingClientRect();
    const visualRect = kind === "project-marker-move" ? cloneRect : sourceRect;
    const ghost = document.createElement("div");
    const label = document.createElement("div");
    const savedSourceStyles = new Map<HTMLElement, SavedSourceStyle>();
    let savedTargetStyle: SavedTargetStyle | null = null;
    let latestUpdate: DragVisualUpdate = { clientX: startClientX, clientY: startClientY };
    let cleaned = false;

    ghost.dataset.dragVisualLayer = "true";
    ghost.dataset.dragVisualKind = kind;
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.position = "fixed";
    ghost.style.pointerEvents = "none";
    ghost.style.left = `${visualRect.left}px`;
    ghost.style.top = `${visualRect.top}px`;
    ghost.style.width = `${Math.max(visualRect.width, 1)}px`;
    ghost.style.height = `${Math.max(visualRect.height, 1)}px`;
    ghost.style.zIndex = "90";
    ghost.style.boxSizing = "border-box";
    ghost.style.willChange = "transform,width";
    ghost.style.transform = "translate3d(0px, 0px, 0px)";

    if (resizeVisual) {
        ghost.style.border = "2px solid rgba(79, 70, 229, 0.95)";
        ghost.style.borderRadius = "4px";
        ghost.style.background = "rgba(99, 102, 241, 0.10)";
        ghost.style.boxShadow = "0 4px 14px rgba(15, 23, 42, 0.24)";

        const edge = document.createElement("span");
        edge.style.position = "absolute";
        edge.style.insetBlock = "-2px";
        edge.style.width = "3px";
        edge.style.background = "rgb(79, 70, 229)";
        edge.style.boxShadow = "0 0 0 1px rgba(255, 255, 255, 0.9)";
        if (kind === "task-resize-left") edge.style.left = "-2px";
        else edge.style.right = "-2px";
        ghost.appendChild(edge);
    } else {
        const sourceClone = sourceForClone.cloneNode(true) as HTMLElement;
        stripCloneInteractivity(sourceClone);
        sourceClone.style.position = "relative";
        sourceClone.style.inset = "auto";
        sourceClone.style.left = "auto";
        sourceClone.style.top = "auto";
        sourceClone.style.width = "100%";
        sourceClone.style.height = "100%";
        sourceClone.style.margin = "0";
        sourceClone.style.transform = "none";
        sourceClone.style.pointerEvents = "none";
        sourceClone.style.opacity = "0.92";
        sourceClone.style.filter = "drop-shadow(0 8px 10px rgba(15, 23, 42, 0.28))";
        ghost.appendChild(sourceClone);
    }

    label.dataset.dragVisualLabel = "true";
    label.style.position = "absolute";
    label.style.left = "50%";
    label.style.bottom = "calc(100% + 6px)";
    label.style.transform = "translateX(-50%)";
    label.style.display = "none";
    label.style.whiteSpace = "nowrap";
    label.style.borderRadius = "6px";
    label.style.background = "rgba(15, 23, 42, 0.94)";
    label.style.color = "white";
    label.style.padding = "3px 7px";
    label.style.font = "600 11px/16px ui-sans-serif, system-ui, sans-serif";
    label.style.boxShadow = "0 4px 10px rgba(15, 23, 42, 0.24)";
    ghost.appendChild(label);
    document.body.appendChild(ghost);

    function refreshSources() {
        document.querySelectorAll<HTMLElement>(sourceSelector).forEach(element => {
            if (element.closest("[data-drag-visual-layer]")) return;
            if (!savedSourceStyles.has(element)) {
                savedSourceStyles.set(element, { opacity: element.style.opacity });
            }
            element.style.opacity = "0.28";
        });
    }

    function restoreTarget() {
        if (!savedTargetStyle) return;
        const { element, backgroundColor, boxShadow, outline, outlineOffset } = savedTargetStyle;
        element.style.backgroundColor = backgroundColor;
        element.style.boxShadow = boxShadow;
        element.style.outline = outline;
        element.style.outlineOffset = outlineOffset;
        savedTargetStyle = null;
    }

    function refreshTarget() {
        const targetDate = latestUpdate.targetDate;
        if (!targetDate) {
            restoreTarget();
            return;
        }
        const nextTarget = findScheduleTarget(latestUpdate.clientX, latestUpdate.clientY, targetDate);
        if (savedTargetStyle?.element === nextTarget) return;
        restoreTarget();
        if (!nextTarget) return;
        savedTargetStyle = {
            element: nextTarget,
            backgroundColor: nextTarget.style.backgroundColor,
            boxShadow: nextTarget.style.boxShadow,
            outline: nextTarget.style.outline,
            outlineOffset: nextTarget.style.outlineOffset,
        };
        nextTarget.style.backgroundColor = "rgba(224, 231, 255, 0.82)";
        nextTarget.style.boxShadow = "inset 0 0 0 2px rgb(79, 70, 229)";
        nextTarget.style.outline = "2px solid transparent";
        nextTarget.style.outlineOffset = "-2px";
    }

    const observer = new MutationObserver(() => {
        if (cleaned) return;
        refreshSources();
        refreshTarget();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    refreshSources();
    publishDragVisualActivity(true);

    return {
        update(update) {
            if (cleaned) return;
            latestUpdate = update;
            const rawDeltaX = update.deltaX ?? update.clientX - startClientX;
            const sourceOffsetX = update.sourceOffsetX ?? 0;
            const deltaY = update.clientY - startClientY;

            if (kind === "task-resize-left") {
                const clampedDelta = Math.min(rawDeltaX, sourceRect.width - 1);
                ghost.style.width = `${Math.max(1, sourceRect.width - clampedDelta)}px`;
                ghost.style.transform = `translate3d(${sourceOffsetX + clampedDelta}px, 0px, 0px)`;
            } else if (kind === "task-resize-right" || kind === "project-end-resize") {
                ghost.style.width = `${Math.max(1, sourceRect.width + rawDeltaX)}px`;
                ghost.style.transform = `translate3d(${sourceOffsetX}px, 0px, 0px)`;
            } else {
                ghost.style.transform = `translate3d(${update.clientX - startClientX}px, ${deltaY}px, 0px)`;
            }

            label.textContent = update.label ?? "";
            label.style.display = update.label ? "block" : "none";
            refreshSources();
            refreshTarget();
        },
        cleanup() {
            if (cleaned) return;
            cleaned = true;
            observer.disconnect();
            restoreTarget();
            for (const [element, style] of savedSourceStyles) element.style.opacity = style.opacity;
            savedSourceStyles.clear();
            ghost.remove();
            publishDragVisualActivity(false);
        },
    };
}
