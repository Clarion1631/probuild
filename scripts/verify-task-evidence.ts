// Behavioral verification for the evidence layer (src/lib/task-evidence.ts)
// and its DST-sensitive day-key helper (src/lib/punch-task-binding.ts).
//
// Everything under test here is a PURE function over in-memory fixtures.
// This script must NEVER connect to a database — see BEHAVIORAL note below.
//
// Usage:
//   npx tsx scripts/verify-task-evidence.ts
import assert from "node:assert/strict";

import { dayKeyFromDateOnly, toCompanyDayKey } from "../src/lib/company-day";
import {
    classifyTaskEvidence,
    daysBetweenDayKeys,
    findContradiction,
    foldTaskEvidence,
    isEvidenceEligible,
    summarizeEvidenceCoverage,
    sumEvidenceCoverage,
    type EvidenceTaskInput,
} from "../src/lib/task-evidence";
import {
    getDispatchExceptions,
    getEvidenceExceptions,
    type DispatchProjectInput,
    type DispatchTaskInput,
} from "../src/app/company-dashboard/schedule-board/dispatch-exceptions";

// ── fixture helpers ──────────────────────────────────────────────────────

// A wide default window so fixtures that only care about freshness (not
// findContradiction's start/end boundary checks) never accidentally trip a
// contradiction. Tests that specifically exercise findContradiction's
// boundary rules pass their own narrow startDate/endDate explicitly.
const WIDE_START = "2026-01-01T00:00:00.000Z";
const WIDE_END = "2026-12-31T00:00:00.000Z";

function task(overrides: Partial<EvidenceTaskInput> & { id: string }): EvidenceTaskInput {
    return {
        startDate: WIDE_START,
        endDate: WIDE_END,
        status: "In Progress",
        type: "task",
        parentId: null,
        lastDirectEvidenceAt: null,
        lastIndirectEvidenceAt: null,
        ...overrides,
    };
}

function dispatchTask(overrides: Partial<DispatchTaskInput> & { id: string }): DispatchTaskInput {
    return {
        name: overrides.id,
        startDate: WIDE_START,
        endDate: WIDE_END,
        status: "In Progress",
        type: "task",
        blockedReason: null,
        assignments: [],
        parentId: null,
        lastDirectEvidenceAt: null,
        lastIndirectEvidenceAt: null,
        ...overrides,
    };
}

function project(overrides: Partial<DispatchProjectInput> & { id: string; tasks: DispatchTaskInput[] }): DispatchProjectInput {
    return {
        name: overrides.id,
        status: "In Progress",
        crew: [],
        ...overrides,
    };
}

const NO_PARENTS: ReadonlySet<string> = new Set();

// ── toCompanyDayKey: DST is the highest-risk logic here ─────────────────

{
    // A 7pm PDT instant on 2026-07-27 is the *next* UTC calendar day.
    assert.equal(
        toCompanyDayKey(new Date("2026-07-28T02:00:00.000Z")),
        "2026-07-27",
        "a UTC instant that is the previous LA calendar day must map to the LA day, not the UTC day",
    );

    // Spring forward: America/Los_Angeles jumps 2:00am PST -> 3:00am PDT at
    // 2026-03-08T10:00:00Z. The transition must not corrupt the day key on
    // either side of it.
    assert.equal(
        toCompanyDayKey(new Date("2026-03-08T09:59:00.000Z")),
        "2026-03-08",
        "just before spring-forward (1:59am PST) must still be 2026-03-08",
    );
    assert.equal(
        toCompanyDayKey(new Date("2026-03-08T10:01:00.000Z")),
        "2026-03-08",
        "just after spring-forward (3:01am PDT) must still be 2026-03-08",
    );

    // Fall back: America/Los_Angeles repeats 1:00am-2:00am at
    // 2026-11-01T09:00:00Z (2:00am PDT -> 1:00am PST). The repeated hour must
    // not push the day key backward or forward.
    assert.equal(
        toCompanyDayKey(new Date("2026-11-01T08:59:00.000Z")),
        "2026-11-01",
        "just before fall-back (1:59am PDT) must still be 2026-11-01",
    );
    assert.equal(
        toCompanyDayKey(new Date("2026-11-01T09:01:00.000Z")),
        "2026-11-01",
        "just after fall-back (1:01am PST, repeated hour) must still be 2026-11-01",
    );

    // An ordinary midday UTC instant maps to the same calendar day.
    assert.equal(
        toCompanyDayKey(new Date("2026-07-15T18:00:00.000Z")),
        "2026-07-15",
        "a midday UTC instant (11am PDT) must map to the same calendar day",
    );

    // Invalid input must return "" rather than throw or produce "Invalid Date"-ish garbage.
    assert.equal(
        toCompanyDayKey(new Date("not-a-date")),
        "",
        "an invalid Date object must return empty string, not throw",
    );
    assert.equal(
        toCompanyDayKey("not-a-date"),
        "",
        "an invalid date string must return empty string, not throw",
    );

    console.log("PASS toCompanyDayKey DST behavior");
}

// ── dayKeyFromDateOnly: manual-timesheet off-by-one regression guard ────

{
    // new Date("2026-07-27") is UTC midnight, which is 2026-07-26 in company
    // time. dayKeyFromDateOnly must take the string verbatim instead of routing
    // it through an instant conversion, or every manually-entered timesheet row
    // silently shifts back one day.
    assert.equal(
        dayKeyFromDateOnly("2026-07-27"),
        "2026-07-27",
        "a date-only string must be returned verbatim, NOT shifted to 2026-07-26 by a UTC-midnight instant conversion",
    );

    console.log("PASS dayKeyFromDateOnly");
}

// ── daysBetweenDayKeys ───────────────────────────────────────────────────

{
    assert.equal(daysBetweenDayKeys("2026-07-27", "2026-07-27"), 0, "same day must be 0");
    assert.equal(daysBetweenDayKeys("2026-07-27", "2026-07-28"), 1, "consecutive days must be 1");
    assert.equal(
        daysBetweenDayKeys("2026-03-07", "2026-03-09"),
        2,
        "date-only math across the spring-forward boundary must be immune to DST (still exactly 2 days)",
    );
    assert.equal(daysBetweenDayKeys("2026-03-09", "2026-03-07"), -2, "order matters — reversed args negate the delta");
    assert.equal(daysBetweenDayKeys("not-a-date", "2026-07-27"), Infinity, "malformed 'from' must return Infinity, not NaN or throw");
    assert.equal(daysBetweenDayKeys("2026-07-27", "not-a-date"), Infinity, "malformed 'to' must return Infinity, not NaN or throw");
    assert.equal(daysBetweenDayKeys("", ""), Infinity, "empty input must return Infinity");

    console.log("PASS daysBetweenDayKeys");
}

// ── isEvidenceEligible ───────────────────────────────────────────────────
//
// isEvidenceEligible now takes a third `dayKey` arg. Eligibility follows the
// SCHEDULE (a half-open startDate <= dayKey < endDate window, matching
// isTaskActiveOnDay), not the status field — a prod survey found all 307
// schedule tasks sitting at "Not Started" (nobody advances task status), so
// status-gated eligibility reported zero forever. Status now only excludes
// Complete.

{
    const DAY = "2026-07-12"; // inside the WIDE fixture window

    assert.equal(
        isEvidenceEligible(task({ id: "t1", type: "milestone", status: "In Progress" }), NO_PARENTS, DAY),
        false,
        "milestones must be excluded regardless of status",
    );
    assert.equal(
        isEvidenceEligible(task({ id: "t2", type: "appointment", status: "In Progress" }), NO_PARENTS, DAY),
        false,
        "appointments must be excluded regardless of status",
    );
    assert.equal(
        isEvidenceEligible(task({ id: "t3", type: "task", status: "In Progress" }), new Set(["t3"]), DAY),
        false,
        "a task whose id is in parentIds (a phase parent) must be excluded",
    );
    assert.equal(
        isEvidenceEligible(task({ id: "t4", type: "task", status: "Not Started" }), NO_PARENTS, DAY),
        true,
        "a Not Started leaf task inside its scheduled window IS eligible — status no longer gates beyond excluding Complete",
    );
    assert.equal(
        isEvidenceEligible(task({ id: "t5", type: "task", status: "Complete" }), NO_PARENTS, DAY),
        false,
        "Complete leaf tasks are not eligible, regardless of the window",
    );
    assert.equal(
        isEvidenceEligible(task({ id: "t6", type: "task", status: "In Progress" }), NO_PARENTS, DAY),
        true,
        "an In Progress leaf task inside its scheduled window must be eligible",
    );
    assert.equal(
        isEvidenceEligible(task({ id: "t7", type: "task", status: "Blocked" }), NO_PARENTS, DAY),
        true,
        "a Blocked leaf task inside its scheduled window must be eligible",
    );
    assert.equal(
        isEvidenceEligible(
            task({
                id: "t8",
                type: "task",
                status: "In Progress",
                startDate: "2026-06-01T00:00:00.000Z",
                endDate: "2026-07-01T00:00:00.000Z",
            }),
            NO_PARENTS,
            DAY,
        ),
        false,
        "a task whose window already closed before dayKey must be ineligible even while status still says In Progress",
    );
    assert.equal(
        isEvidenceEligible(
            task({
                id: "t9",
                type: "task",
                status: "In Progress",
                startDate: "2026-08-01T00:00:00.000Z",
                endDate: "2026-09-01T00:00:00.000Z",
            }),
            NO_PARENTS,
            DAY,
        ),
        false,
        "a task whose window has not yet opened after dayKey must be ineligible even while status says In Progress",
    );
    assert.equal(
        isEvidenceEligible(
            task({ id: "t10", type: "task", status: "In Progress", startDate: DAY, endDate: "2026-07-13T00:00:00.000Z" }),
            NO_PARENTS,
            DAY,
        ),
        true,
        "the window is half-open — dayKey equal to startDate is eligible",
    );
    assert.equal(
        isEvidenceEligible(
            task({ id: "t11", type: "task", status: "In Progress", startDate: "2026-07-11T00:00:00.000Z", endDate: DAY }),
            NO_PARENTS,
            DAY,
        ),
        false,
        "the window is half-open — dayKey equal to endDate is NOT eligible (end-exclusive)",
    );

    console.log("PASS isEvidenceEligible");
}

// ── findContradiction ────────────────────────────────────────────────────

{
    assert.equal(
        findContradiction(task({ id: "c1", lastDirectEvidenceAt: null })),
        null,
        "no direct evidence at all must never be a contradiction",
    );

    // The "Not Started" rule was deliberately removed: it is the resting state
    // of nearly every prod task, so flagging it made the contradiction bucket
    // meaningless. Evidence inside the window on a Not Started task must NOT
    // be a contradiction.
    assert.equal(
        findContradiction(task({
            id: "c2",
            status: "Not Started",
            lastDirectEvidenceAt: "2026-07-11T12:00:00.000Z",
        })),
        null,
        "evidence inside the window on a Not Started task must NOT be flagged — the Not-Started rule was deliberately removed",
    );

    // Removing the status-specific rule doesn't blanket-exempt Not Started —
    // the generic past-end-date rule still applies to any non-Complete status.
    assert.match(
        findContradiction(task({
            id: "c2b",
            status: "Not Started",
            startDate: "2026-07-10T00:00:00.000Z",
            endDate: "2026-07-15T00:00:00.000Z",
            lastDirectEvidenceAt: "2026-07-16T09:00:00.000Z", // past the end day
        })) ?? "",
        /Still active past the scheduled end date/,
        "a Not Started task with evidence past its end date must still be flagged via the generic rule",
    );

    assert.match(
        findContradiction(task({
            id: "c3",
            status: "Complete",
            startDate: "2026-07-10T00:00:00.000Z",
            endDate: "2026-07-15T00:00:00.000Z",
            lastDirectEvidenceAt: "2026-07-15T09:00:00.000Z", // on the end day itself
        })) ?? "",
        /Field activity after this was marked complete/,
        "work at/after the end day on a Complete task must be flagged as logged-after-complete",
    );

    assert.match(
        findContradiction(task({
            id: "c4",
            status: "In Progress",
            startDate: "2026-07-10T00:00:00.000Z",
            endDate: "2026-07-15T00:00:00.000Z",
            lastDirectEvidenceAt: "2026-07-16T09:00:00.000Z", // past the end day
        })) ?? "",
        /Still active past the scheduled end date/,
        "work past the scheduled end date on a non-Complete task must be flagged",
    );

    assert.match(
        findContradiction(task({
            id: "c5",
            status: "In Progress",
            startDate: "2026-07-10T00:00:00.000Z",
            endDate: "2026-07-15T00:00:00.000Z",
            lastDirectEvidenceAt: "2026-07-09T09:00:00.000Z", // before start day
        })) ?? "",
        /Field activity before the scheduled start date/,
        "work before the scheduled start date must be flagged",
    );

    assert.equal(
        findContradiction(task({
            id: "c6",
            status: "In Progress",
            startDate: "2026-07-10T00:00:00.000Z",
            endDate: "2026-07-15T00:00:00.000Z",
            lastDirectEvidenceAt: "2026-07-12T09:00:00.000Z", // inside the window
        })),
        null,
        "an ordinary in-window In Progress task must not be flagged",
    );

    console.log("PASS findContradiction");
}

// ── classifyTaskEvidence ─────────────────────────────────────────────────

{
    // Contradiction wins over everything, including ineligibility: a task
    // whose window already closed before dayKey (ineligible under the
    // date-gated rule) but whose evidence is dated past its end must still
    // surface as needsReview, not silently disappear as notApplicable.
    const closedWindowWithLateEvidence = task({
        id: "cl1",
        status: "In Progress",
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-07-01T00:00:00.000Z",
        lastDirectEvidenceAt: "2026-07-05T12:00:00.000Z",
    });
    assert.equal(
        isEvidenceEligible(closedWindowWithLateEvidence, NO_PARENTS, "2026-07-12"),
        false,
        "sanity: a task whose window closed before dayKey is ineligible on its own",
    );
    assert.notEqual(
        findContradiction(closedWindowWithLateEvidence),
        null,
        "sanity: evidence past the end date is a contradiction on its own",
    );
    assert.equal(
        classifyTaskEvidence(closedWindowWithLateEvidence, NO_PARENTS, "2026-07-12"),
        "needsReview",
        "a task with a contradiction must classify needsReview even when the date window also makes it ineligible — contradiction wins",
    );

    assert.equal(
        classifyTaskEvidence(task({ id: "cl2", status: "In Progress", lastDirectEvidenceAt: null }), NO_PARENTS, "2026-07-12"),
        "unknown",
        "eligible + no direct evidence must be unknown",
    );

    assert.equal(
        classifyTaskEvidence(
            task({ id: "cl3", status: "In Progress", lastDirectEvidenceAt: "2026-07-10T12:00:00.000Z" }),
            NO_PARENTS,
            "2026-07-12",
            2,
        ),
        "confirmed",
        "eligible + evidence exactly at the staleAfterDays boundary must be confirmed",
    );

    assert.equal(
        classifyTaskEvidence(
            task({ id: "cl4", status: "In Progress", lastDirectEvidenceAt: "2026-07-09T12:00:00.000Z" }),
            NO_PARENTS,
            "2026-07-12",
            2,
        ),
        "stale",
        "eligible + evidence one day older than the boundary must be stale",
    );

    assert.equal(
        classifyTaskEvidence(task({ id: "cl5", type: "milestone", status: "In Progress" }), NO_PARENTS, "2026-07-12"),
        "notApplicable",
        "ineligible with no contradiction must be notApplicable",
    );

    // unknown and stale are mutually exclusive for the same task: flip the
    // clock across the staleAfterDays boundary and confirm exactly one state
    // ever applies, never both.
    const borderline = task({ id: "cl6", status: "In Progress", lastDirectEvidenceAt: "2026-07-10T12:00:00.000Z" });
    const justInside = classifyTaskEvidence(borderline, NO_PARENTS, "2026-07-12", 2);
    const justOutside = classifyTaskEvidence(borderline, NO_PARENTS, "2026-07-13", 2);
    assert.equal(justInside, "confirmed");
    assert.equal(justOutside, "stale");
    assert.notEqual(justInside, justOutside, "unknown and stale (here: confirmed and stale) must never coincide for the same task");

    // Regression guard: a task ending 2026-07-28, with direct evidence at
    // 2026-07-28T02:00:00.000Z (7pm PDT on the 27th — the last active day).
    // Under the old UTC-slice logic, that timestamp sliced to "2026-07-28",
    // which equals the end day and fired a false "still active past the
    // scheduled end date" contradiction on perfectly legitimate evening work.
    // toCompanyDayKey must resolve it to the 27th, so it classifies confirmed.
    const eveningWork = task({
        id: "cl7",
        status: "In Progress",
        startDate: "2026-07-20T00:00:00.000Z",
        endDate: "2026-07-28T00:00:00.000Z",
        lastDirectEvidenceAt: "2026-07-28T02:00:00.000Z",
    });
    assert.equal(findContradiction(eveningWork), null, "7pm PDT evidence on the last active day must not be a contradiction");
    assert.equal(
        classifyTaskEvidence(eveningWork, NO_PARENTS, "2026-07-27", 2),
        "confirmed",
        "evening work logged in company-local time on the last active day must classify confirmed, NOT needsReview",
    );

    // Future evidence: a timestamp dated after dayKey is a clock/data fault, not
    // confirmation, and must never satisfy the freshness window.
    const futureEvidence = task({
        id: "cl8",
        status: "In Progress",
        lastDirectEvidenceAt: "2026-07-15T12:00:00.000Z",
    });
    assert.equal(
        classifyTaskEvidence(futureEvidence, NO_PARENTS, "2026-07-10", 2),
        "needsReview",
        "evidence dated after dayKey (negative age) must classify needsReview, not confirmed",
    );

    console.log("PASS classifyTaskEvidence");
}

// ── foldTaskEvidence ─────────────────────────────────────────────────────

{
    const directMax = foldTaskEvidence({
        lastTimeEntryAt: "2026-07-10T08:00:00.000Z",
        lastPunchItemCompletedAt: "2026-07-11T08:00:00.000Z",
    });
    assert.equal(directMax.lastDirectEvidenceAt, new Date("2026-07-11T08:00:00.000Z").toISOString(), "direct must take the max of time-entry and punch-item timestamps");

    const directMaxReversed = foldTaskEvidence({
        lastTimeEntryAt: "2026-07-12T08:00:00.000Z",
        lastPunchItemCompletedAt: "2026-07-11T08:00:00.000Z",
    });
    assert.equal(directMaxReversed.lastDirectEvidenceAt, new Date("2026-07-12T08:00:00.000Z").toISOString(), "direct max must work regardless of which input is newer");

    const indirectMax = foldTaskEvidence({
        lastCommentAt: "2026-07-10T08:00:00.000Z",
        lastMaterialStatusAt: "2026-07-12T08:00:00.000Z",
        lastProjectDailyLogAt: "2026-07-11T08:00:00.000Z",
    });
    assert.equal(indirectMax.lastIndirectEvidenceAt, new Date("2026-07-12T08:00:00.000Z").toISOString(), "indirect must take the max of comment/material/project-daily-log");

    // The critical guard: a project daily log must NEVER land in the direct
    // field, even when it is newer than everything else.
    const dailyLogOnly = foldTaskEvidence({
        lastProjectDailyLogAt: "2026-12-01T00:00:00.000Z",
    });
    assert.equal(dailyLogOnly.lastDirectEvidenceAt, null, "a project daily log must never land in the direct field");
    assert.equal(dailyLogOnly.lastIndirectEvidenceAt, new Date("2026-12-01T00:00:00.000Z").toISOString());

    const allNull = foldTaskEvidence({});
    assert.equal(allNull.lastDirectEvidenceAt, null, "all-null input must yield null direct");
    assert.equal(allNull.lastIndirectEvidenceAt, null, "all-null input must yield null indirect");

    // Date and ISO-string inputs must be interchangeable.
    const mixedInputTypes = foldTaskEvidence({
        lastTimeEntryAt: new Date("2026-07-10T08:00:00.000Z"),
        lastPunchItemCompletedAt: "2026-07-09T08:00:00.000Z",
    });
    assert.equal(mixedInputTypes.lastDirectEvidenceAt, new Date("2026-07-10T08:00:00.000Z").toISOString());

    console.log("PASS foldTaskEvidence");
}

// ── summarizeEvidenceCoverage / sumEvidenceCoverage ─────────────────────

{
    const tasks: EvidenceTaskInput[] = [
        task({ id: "s1", status: "In Progress", lastDirectEvidenceAt: "2026-07-11T12:00:00.000Z" }), // confirmed
        task({ id: "s2", status: "In Progress", lastDirectEvidenceAt: "2026-07-01T12:00:00.000Z" }), // stale
        task({ id: "s3", status: "In Progress", lastDirectEvidenceAt: null }), // unknown
        task({ id: "s4", type: "milestone", status: "In Progress" }), // notApplicable
        task({
            id: "s5",
            status: "In Progress",
            startDate: "2026-06-01T00:00:00.000Z",
            endDate: "2026-07-01T00:00:00.000Z",
            lastDirectEvidenceAt: "2026-07-05T12:00:00.000Z",
        }), // needsReview: window closed before dayKey (ineligible) AND evidence past its end (contradiction)
    ];
    const coverage = summarizeEvidenceCoverage(tasks, NO_PARENTS, "2026-07-12", { staleAfterDays: 2, unboundPunches: 3 });

    assert.equal(coverage.confirmed, 1);
    assert.equal(coverage.stale, 1);
    assert.equal(coverage.unknown, 1);
    assert.equal(coverage.needsReview, 1);
    assert.ok(
        coverage.confirmed + coverage.stale + coverage.unknown <= coverage.eligible,
        "confirmed + stale + unknown must not exceed eligible",
    );
    assert.equal(coverage.eligible, 3, "s1/s2/s3 are eligible; s4 is not a leaf task; s5 is ineligible (its window already closed)");
    assert.equal(
        coverage.needsReview,
        1,
        "a needsReview task whose date window makes it ineligible (s5) must increment needsReview without inflating eligible",
    );
    assert.equal(coverage.unboundPunches, 3, "unboundPunches must pass through unchanged");

    // sum over parts is componentwise
    const partA = summarizeEvidenceCoverage(tasks.slice(0, 2), NO_PARENTS, "2026-07-12", { unboundPunches: 1 });
    const partB = summarizeEvidenceCoverage(tasks.slice(2), NO_PARENTS, "2026-07-12", { unboundPunches: 2 });
    const summed = sumEvidenceCoverage([partA, partB]);
    assert.deepEqual(summed, coverage, "summing coverage over parts must equal summarizing the whole set at once");

    console.log("PASS summarizeEvidenceCoverage / sumEvidenceCoverage");
}

// ── getEvidenceExceptions ─────────────────────────────────────────────────

{
    const inProgressProject = project({
        id: "p1",
        status: "In Progress",
        tasks: [
            dispatchTask({ id: "p1-unknown", status: "In Progress", lastDirectEvidenceAt: null }),
            dispatchTask({ id: "p1-stale", status: "In Progress", lastDirectEvidenceAt: "2026-07-01T12:00:00.000Z" }),
            dispatchTask({
                id: "p1-review",
                status: "In Progress",
                endDate: "2026-07-05T00:00:00.000Z", // schedule says done by the 5th
                lastDirectEvidenceAt: "2026-07-11T12:00:00.000Z", // but evidence lands after — contradiction
            }),
            dispatchTask({ id: "p1-confirmed", status: "In Progress", lastDirectEvidenceAt: "2026-07-11T12:00:00.000Z" }),
        ],
    });
    const notStartedProject = project({
        id: "p2",
        status: "Waiting to Start",
        tasks: [
            dispatchTask({ id: "p2-unknown", status: "In Progress", lastDirectEvidenceAt: null }),
        ],
    });

    const exceptions = getEvidenceExceptions([inProgressProject, notStartedProject], "2026-07-12");

    // Only In Progress projects contribute.
    assert.ok(
        ![...exceptions.unknownState, ...exceptions.staleEvidence, ...exceptions.needsReview]
            .some(item => item.projectId === "p2"),
        "a non-In-Progress project must not contribute to any evidence exception group",
    );

    assert.deepEqual(exceptions.unknownState.map(item => item.taskId), ["p1-unknown"]);
    assert.deepEqual(exceptions.staleEvidence.map(item => item.taskId), ["p1-stale"]);
    assert.deepEqual(exceptions.needsReview.map(item => item.taskId), ["p1-review"]);

    // The three groups are disjoint.
    const allIds = [
        ...exceptions.unknownState.map(item => item.taskId),
        ...exceptions.staleEvidence.map(item => item.taskId),
        ...exceptions.needsReview.map(item => item.taskId),
    ];
    assert.equal(new Set(allIds).size, allIds.length, "no task id may appear in two evidence exception groups");

    // needsReview entries carry a non-null reason.
    for (const entry of exceptions.needsReview) {
        assert.ok(entry.reason, `needsReview entry for ${entry.taskId} must carry a non-null reason`);
    }

    // Sanity: getDispatchExceptions wires the evidence groups through unchanged.
    const full = getDispatchExceptions([inProgressProject, notStartedProject], [], "2026-07-12");
    assert.deepEqual(full.unknownState, exceptions.unknownState);
    assert.deepEqual(full.staleEvidence, exceptions.staleEvidence);
    assert.deepEqual(full.needsReview, exceptions.needsReview);

    console.log("PASS getEvidenceExceptions");
}

console.log("task-evidence verification: PASS");
