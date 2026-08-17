/**
 * Route-level tests for GET /api/mobile/pay-period-summary, using the same
 * dependency-injection pattern as tests/qbo-expense-sync-route.test.ts — no
 * database required.
 *
 * Imports from the pure core module (src/lib/pay-period-summary-core.ts),
 * NOT the route file itself — the route file has a STATIC import of
 * mobile-auth.ts, which throws at module load without NEXTAUTH_SECRET.
 * Going through the core module keeps that fail-fast behavior on the real
 * route while leaving this suite free of any env-var dependency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createPayPeriodSummaryHandlers,
    MAX_PAY_PERIOD_RANGE_DAYS,
    type PayPeriodSummaryDependencies,
} from "../src/lib/pay-period-summary-core";
import { startOfDateInTimeZone } from "../src/lib/tz-date";

const TZ = "America/Los_Angeles";

type Entry = { startTime: Date; durationHours: number; laborCost: number | null; burdenCost: number | null };

function createDeps(overrides: {
    role?: string;
    entries?: Entry[];
    hourlyRate?: number;
    burdenRate?: number;
    authOk?: boolean;
} = {}) {
    const entries = overrides.entries ?? [];
    const calls: Array<{ userId: string; rangeStart: Date; rangeEnd: Date }> = [];

    const dependencies: PayPeriodSummaryDependencies = {
        authenticate: async () =>
            overrides.authOk === false
                ? { ok: false, status: 401, error: "Unauthorized" }
                : { ok: true, user: { id: "u1", role: overrides.role ?? "FIELD_CREW" } },
        getUser: async (userId) => {
            if (userId !== "u1" && userId !== "u2") return null;
            return {
                id: userId,
                name: userId === "u1" ? "Crew One" : "Crew Two",
                email: `${userId}@example.test`,
                hourlyRate: overrides.hourlyRate ?? 20,
                burdenRate: overrides.burdenRate ?? 0,
            };
        },
        getTimeEntries: async (userId, rangeStart, rangeEnd) => {
            calls.push({ userId, rangeStart, rangeEnd });
            // Mimic a real DB query: only entries whose startTime falls in
            // [rangeStart, rangeEnd) come back. This is what makes the
            // "Monday-morning hours" blocker test meaningful — if the route
            // computes too narrow a range, those entries simply never arrive here.
            return entries.filter((e) => e.startTime >= rangeStart && e.startTime < rangeEnd);
        },
        resolveTimeZone: async () => TZ,
    };
    return { dependencies, calls };
}

function req(qs: string) {
    return new Request(`https://example.test/api/mobile/pay-period-summary${qs}`);
}

test("400 when start or end is missing", async () => {
    const { dependencies } = createDeps();
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const res = await GET(req("?start=2026-08-10T00:00:00-07:00"));
    assert.equal(res.status, 400);
});

test("400 when end <= start", async () => {
    const { dependencies } = createDeps();
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const res = await GET(req("?start=2026-08-10T08:00:00-07:00&end=2026-08-10T08:00:00-07:00"));
    assert.equal(res.status, 400);
});

test(`400 when the range exceeds ${MAX_PAY_PERIOD_RANGE_DAYS} days`, async () => {
    const { dependencies } = createDeps();
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date(start.getTime() + (MAX_PAY_PERIOD_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000);
    const res = await GET(req(`?start=${start.toISOString()}&end=${end.toISOString()}`));
    assert.equal(res.status, 400);
});

test(`a range of exactly ${MAX_PAY_PERIOD_RANGE_DAYS} days is accepted`, async () => {
    const { dependencies } = createDeps();
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date(start.getTime() + MAX_PAY_PERIOD_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const res = await GET(req(`?start=${start.toISOString()}&end=${end.toISOString()}`));
    assert.equal(res.status, 200);
});

test(`a range of exactly ${MAX_PAY_PERIOD_RANGE_DAYS} company-local calendar days that spans a DST fall-back (a 25h day) is still accepted`, async () => {
    // 2026-10-01 -> 2026-12-02 (PT) is exactly 62 company-local calendar
    // days apart (Oct has 31 days, Nov has 30, plus 1 into December), and it
    // spans the 2026-11-01 DST fall-back in America/Los_Angeles, where that
    // one calendar day is 25 real hours instead of 24. The old fixed
    // elapsedMs/86_400_000 math would compute ~62.04 days for this range and
    // wrongly reject it even though it is exactly 62 calendar days.
    const { dependencies } = createDeps();
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const start = startOfDateInTimeZone("2026-10-01", TZ);
    const end = startOfDateInTimeZone("2026-12-02", TZ);
    const res = await GET(req(`?start=${start.toISOString()}&end=${end.toISOString()}`));
    assert.equal(res.status, 200);
});

test(`a range of ${MAX_PAY_PERIOD_RANGE_DAYS + 1} company-local calendar days spanning the same DST fall-back is still rejected`, async () => {
    const { dependencies } = createDeps();
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const start = startOfDateInTimeZone("2026-10-01", TZ);
    const end = startOfDateInTimeZone("2026-12-03", TZ); // 63 calendar days
    const res = await GET(req(`?start=${start.toISOString()}&end=${end.toISOString()}`));
    assert.equal(res.status, 400);
});

test("propagates the authenticate() failure status/error unchanged", async () => {
    const { dependencies } = createDeps({ authOk: false });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const res = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-11T00:00:00-07:00"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
});

test("FIELD_CREW requesting their own data succeeds; requesting someone else's is 403", async () => {
    const { dependencies } = createDeps({ role: "FIELD_CREW" });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);

    const own = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-11T00:00:00-07:00&userId=u1"));
    assert.equal(own.status, 200);

    const other = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-11T00:00:00-07:00&userId=u2"));
    assert.equal(other.status, 403);
});

test("MANAGER requesting another user's data succeeds and prices at the TARGET user's rate", async () => {
    const monday = new Date("2026-08-10T15:00:00.000-07:00"); // Mon 8am PT
    const { dependencies } = createDeps({
        role: "MANAGER",
        hourlyRate: 20, // requester's rate — must NOT be used
        entries: [{ startTime: monday, durationHours: 5, laborCost: null, burdenCost: null }],
    });
    // Override getUser so u2 has a distinct rate from the requester.
    const wrapped: PayPeriodSummaryDependencies = {
        ...dependencies,
        getUser: async (userId) => {
            if (userId === "u2") return { id: "u2", name: "Crew Two", email: "u2@example.test", hourlyRate: 50, burdenRate: 0 };
            return dependencies.getUser(userId);
        },
    };
    const { GET } = createPayPeriodSummaryHandlers(wrapped);

    const res = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-11T00:00:00-07:00&userId=u2"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, "u2");
    // No stored laborCost on the entry -> falls back to the TARGET user's
    // (u2's) current rate, $50/hr, not the requesting manager's $20/hr.
    assert.equal(body.regularPay, 250); // 5 * 50
    assert.equal(body.ratesUsingCurrentRateFallback, 1);
});

test("404 for a manager requesting a target user that does not exist", async () => {
    const { dependencies } = createDeps({ role: "MANAGER" });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);
    const res = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-11T00:00:00-07:00&userId=does-not-exist"));
    assert.equal(res.status, 404);
});

test("half-open [start, end) boundary: an entry exactly AT end is excluded, exactly AT start is included", async () => {
    const start = new Date("2026-08-10T07:00:00.000Z"); // Mon 2026-08-10 00:00 PT
    const end = new Date("2026-08-10T15:00:00.000Z"); // Mon 2026-08-10 08:00 PT (8h later)

    const { dependencies } = createDeps({
        entries: [
            { startTime: start, durationHours: 8, laborCost: null, burdenCost: null }, // exactly at start — IN
            { startTime: end, durationHours: 8, laborCost: null, burdenCost: null }, // exactly at end — OUT
        ],
        hourlyRate: 10,
    });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);

    const res = await GET(req(`?start=${start.toISOString()}&end=${end.toISOString()}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.regularHours, 8); // only the entry AT start counted
    assert.equal(body.regularPay, 80); // 8 * 10
});

test("BLOCKER regression: a Sunday-noon period start still sees that workweek's Monday-morning hours for the 40h threshold", async () => {
    // Workweek Mon 2026-08-10 .. Sun 2026-08-16 (America/Los_Angeles).
    // A crew member worked Monday 6-10am (4h, well before noon) plus 32 more
    // hours Tue-Fri (36h cumulative through Friday). The pay period being
    // requested only STARTS Sunday at noon, covering just a 6-hour Sunday
    // afternoon entry. That Sunday entry is the 37th-42nd hour of the week,
    // so it must split 4h regular / 2h overtime — but only if the route
    // actually sees the Monday-morning hours despite them falling before the
    // requested period's `start`.
    //
    // The bug this guards against: a fixed "start - 6 days" padding computes
    // paddedStart = Monday NOON (6 days before Sunday noon), which excludes
    // the 6-10am Monday entry (it starts before noon) — silently undercounting
    // the week by 4 hours and misclassifying the Sunday entry as fully regular.
    const mondayMorning = new Date("2026-08-10T13:00:00.000Z"); // Mon 6am PT
    const tuesday = new Date("2026-08-11T15:00:00.000Z"); // Tue 8am PT
    const wednesday = new Date("2026-08-12T15:00:00.000Z");
    const thursday = new Date("2026-08-13T15:00:00.000Z");
    const friday = new Date("2026-08-14T15:00:00.000Z");
    const sundayAfternoon = new Date("2026-08-16T21:00:00.000Z"); // Sun 2pm PT — inside the requested period

    const start = new Date("2026-08-16T19:00:00.000Z"); // Sun 2026-08-16 noon PT
    const end = new Date("2026-08-17T07:00:00.000Z"); // Mon 2026-08-17 00:00 PT (next workweek)

    const { dependencies, calls } = createDeps({
        hourlyRate: 10,
        entries: [
            { startTime: mondayMorning, durationHours: 4, laborCost: null, burdenCost: null },
            { startTime: tuesday, durationHours: 8, laborCost: null, burdenCost: null },
            { startTime: wednesday, durationHours: 8, laborCost: null, burdenCost: null },
            { startTime: thursday, durationHours: 8, laborCost: null, burdenCost: null },
            { startTime: friday, durationHours: 8, laborCost: null, burdenCost: null },
            { startTime: sundayAfternoon, durationHours: 6, laborCost: null, burdenCost: null },
        ],
    });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);

    const res = await GET(req(`?start=${start.toISOString()}&end=${end.toISOString()}`));
    assert.equal(res.status, 200);
    const body = await res.json();

    // Only the Sunday-afternoon entry is IN the requested period, and it must
    // be split 4 regular / 2 overtime (36h already worked that week + 6h = 42h).
    assert.equal(body.regularHours, 4);
    assert.equal(body.overtimeHours, 2);
    assert.equal(body.regularPay, 40); // 4 * 10
    assert.equal(body.overtimePay, 30); // 2 * 10 * 1.5

    // The queried range must reach back to the Monday 00:00 PT of that
    // workweek — proving the fix (exact workweek boundaries), not a lucky
    // fixed-padding coincidence.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rangeStart.toISOString(), "2026-08-10T07:00:00.000Z"); // Mon 2026-08-10 00:00 PT
    assert.equal(calls[0].rangeEnd.toISOString(), "2026-08-17T07:00:00.000Z"); // Mon 2026-08-17 00:00 PT
});

test("a stored historical rate prices an entry differently from the target user's current rate", async () => {
    const monday = new Date("2026-08-10T15:00:00.000-07:00"); // Mon 8am PT, 8h
    const { dependencies } = createDeps({
        hourlyRate: 25, // current rate — should NOT be used since a historical rate is stored
        entries: [{ startTime: monday, durationHours: 8, laborCost: 8 * 18, burdenCost: 8 * 3 }], // worked at $18/hr + $3/hr burden back then
    });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);

    const res = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-11T00:00:00-07:00"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.regularPay, 144); // 8 * 18, not 8 * 25
    assert.equal(body.burdenCost, 24); // 8 * 3
    assert.equal(body.ratesUsingCurrentRateFallback, 0);
});

test("a burden-only rate gap is still counted in ratesUsingCurrentRateFallback (not just a labor-rate gap)", async () => {
    // Stored laborCost is present (so pricing IS historically accurate for
    // pay) but burdenCost is missing — a data gap on burden alone. This must
    // still increment the fallback counter: the response's burdenCost for
    // this entry silently used the CURRENT burden rate, which is exactly the
    // kind of gap the counter exists to surface.
    const monday = new Date("2026-08-10T15:00:00.000-07:00"); // Mon 8am PT, 8h
    const { dependencies } = createDeps({
        hourlyRate: 25,
        burdenRate: 4, // current burden rate — used as the fallback for this entry
        entries: [{ startTime: monday, durationHours: 8, laborCost: 8 * 18, burdenCost: null }],
    });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);

    const res = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-11T00:00:00-07:00"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.regularPay, 144); // 8 * 18 — labor pricing unaffected
    assert.equal(body.burdenCost, 32); // 8 * 4 — fell back to the CURRENT burden rate
    assert.equal(body.ratesUsingCurrentRateFallback, 1); // burden-only gap still counts
});

test("an entry falling back on BOTH labor and burden counts once, not twice", async () => {
    const monday = new Date("2026-08-10T15:00:00.000-07:00");
    const tuesday = new Date("2026-08-11T15:00:00.000-07:00");
    const { dependencies } = createDeps({
        entries: [
            { startTime: monday, durationHours: 8, laborCost: null, burdenCost: null }, // both fall back
            { startTime: tuesday, durationHours: 8, laborCost: 8 * 20, burdenCost: 8 * 2 }, // neither falls back
        ],
    });
    const { GET } = createPayPeriodSummaryHandlers(dependencies);

    const res = await GET(req("?start=2026-08-10T00:00:00-07:00&end=2026-08-12T00:00:00-07:00"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ratesUsingCurrentRateFallback, 1); // Monday counts once, Tuesday not at all
});
