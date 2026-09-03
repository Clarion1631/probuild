/**
 * GET /api/time-entries/export/gusto — auth and refusal matrix.
 *
 * This is the endpoint that hands out the whole company's payroll, and it
 * replaced a route that had NO role check at all. A source-string assertion
 * ("the file mentions financialReports") would not prove that a FIELD_CREW
 * actually receives a 403, so the handler is a DI factory and these are real
 * request/response tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createGustoExportHandler,
    type GustoExportDependencies,
    type GustoExportViewer,
} from "../src/app/api/time-entries/export/gusto/route";
import type { LoadedGustoExport } from "../src/lib/gusto-export-db";
import type { BlockingEntry } from "../src/lib/gusto-export-core";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-gusto-export-route-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const SUMMARY = '"Employee Name"\n"Alice Field"\n';
const DETAIL = '"Date"\n"2026-08-17"\n';

function loaded(blocking: BlockingEntry[] = [], snapshot: LoadedGustoExport["snapshot"] = null): LoadedGustoExport {
    return {
        employees: [],
        detail: [],
        blocking,
        periodStart: new Date("2026-08-17T07:00:00.000Z"),
        periodEnd: new Date("2026-08-31T07:00:00.000Z"),
        envelopeStart: new Date("2026-08-17T07:00:00.000Z"),
        envelopeEnd: new Date("2026-08-31T07:00:00.000Z"),
        timeZone: "America/Los_Angeles",
        summaryCsv: SUMMARY,
        detailCsv: DETAIL,
        exportHash: "deadbeef",
        snapshot,
        period: null,
        overlappingLocks: [],
        locked: false,
        overlapsLockWithoutBeingIt: false,
    };
}

function deps(overrides: {
    viewer?: GustoExportViewer | null;
    result?: LoadedGustoExport;
    onLoad?: () => void;
} = {}): GustoExportDependencies {
    return {
        authenticate: async () => (overrides.viewer === undefined ? { role: "ADMIN", canReadFinancialReports: false } : overrides.viewer),
        resolveTimeZone: async () => "America/Los_Angeles",
        load: async () => {
            overrides.onLoad?.();
            return overrides.result ?? loaded();
        },
    };
}

const url = (query = "periodStart=2026-08-17&periodEnd=2026-08-31") =>
    new Request(`https://example.test/api/time-entries/export/gusto?${query}`);

test("no session is 401 and never touches the data", async () => {
    let loads = 0;
    const res = await createGustoExportHandler(deps({ viewer: null, onLoad: () => { loads += 1; } })).GET(url());
    assert.equal(res.status, 401);
    assert.equal(loads, 0, "an unauthenticated request must not run the payroll query");
});

test("a FIELD_CREW session is 403 — payroll is not a crew screen", async () => {
    let loads = 0;
    const res = await createGustoExportHandler(
        deps({ viewer: { role: "FIELD_CREW", canReadFinancialReports: false }, onLoad: () => { loads += 1; } })
    ).GET(url());
    assert.equal(res.status, 403);
    assert.equal(loads, 0);
});

test("MANAGER without financialReports is also 403 — the gate is the permission, not seniority", async () => {
    const res = await createGustoExportHandler(
        deps({ viewer: { role: "MANAGER", canReadFinancialReports: false } })
    ).GET(url());
    assert.equal(res.status, 403);
});

test("ADMIN gets the summary CSV; financialReports gets it without being ADMIN", async () => {
    for (const viewer of [
        { role: "ADMIN", canReadFinancialReports: false },
        { role: "FINANCE", canReadFinancialReports: true },
    ] satisfies GustoExportViewer[]) {
        const res = await createGustoExportHandler(deps({ viewer })).GET(url());
        assert.equal(res.status, 200, viewer.role);
        assert.equal(await res.text(), SUMMARY);
        assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
        assert.match(res.headers.get("content-disposition") ?? "", /gusto-summary-2026-08-17_to_2026-08-30\.csv/);
        assert.equal(res.headers.get("x-export-hash"), "deadbeef");
    }
});

test("format=detail returns the detail CSV", async () => {
    const res = await createGustoExportHandler(deps()).GET(
        url("periodStart=2026-08-17&periodEnd=2026-08-31&format=detail")
    );
    assert.equal(await res.text(), DETAIL);
    assert.match(res.headers.get("content-disposition") ?? "", /gusto-detail-/);
});

test("a not-ready period is 409 and lists what is blocking it", async () => {
    const blocking: BlockingEntry[] = [
        { id: "te1", userId: "u1", userLabel: "Alice Field", startTime: new Date("2026-08-20T15:00:00.000Z"), reason: "deferred" },
    ];
    const res = await createGustoExportHandler(deps({ result: loaded(blocking) })).GET(url());
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "PERIOD_NOT_READY");
    assert.deepEqual(body.blocking.map((row: { reason: string }) => row.reason), ["deferred"]);
});

test("bad or over-long ranges are refused before any query runs", async () => {
    for (const query of [
        "periodStart=2026-08-17",
        "periodStart=nonsense&periodEnd=2026-08-31",
        "periodStart=2026-08-31&periodEnd=2026-08-17",
        "periodStart=2026-08-17&periodEnd=2026-08-17",
        // 63 days — one past MAX_PAY_PERIOD_RANGE_DAYS.
        "periodStart=2026-01-01&periodEnd=2026-03-05",
    ]) {
        let loads = 0;
        const res = await createGustoExportHandler(deps({ onLoad: () => { loads += 1; } })).GET(url(query));
        assert.equal(res.status, 400, query);
        assert.equal(loads, 0, query);
    }
});

test("a LOCKED period serves its frozen snapshot, verbatim, and skips readiness", async () => {
    // The whole point of the snapshot: the CSVs are built from mutable inputs
    // (name, email, payType, Gusto id mapping, a punch's project/cost code), so
    // recomputing a locked period could differ from the file payroll received.
    const snapshot = { summaryCsv: "FROZEN-SUMMARY\n", detailCsv: "FROZEN-DETAIL\n", exportHash: "frozenhash" };
    // Deliberately also blocking: a locked period must not be re-gated on
    // readiness — it was already exported.
    const blocking: BlockingEntry[] = [
        { id: "te1", userId: "u1", userLabel: "Alice", startTime: new Date("2026-08-20T15:00:00.000Z"), reason: "open" },
    ];
    const handler = createGustoExportHandler(deps({ result: loaded(blocking, snapshot) }));

    const summary = await handler.GET(url());
    assert.equal(summary.status, 200);
    assert.equal(await summary.text(), snapshot.summaryCsv);
    assert.equal(summary.headers.get("x-export-hash"), "frozenhash");
    assert.equal(summary.headers.get("x-export-source"), "snapshot");

    const detail = await handler.GET(url("periodStart=2026-08-17&periodEnd=2026-08-31&format=detail"));
    assert.equal(await detail.text(), snapshot.detailCsv);
});

test("an UNLOCKED period is computed live and still enforces readiness", async () => {
    const blocking: BlockingEntry[] = [
        { id: "te1", userId: "u1", userLabel: "Alice", startTime: new Date("2026-08-20T15:00:00.000Z"), reason: "open" },
    ];
    const res = await createGustoExportHandler(deps({ result: loaded(blocking) })).GET(url());
    assert.equal(res.status, 409);
});

test("an impossible calendar date is a 400, not a silently rolled-forward period", async () => {
    // Date("2026-02-31") rolls to 2026-03-03, which would have exported a period
    // nobody asked for. validatePayrollRange checks the day is real.
    let loads = 0;
    const res = await createGustoExportHandler(deps({ onLoad: () => { loads += 1; } })).GET(
        url("periodStart=2026-02-31&periodEnd=2026-03-31")
    );
    assert.equal(res.status, 400);
    assert.equal(loads, 0);
});

test("a lock is found by its STABLE day keys, not by reconstructed timestamps", async () => {
    // The regression: timestamps are derived from company-local days, so they
    // move when CompanySettings.timeZone changes. An exact timestamp lookup
    // then missed the period's own locked row — the download silently served
    // LIVE csv instead of the frozen snapshot, and unlock updated zero rows
    // while still reporting success.
    const snapshot = { summaryCsv: "FROZEN\n", detailCsv: "FROZEN-D\n", exportHash: "frozen" };
    const seen: Array<{ start: Date; keys: { startKey: string; endKey: string; timeZone: string } }> = [];
    const handler = createGustoExportHandler({
        authenticate: async () => ({ role: "ADMIN", canReadFinancialReports: true }),
        // The company zone has CHANGED since the lock was taken.
        resolveTimeZone: async () => "America/New_York",
        load: async (periodStart, _periodEnd, keys) => {
            seen.push({ start: periodStart, keys });
            return loaded([], snapshot);
        },
    });

    const res = await handler.GET(url());
    assert.equal(res.status, 200);
    assert.equal(await res.text(), snapshot.summaryCsv, "the frozen file must still be served");
    assert.equal(res.headers.get("x-export-source"), "snapshot");

    // The day keys handed to the loader are the ones from the REQUEST, verbatim
    // — they do not pass through the (now different) time zone.
    assert.deepEqual(seen[0].keys, {
        startKey: "2026-08-17",
        endKey: "2026-08-31",
        // And the zone the timestamp below was derived from, handed through so
        // the loader classifies days in the SAME zone (round-6 finding 2).
        timeZone: "America/New_York",
    });
    // The timestamp, by contrast, IS zone-derived — which is exactly why it
    // cannot be the lock's identity.
    assert.equal(seen[0].start.toISOString(), "2026-08-17T04:00:00.000Z");
});

test("the loader is always given the request's day keys, on the live path too", async () => {
    const seen: Array<{ startKey: string; endKey: string; timeZone: string }> = [];
    const handler = createGustoExportHandler({
        authenticate: async () => ({ role: "ADMIN", canReadFinancialReports: true }),
        resolveTimeZone: async () => "America/Los_Angeles",
        load: async (_s, _e, keys) => {
            seen.push(keys);
            return loaded();
        },
    });
    await handler.GET(url());
    assert.deepEqual(seen, [
        { startKey: "2026-08-17", endKey: "2026-08-31", timeZone: "America/Los_Angeles" },
    ]);
});

// ── ONE zone resolution drives the whole request (round 6, finding 2) ────────
//
// The handler resolves the company zone, builds the half-open period boundaries
// from it, and then hands those boundaries to the loader. It used to hand over
// the boundaries WITHOUT the zone, so the loader resolved the zone a second
// time — a second read, on a different connection, at a different instant. A
// zone change landing in between produced a CSV whose query window was built in
// zone A and whose days, workweeks and overtime were classified in zone B: a
// file that never described any single configuration of the company.

test("the zone the boundaries were built from is the zone the loader is given", async () => {
    // The zone is resolved exactly ONCE per request, and that same value reaches
    // the loader — so the boundaries and the classification cannot disagree even
    // if somebody changes the company zone a millisecond later.
    let resolves = 0;
    const seen: Array<{ start: Date; end: Date; timeZone: string }> = [];
    const handler = createGustoExportHandler({
        authenticate: async () => ({ role: "ADMIN", canReadFinancialReports: true }),
        resolveTimeZone: async () => {
            resolves += 1;
            // A zone that MOVES on every call. Under the old code the loader's
            // own second resolution would have differed from this one; here
            // there is only one resolution, so the value cannot drift.
            return resolves === 1 ? "America/Los_Angeles" : "Pacific/Honolulu";
        },
        load: async (periodStart, periodEnd, keys) => {
            seen.push({ start: periodStart, end: periodEnd, timeZone: keys.timeZone });
            return loaded();
        },
    });

    const res = await handler.GET(url());
    assert.equal(res.status, 200);
    assert.equal(resolves, 1, "the handler must resolve the company zone exactly once");
    assert.equal(seen.length, 1);
    assert.equal(
        seen[0].timeZone,
        "America/Los_Angeles",
        "the loader gets the FIRST zone — the one the boundaries below were derived from"
    );
    // And the boundaries really were derived from that same zone: 2026-08-17
    // 00:00 in Los Angeles is 07:00Z. In Honolulu it would be 10:00Z, so this
    // assertion distinguishes the two.
    assert.equal(seen[0].start.toISOString(), "2026-08-17T07:00:00.000Z");
    assert.equal(seen[0].end.toISOString(), "2026-08-31T07:00:00.000Z");
});

// ── A locked period with an incomplete snapshot fails CLOSED (finding 4) ─────

test("a locked period whose frozen CSVs are missing is a 409, never live data", async () => {
    // The loader throws LockedSnapshotMissingError rather than returning a flag
    // a caller could forget to read. What this pins is that the endpoint turns
    // it into a refusal instead of falling through to the live CSV below it —
    // which is exactly what it used to do, complete with X-Export-Source: live.
    const { LockedSnapshotMissingError } = await import("../src/lib/gusto-export-db");
    const handler = createGustoExportHandler({
        authenticate: async () => ({ role: "ADMIN", canReadFinancialReports: true }),
        resolveTimeZone: async () => "America/Los_Angeles",
        load: async () => {
            throw new LockedSnapshotMissingError("2026-08-17", "2026-08-31");
        },
    });

    const res = await handler.GET(url());
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("x-export-source"), null, "no CSV of any kind comes back");
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "LOCKED_SNAPSHOT_MISSING");
    assert.match(body.error, /2026-08-17 to 2026-08-31/);
    assert.match(body.error, /unlock the period and lock it again/, "the refusal says how to recover");
});

test("an unrelated loader failure is NOT swallowed into that 409", async () => {
    // The catch is narrow on purpose: a database outage must not be reported to
    // a bookkeeper as "this period's snapshot is missing, go and re-lock it".
    const handler = createGustoExportHandler({
        authenticate: async () => ({ role: "ADMIN", canReadFinancialReports: true }),
        resolveTimeZone: async () => "America/Los_Angeles",
        load: async () => {
            throw new Error("connection terminated");
        },
    });
    await assert.rejects(() => handler.GET(url()), /connection terminated/);
});

test("a range that OVERLAPS a locked period without being it is a 409", async () => {
    // Such a range has no snapshot, so any CSV built for it would disagree with
    // what was already paid for the overlapping days. There is no right answer
    // to return — the caller has to ask for the locked period itself.
    const result = {
        ...loaded(),
        overlapsLockWithoutBeingIt: true,
        overlappingLocks: [
            {
                id: "pp1",
                periodStart: new Date("2026-08-17T07:00:00.000Z"),
                periodEnd: new Date("2026-08-31T07:00:00.000Z"),
                periodStartKey: "2026-08-17",
                periodEndKey: "2026-08-31",
                lockedAt: new Date(),
                lockedById: "u1",
                exportHash: "h",
                timeZone: "America/Los_Angeles",
                summaryCsvSnapshot: null,
                detailCsvSnapshot: null,
                lockedBy: null,
            },
        ],
    } as unknown as LoadedGustoExport;

    const res = await createGustoExportHandler(deps({ result })).GET(url());
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "OVERLAPS_LOCKED_PERIOD");
    assert.deepEqual(body.lockedPeriods, [{ periodStart: "2026-08-17", periodEnd: "2026-08-31" }]);
});
