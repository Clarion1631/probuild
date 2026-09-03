import assert from "node:assert/strict";
import test from "node:test";
import {
    ScheduleTaskValidationError,
    UNEXPECTED_SCHEDULE_TASK_ERROR,
    toScheduleTaskFailure,
} from "@/lib/schedule-task-result";
import { UPDATE_LEGACY_ROWS } from "../scripts/apply-schedule-task-exclusive-end.mjs";

test("ScheduleTaskValidationError carries the VALIDATION code and its own name", () => {
    const err = new ScheduleTaskValidationError("Task end date must be after its start date");
    assert.equal(err.code, "VALIDATION");
    assert.equal(err.name, "ScheduleTaskValidationError");
    assert.ok(err instanceof Error);
});

test("the backfill UPDATE only targets non-milestone rows with end <= start", () => {
    assert.match(UPDATE_LEGACY_ROWS, /"endDate"\s*<=\s*"startDate"/);
    assert.match(UPDATE_LEGACY_ROWS, /type"\s*<>\s*'milestone'/);
    assert.match(UPDATE_LEGACY_ROWS, /UPDATE\s+"ScheduleTask"/);
    assert.match(UPDATE_LEGACY_ROWS, /"startDate"\s*\+\s*interval\s*'1 day'/);
});

test("toScheduleTaskFailure classifies each branch in order", () => {
    assert.deepEqual(toScheduleTaskFailure(new Error("Task not found")), {
        ok: false,
        code: "NOT_FOUND",
        error: "That task no longer exists. Refresh the page.",
    });

    assert.deepEqual(toScheduleTaskFailure({ code: "P2025" }), {
        ok: false,
        code: "NOT_FOUND",
        error: "That task no longer exists. Refresh the page.",
    });

    assert.deepEqual(toScheduleTaskFailure(new ScheduleTaskValidationError("x")), {
        ok: false,
        code: "VALIDATION",
        error: "x",
    });

    assert.deepEqual(toScheduleTaskFailure(new Error("Forbidden")), {
        ok: false,
        code: "FORBIDDEN",
        error: "You do not have access to this project's schedule.",
    });

    assert.deepEqual(toScheduleTaskFailure(new Error("boom")), {
        ok: false,
        code: "UNEXPECTED",
        error: UNEXPECTED_SCHEDULE_TASK_ERROR,
    });

    // "Task not found" is checked before the ScheduleTaskValidationError branch,
    // so it wins even when the thrown error is a validation error.
    assert.deepEqual(toScheduleTaskFailure(new ScheduleTaskValidationError("Task not found")), {
        ok: false,
        code: "NOT_FOUND",
        error: "That task no longer exists. Refresh the page.",
    });
});
