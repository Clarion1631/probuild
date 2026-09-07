/** Client labels never establish office dispatch provenance or its cost code. */
export function resolveDispatchSuggestionAudit(
    suggestedTaskId: string | null,
    winner: { taskId: string; chargeable: boolean; costCodeId: string | null } | null,
) {
    return suggestedTaskId && winner?.taskId === suggestedTaskId && winner.chargeable && winner.costCodeId
        ? { source: 'dispatch', costCodeId: winner.costCodeId }
        : { source: null, costCodeId: null };
}

export function dispatchAcceptanceIsCurrent(
    taskId: string | null, costCodeId: string | null, estimateItemId: string | null,
    winner: {taskId: string; chargeable: boolean; costCodeId: string | null; estimateItemId: string | null} | null,
) {
    return !!winner && winner.chargeable && winner.taskId === taskId
        && winner.costCodeId === costCodeId
        && (!estimateItemId || winner.estimateItemId === estimateItemId);
}
