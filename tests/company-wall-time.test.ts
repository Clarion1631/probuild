/**
 * company-wall-time (src/lib/company-wall-time.ts): Pacific wall time ↔ UTC instant for
 * datetime-local payroll inputs. Pinned per Codex gate on PR #437: nonexistent
 * spring-forward times are rejected (not silently shifted), ambiguous fall-back times
 * resolve to the earlier instant, and both directions round-trip exactly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { companyDayRange, companyWallToInstant, companyWallToInstants, instantToCompanyWall, occurrenceOf, pickInstant } from "../src/lib/company-wall-time";

test("pickInstant/occurrenceOf: an ambiguous fall-back time is only resolved by an explicit choice — and either occurrence is reachable", () => {
    // Unambiguous: pick is ignored.
    assert.equal(pickInstant("2026-08-30T12:00", "")!.toISOString(), "2026-08-30T19:00:00.000Z");
    assert.equal(pickInstant("2026-08-30T12:00", "second")!.toISOString(), "2026-08-30T19:00:00.000Z");
    // Ambiguous without a pick → null (the UI must ask, never guess).
    assert.equal(pickInstant("2026-11-01T01:30", ""), null);
    assert.equal(pickInstant("2026-11-01T01:30", "first")!.toISOString(), "2026-11-01T08:30:00.000Z");
    assert.equal(pickInstant("2026-11-01T01:30", "second")!.toISOString(), "2026-11-01T09:30:00.000Z");
    // The gap stays unreachable regardless of pick.
    assert.equal(pickInstant("2026-03-08T02:30", "first"), null);
    // Regression (PR #437 round 5): a punch stored in the WRONG occurrence can be
    // corrected without changing the wall-time string — seed the picker from the
    // stored instant, then flip it.
    const wrong = new Date("2026-11-01T08:30:00.000Z"); // stored as the PDT occurrence
    const wall = instantToCompanyWall(wrong);
    assert.equal(wall, "2026-11-01T01:30");
    assert.equal(occurrenceOf(wall, wrong), "first");
    const corrected = pickInstant(wall, "second")!;
    assert.equal(corrected.toISOString(), "2026-11-01T09:30:00.000Z");
    assert.equal(occurrenceOf(wall, corrected), "second");
    // occurrenceOf is "" when nothing is ambiguous.
    assert.equal(occurrenceOf("2026-08-30T12:00", new Date("2026-08-30T19:00:00.000Z")), "");
});
import { toCompanyDayKey } from "../src/lib/company-day";

test("companyWallToInstants: one instant normally, two in the fall-back hour (earliest first), zero in the gap", () => {
    assert.deepEqual(companyWallToInstants("2026-08-30T12:00").map((d) => d.toISOString()), ["2026-08-30T19:00:00.000Z"]);
    assert.deepEqual(
        companyWallToInstants("2026-11-01T01:30").map((d) => d.toISOString()),
        ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"] // PDT occurrence, then PST
    );
    assert.deepEqual(companyWallToInstants("2026-03-08T02:30"), []);
});

test("companyDayRange: Pacific calendar-day boundaries, half-open, DST-correct", () => {
    const r = companyDayRange("2026-08-30", "2026-08-30");
    assert.equal(r.gte!.toISOString(), "2026-08-30T07:00:00.000Z");
    assert.equal(r.lt!.toISOString(), "2026-08-31T07:00:00.000Z");
    // The regression that forced this: a 7pm Pacific punch (02:00Z next day) must be
    // INSIDE its displayed date's range — the old UTC boundaries excluded it.
    const evening = new Date("2026-08-31T02:00:00.000Z"); // 2026-08-30 19:00 Pacific
    assert.equal(toCompanyDayKey(evening), "2026-08-30");
    assert.ok(evening >= r.gte! && evening < r.lt!);
    // And an early-UTC row from the PREVIOUS Pacific day stays out.
    const prior = new Date("2026-08-30T05:00:00.000Z"); // 2026-08-29 22:00 Pacific
    assert.equal(prior >= r.gte!, false);
    // Fall-back day is 25h long; spring-forward day 23h; year boundary uses PST.
    const fb = companyDayRange("2026-11-01", "2026-11-01");
    assert.equal(fb.lt!.getTime() - fb.gte!.getTime(), 25 * 3_600_000);
    const sf = companyDayRange("2026-03-08", "2026-03-08");
    assert.equal(sf.lt!.getTime() - sf.gte!.getTime(), 23 * 3_600_000);
    const ny = companyDayRange("2026-12-31", "2026-12-31");
    assert.equal(ny.gte!.toISOString(), "2026-12-31T08:00:00.000Z");
    assert.equal(ny.lt!.toISOString(), "2027-01-01T08:00:00.000Z");
    // Open-ended and junk inputs.
    assert.deepEqual(companyDayRange(undefined, undefined), {});
    assert.equal(companyDayRange("2026-08-30", null).lt, undefined);
    assert.deepEqual(companyDayRange("junk", "also junk"), {});
});

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
