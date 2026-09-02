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

function loaded(blocking: BlockingEntry[] = []): LoadedGustoExport {
    return {
        employees: [],
        detail: [],
        blocking,
        periodStart: new Date("2026-08-17T07:00:00.000Z"),
        periodEnd: new Date("2026-08-31T07:00:00.000Z"),
        timeZone: "America/Los_Angeles",
        summaryCsv: SUMMARY,
        detailCsv: DETAIL,
        exportHash: "deadbeef",
        period: null,
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
