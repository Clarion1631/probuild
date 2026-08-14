import { test } from "node:test";
import assert from "node:assert/strict";
import { requiresPhaseForClockIn, checkLogisticsClockOutNotes } from "../src/lib/logistics-time-entry";

// ── requiresPhaseForClockIn ────────────────────────────────────────────────

test("normal project with no cost code or estimate item requires a phase", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: false, hasEstimateItem: false }),
        true
    );
});

test("normal project with a cost code does not require a phase", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: true, hasEstimateItem: false }),
        false
    );
});

test("normal project with an estimate item does not require a phase", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: false, hasEstimateItem: true }),
        false
    );
});

test("logistics project never requires a phase, even with neither set", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: true, hasCostCode: false, hasEstimateItem: false }),
        false
    );
});

// ── checkLogisticsClockOutNotes ────────────────────────────────────────────

test("not setting endTime -> always ok regardless of logistics/notes", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: false,
        existingNotes: null,
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, true);
});

test("non-logistics project clock-out -> ok even with no notes", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: false,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, true);
});

test("logistics clock-out with no existing notes and none supplied -> rejected", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, false);
});

test("logistics clock-out with only whitespace notes -> rejected", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: "   ",
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, false);
});

test("logistics clock-out with existing notes already on the entry -> ok, notes untouched", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: "Drove to shop, loaded materials",
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, true);
    assert.equal(result.notes, undefined);
});

test("logistics clock-out with notes supplied in this request -> ok, notes trimmed for persistence", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: "  Picked up lumber from the yard  ",
    });
    assert.equal(result.ok, true);
    assert.equal(result.notes, "Picked up lumber from the yard");
});

test("logistics clock-out with only whitespace supplied notes -> rejected", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: "   ",
    });
    assert.equal(result.ok, false);
});
