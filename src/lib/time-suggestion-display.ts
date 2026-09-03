// Pure decision helper for the clock-in suggestion banner (web time clock).
//
// The `/api/mobile/time-suggestion` response can carry a chargeable
// `suggestion` and/or an `uncostedPlannedTask`. A caller dispatched to an
// uncosted task today must see that fact — never a lower-tier, unrelated
// suggestion (daily log / schedule / history) silently standing in for it.
// Priority, mirroring the mobile client:
//   1. `suggestion.plannedByOffice` — the office's dispatch, chargeable. Show
//      it and preselect its phase.
//   2. else `uncostedPlannedTask` — dispatched today, but nothing chargeable
//      to preselect. Say so; do NOT preselect or surface any lower-tier
//      `suggestion` alongside it — that would misrepresent it as the plan.
//   3. else `suggestion` (daily_log / today_schedule / user_history) —
//      current behaviour: show and preselect.
//   4. else nothing to show.

import type { TimeSuggestion, TimeSuggestionSource, UncostedPlannedTask } from "@/lib/time-suggestion";

export interface ClockInSuggestionResponse {
    suggestion: TimeSuggestion | null;
    uncostedPlannedTask: UncostedPlannedTask | null;
}

export type ClockInDisplay =
    | {
          mode: "planned";
          taskName: string;
          costCodeLabel: string;
          costCodeId: string;
          scheduleTaskId: string;
          note: string | null;
          source: TimeSuggestionSource;
      }
    | {
          mode: "uncosted";
          taskId: string;
          taskName: string;
          note: string | null;
      }
    | {
          mode: "suggested";
          taskName: string;
          costCodeLabel: string;
          costCodeId: string;
          scheduleTaskId: string;
          note: string | null;
          reason: string | null;
          source: TimeSuggestionSource;
      }
    | { mode: "none" };

export function decideClockInDisplay(response: ClockInSuggestionResponse): ClockInDisplay {
    const { suggestion, uncostedPlannedTask } = response;

    if (suggestion && suggestion.plannedByOffice) {
        return {
            mode: "planned",
            taskName: suggestion.taskName,
            costCodeLabel: suggestion.costCodeLabel,
            costCodeId: suggestion.costCodeId,
            scheduleTaskId: suggestion.scheduleTaskId,
            note: suggestion.note,
            source: suggestion.source,
        };
    }

    if (uncostedPlannedTask) {
        return {
            mode: "uncosted",
            taskId: uncostedPlannedTask.id,
            taskName: uncostedPlannedTask.name,
            note: uncostedPlannedTask.note,
        };
    }

    if (suggestion) {
        return {
            mode: "suggested",
            taskName: suggestion.taskName,
            costCodeLabel: suggestion.costCodeLabel,
            costCodeId: suggestion.costCodeId,
            scheduleTaskId: suggestion.scheduleTaskId,
            note: suggestion.note,
            reason: suggestion.reason,
            source: suggestion.source,
        };
    }

    return { mode: "none" };
}

// ── Clock-in POST audit fields ──────────────────────────────────────────────
//
// The clock-in form must submit suggestion audit fields that match what was
// actually SHOWN and offered to the user, not the raw (possibly lower-tier,
// unrelated) `suggestion` the API returned — a suppressed suggestion behind
// an `uncosted` display must never be recorded as an accepted suggestion.
// Mirrors POST /api/time-entries' accepted shape (src/app/api/time-entries/route.ts):
// suggestedScheduleTaskId is re-validated server-side against the project, so
// only an id needs to travel here — no need to also carry the task name.

export interface ClockInAuditFields {
    suggestedScheduleTaskId?: string;
    suggestedCostCodeId?: string;
    suggestionSource?: TimeSuggestionSource;
    suggestionOverridden?: boolean;
}

/**
 * Build the suggestion audit fields for the clock-in POST from the display
 * decision actually shown to the user (never from the raw API response).
 *   - "planned"/"suggested" — the shown suggestion's own fields; overridden
 *     is true iff the selected phase differs from the suggestion's cost code.
 *   - "uncosted" — nothing chargeable to compare against, so there's no
 *     cost-code field to submit; the dispatched task id is still recorded
 *     as accepted (there is no lower phase to fall back to and the user was
 *     never shown one), tagged with source "dispatch".
 *   - "none" — no suggestion was shown; nothing to submit.
 */
export function buildClockInAuditFields(decision: ClockInDisplay, selectedPhaseId: string): ClockInAuditFields {
    switch (decision.mode) {
        case "planned":
        case "suggested":
            return {
                suggestedScheduleTaskId: decision.scheduleTaskId,
                suggestedCostCodeId: decision.costCodeId,
                suggestionSource: decision.source,
                suggestionOverridden: selectedPhaseId !== decision.costCodeId,
            };
        case "uncosted":
            return {
                suggestedScheduleTaskId: decision.taskId,
                suggestionSource: "dispatch",
                suggestionOverridden: true,
            };
        case "none":
            return {};
    }
}
