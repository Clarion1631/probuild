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

export function acceptedSuggestionConflictsWithPlan(
    source: unknown, overridden: unknown,
    taskId: string | null, costCodeId: string | null, estimateItemId: string | null,
    plan: {assignmentCount:number;winner:Parameters<typeof dispatchAcceptanceIsCurrent>[3]},
) {
    if (overridden === true || !['dispatch','daily_log','today_schedule','user_history'].includes(String(source))) return false;
    // A removed dispatch plan is stale; ordinary inference remains valid when no
    // office assignment exists. Multiple assignments are not the same as no plan.
    if (plan.assignmentCount === 0) return source === 'dispatch';
    return plan.assignmentCount !== 1 || !dispatchAcceptanceIsCurrent(taskId,costCodeId,estimateItemId,plan.winner);
}
