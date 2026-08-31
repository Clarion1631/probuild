/**
 * company-wall-time (src/lib/company-wall-time.ts): Pacific wall time ↔ UTC instant for
 * datetime-local payroll inputs. Pinned per Codex gate on PR #437: nonexistent
 * spring-forward times are rejected (not silently shifted), ambiguous fall-back times
 * resolve to the earlier instant, and both directions round-trip exactly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { companyWallToInstant, instantToCompanyWall } from "../src/lib/company-wall-time";
import { toCompanyDayKey } from "../src/lib/company-day";

test("ordinary times round-trip exactly, both DST regimes", () => {
    for (const [wall, iso] of [
        ["2026-08-30T12:00", "2026-08-30T19:00:00.000Z"], // PDT (UTC-7)
        ["2026-12-31T12:00", "2026-12-31T20:00:00.000Z"], // PST (UTC-8)
        ["2026-08-30T00:00", "2026-08-30T07:00:00.000Z"], // midnight edge
        ["2026-02-28T23:59", "2026-03-01T07:59:00.000Z"], // month boundary
    ] as const) {
        const instant = companyWallToInstant(wall);
        assert.ok(instant, wall);
        assert.equal(instant!.toISOString(), iso, wall);
        assert.equal(instantToCompanyWall(instant!), wall, `${wall} round-trips`);
    }
});

test("the spring-forward gap is rejected, its edges are not", () => {
    // 2026-03-08: 02:00 PST jumps to 03:00 PDT — 02:00–02:59 never exists.
    assert.equal(companyWallToInstant("2026-03-08T02:00"), null);
    assert.equal(companyWallToInstant("2026-03-08T02:30"), null);
    assert.equal(companyWallToInstant("2026-03-08T02:59"), null);
    assert.equal(companyWallToInstant("2026-03-08T01:59")!.toISOString(), "2026-03-08T09:59:00.000Z"); // PST
    assert.equal(companyWallToInstant("2026-03-08T03:00")!.toISOString(), "2026-03-08T10:00:00.000Z"); // PDT
});

test("the fall-back hour resolves to the EARLIER instant, deterministically", () => {
    // 2026-11-01: 01:30 happens twice — 08:30Z (PDT) and 09:30Z (PST). We pick PDT.
    const ambiguous = companyWallToInstant("2026-11-01T01:30");
    assert.equal(ambiguous!.toISOString(), "2026-11-01T08:30:00.000Z");
    // Unambiguous neighbors on the same day.
    assert.equal(companyWallToInstant("2026-11-01T00:30")!.toISOString(), "2026-11-01T07:30:00.000Z");
    assert.equal(companyWallToInstant("2026-11-01T02:30")!.toISOString(), "2026-11-01T10:30:00.000Z");
    // Whatever the resolution, it stays on the right company day.
    assert.equal(toCompanyDayKey(ambiguous!), "2026-11-01");
});

test("junk is rejected, seconds are truncated in display only", () => {
    for (const bad of ["", "yesterday", "2026-13-01T10:00", "2026-08-30T24:00", "2026-08-30T10:60", "2026-08-30 10:00"]) {
        assert.equal(companyWallToInstant(bad), null, JSON.stringify(bad));
    }
    // Display drops seconds (datetime-local has minute granularity)…
    assert.equal(instantToCompanyWall("2026-08-30T19:00:42.123Z"), "2026-08-30T12:00");
    // …which is why callers must resend the ORIGINAL instant when a field is unchanged.
});
