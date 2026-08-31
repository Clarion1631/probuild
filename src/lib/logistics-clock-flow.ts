/**
 * Pure attribution guards shared by the web time clock and the API.
 * Logistics is a temporary labor bucket, never a real cost-code allocation.
 */
export function normalizeClockInAttribution({
    isLogistics,
    costCodeId,
    estimateItemId,
}: {
    isLogistics: boolean;
    costCodeId: string | null;
    estimateItemId: string | null;
}) {
    if (isLogistics) return { costCodeId: null, estimateItemId: null };
    return { costCodeId, estimateItemId };
}

/**
 * Disabled HTML options are absent from FormData. A missing target means the
 * manager did not choose a new destination, so the form must not reroute it.
 * An empty submitted option is the explicit "Overhead" choice.
 */
export function routeTargetFromManagerForm(target: string | null): string | null | undefined {
    if (target === null) return undefined;
    return target || null;
}

/** Apply the form's three-state value without asking the server action to infer it. */
export async function applyManagerRouteForm(
    target: string | null,
    reroute: (projectId: string | null) => Promise<unknown>,
): Promise<void> {
    const routeTarget = routeTargetFromManagerForm(target);
    if (routeTarget !== undefined) await reroute(routeTarget);
}
