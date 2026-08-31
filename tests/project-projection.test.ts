import assert from "node:assert/strict";
import test from "node:test";
import { calculateProjectedEnd } from "@/lib/project-projection";

const asOf = new Date("2026-08-26T12:00:00.000Z");
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

test("projects in-progress work from remaining duration", () => {
    const projected = calculateProjectedEnd([{
        id: "active",
        startDate: date("2026-08-20"),
        endDate: date("2026-08-30"),
        progress: 50,
        status: "In Progress",
        dependencies: [],
    }], asOf);

    assert.equal(projected?.toISOString(), "2026-08-31T00:00:00.000Z");
});

test("only late not-started successors inherit an in-progress predecessor lag", () => {
    const projected = calculateProjectedEnd([
        {
            id: "active",
            startDate: date("2026-08-01"),
            endDate: date("2026-08-10"),
            progress: 0,
            status: "In Progress",
            dependencies: [],
        },
        {
            id: "future-successor",
            startDate: date("2026-09-01"),
            endDate: date("2026-09-05"),
            progress: 0,
            status: "Not Started",
            dependencies: [{ predecessorId: "active" }],
        },
    ], asOf);

    assert.equal(projected?.toISOString(), "2026-09-05T00:00:00.000Z");
});

test("inherits lag regardless of task input order", () => {
    const projected = calculateProjectedEnd([
        {
            id: "late-successor",
            startDate: date("2026-08-11"),
            endDate: date("2026-08-20"),
            progress: 0,
            status: "Not Started",
            dependencies: [{ predecessorId: "active" }],
        },
        {
            id: "active",
            startDate: date("2026-08-01"),
            endDate: date("2026-08-10"),
            progress: 0,
            status: "In Progress",
            dependencies: [],
        },
    ], asOf);

    assert.equal(projected?.toISOString(), "2026-09-14T00:00:00.000Z");
});

test("inherits lag from the nearest in-progress predecessor through a dependency chain", () => {
    const projected = calculateProjectedEnd([
        {
            id: "late-successor",
            startDate: date("2026-08-16"),
            endDate: date("2026-08-20"),
            progress: 0,
            status: "Not Started",
            dependencies: [{ predecessorId: "middle" }],
        },
        {
            id: "middle",
            startDate: date("2026-08-11"),
            endDate: date("2026-08-15"),
            progress: 0,
            status: "Not Started",
            dependencies: [{ predecessorId: "active" }],
        },
        {
            id: "active",
            startDate: date("2026-08-01"),
            endDate: date("2026-08-10"),
            progress: 0,
            status: "In Progress",
            dependencies: [],
        },
    ], asOf);

    assert.equal(projected?.toISOString(), "2026-09-14T00:00:00.000Z");
});

test("does not include completed tasks in the project projection", () => {
    const projected = calculateProjectedEnd([
        {
            id: "complete",
            startDate: date("2026-10-01"),
            endDate: date("2026-10-10"),
            progress: 100,
            status: "Complete",
            dependencies: [],
        },
    ], asOf);

    assert.equal(projected, null);
});

test("gives a late unblocked task with no dependency a future completion floor", () => {
    const projected = calculateProjectedEnd([{
        id: "late-unblocked",
        startDate: date("2026-08-01"),
        endDate: date("2026-08-11"),
        progress: 0,
        status: "Not Started",
        dependencies: [],
    }], asOf);

    assert.equal(projected?.toISOString(), "2026-09-05T00:00:00.000Z");
});

test("gives a late blocked task a remaining-duration floor", () => {
    const projected = calculateProjectedEnd([{
        id: "blocked",
        startDate: date("2026-08-01"),
        endDate: date("2026-08-11"),
        progress: 40,
        status: "Blocked",
        dependencies: [],
    }], asOf);

    assert.equal(projected?.toISOString(), "2026-09-01T00:00:00.000Z");
});
