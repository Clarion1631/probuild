/**
 * Unit tests for decideClockInDisplay() — the pure derivation the web time
 * clock uses to turn a /api/mobile/time-suggestion response into what the
 * clock-in banner shows and whether it preselects a phase. See
 * src/lib/time-suggestion-display.ts for the priority rules.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideClockInDisplay, type ClockInSuggestionResponse } from "../src/lib/time-suggestion-display";
import type { TimeSuggestion } from "../src/lib/time-suggestion";

function suggestion(overrides: Partial<TimeSuggestion> = {}): TimeSuggestion {
    return {
        scheduleTaskId: "task-1",
        clockInEstimateItemId: "item-1",
        costCodeId: "code-1",
        costCodeLabel: "01-DEMO — Demolition",
        taskName: "Tear out kitchen cabinets",
        source: "dispatch",
        confidence: "high",
        reason: "Dispatched to you today",
        note: null,
        plannedByOffice: false,
        ...overrides,
    };
}

test("plannedByOffice suggestion -> mode 'planned', preselects its phase", () => {
    const response: ClockInSuggestionResponse = {
        suggestion: suggestion({ plannedByOffice: true, note: "Haul debris to the dumpster out front" }),
        uncostedPlannedTask: null,
    };
    const display = decideClockInDisplay(response);
    assert.equal(display.mode, "planned");
    if (display.mode !== "planned") throw new Error("unreachable");
    assert.equal(display.taskName, "Tear out kitchen cabinets");
    assert.equal(display.costCodeLabel, "01-DEMO — Demolition");
    assert.equal(display.costCodeId, "code-1");
    assert.equal(display.scheduleTaskId, "task-1");
    assert.equal(display.note, "Haul debris to the dumpster out front");
});

test("uncostedPlannedTask with no chargeable suggestion -> mode 'uncosted', no phase to preselect", () => {
    const response: ClockInSuggestionResponse = {
        suggestion: null,
        uncostedPlannedTask: { id: "task-2", name: "Drywall start", note: "Hang and tape the master bath" },
    };
    const display = decideClockInDisplay(response);
    assert.equal(display.mode, "uncosted");
    if (display.mode !== "uncosted") throw new Error("unreachable");
    assert.equal(display.taskName, "Drywall start");
    assert.equal(display.note, "Hang and tape the master bath");
});

test("uncostedPlannedTask WITH a lower-tier suggestion present -> still 'uncosted', suggestion is hidden and not preselected", () => {
    // This is the gate bug: an uncosted dispatch must not be hidden behind an
    // unrelated daily-log fallback suggestion.
    const response: ClockInSuggestionResponse = {
        suggestion: suggestion({
            plannedByOffice: false,
            source: "daily_log",
            taskName: "Unrelated log-matched task",
            costCodeId: "code-unrelated",
        }),
        uncostedPlannedTask: { id: "task-2", name: "Drywall start", note: null },
    };
    const display = decideClockInDisplay(response);
    assert.equal(display.mode, "uncosted");
    if (display.mode !== "uncosted") throw new Error("unreachable");
    assert.equal(display.taskName, "Drywall start");
    // No costCodeId on the uncosted variant — nothing to preselect.
    assert.equal((display as any).costCodeId, undefined);
});

test("no dispatch at all, lower-tier suggestion present -> mode 'suggested', preselects its phase", () => {
    const response: ClockInSuggestionResponse = {
        suggestion: suggestion({
            plannedByOffice: false,
            source: "today_schedule",
            taskName: "Frame the addition",
            costCodeId: "code-3",
            costCodeLabel: "02-FRAME — Framing",
            reason: "Your only scheduled task today",
            note: "Double-check header heights against the plan",
        }),
        uncostedPlannedTask: null,
    };
    const display = decideClockInDisplay(response);
    assert.equal(display.mode, "suggested");
    if (display.mode !== "suggested") throw new Error("unreachable");
    assert.equal(display.taskName, "Frame the addition");
    assert.equal(display.costCodeLabel, "02-FRAME — Framing");
    assert.equal(display.costCodeId, "code-3");
    assert.equal(display.reason, "Your only scheduled task today");
    assert.equal(display.note, "Double-check header heights against the plan");
});

test("nothing at all -> mode 'none'", () => {
    const response: ClockInSuggestionResponse = { suggestion: null, uncostedPlannedTask: null };
    const display = decideClockInDisplay(response);
    assert.equal(display.mode, "none");
});
