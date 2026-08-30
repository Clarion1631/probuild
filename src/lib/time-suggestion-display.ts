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

import type { TimeSuggestion, UncostedPlannedTask } from "@/lib/time-suggestion";

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
      }
    | {
          mode: "uncosted";
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
        };
    }

    if (uncostedPlannedTask) {
        return {
            mode: "uncosted",
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
        };
    }

    return { mode: "none" };
}
