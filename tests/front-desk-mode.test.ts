/**
 * Front Desk v1 acceptance tests 4, 5, 6 and the §2.1/§2.2/§4 flag helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    frontDeskMode, frontDeskIsTest, frontDeskBookingEnabled, frontDeskMissLineEnabled, frontDeskTestInviteeDomains,
    pacificDateString, pacificTimeString, pacificSpoken, isWithinTransferHours, pacificParts,
} from "../src/lib/front-desk/constants";

const env = (overrides: Record<string, string> = {}) => ({ SPEED_TO_LEAD_MODE: "LIVE", ...overrides } as unknown as NodeJS.ProcessEnv);

test("unset, 'off' or garbage FRONT_DESK_MODE reads as OFF", () => {
    assert.equal(frontDeskMode(env()), "OFF");
    assert.equal(frontDeskMode(env({ FRONT_DESK_MODE: "off" })), "OFF");
    assert.equal(frontDeskMode(env({ FRONT_DESK_MODE: "garbage" })), "OFF");
});

test("TEST and LIVE are recognized case-insensitively", () => {
    assert.equal(frontDeskMode(env({ FRONT_DESK_MODE: "TEST" })), "TEST");
    assert.equal(frontDeskMode(env({ FRONT_DESK_MODE: "live" })), "LIVE");
});

test("SPEED_TO_LEAD_MODE=OFF forces the front desk OFF even when FRONT_DESK_MODE says LIVE", () => {
    const e = { SPEED_TO_LEAD_MODE: "OFF", FRONT_DESK_MODE: "LIVE" } as unknown as NodeJS.ProcessEnv;
    assert.equal(frontDeskMode(e), "OFF");
});

test("LIVE off production behaves as TEST (isTest=true)", () => {
    const preview = { SPEED_TO_LEAD_MODE: "LIVE", FRONT_DESK_MODE: "LIVE", VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv;
    assert.equal(frontDeskIsTest(preview), true);
    const prod = { SPEED_TO_LEAD_MODE: "LIVE", FRONT_DESK_MODE: "LIVE", VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    assert.equal(frontDeskIsTest(prod), false);
});

test("TEST mode is always isTest=true regardless of VERCEL_ENV", () => {
    assert.equal(frontDeskIsTest(env({ FRONT_DESK_MODE: "TEST", VERCEL_ENV: "production" })), true);
    assert.equal(frontDeskIsTest(env({ FRONT_DESK_MODE: "TEST" })), true);
});

test("frontDeskBookingEnabled requires exactly ON", () => {
    assert.equal(frontDeskBookingEnabled({ FRONT_DESK_BOOKING: "ON" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(frontDeskBookingEnabled({ FRONT_DESK_BOOKING: "on" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(frontDeskBookingEnabled({} as unknown as NodeJS.ProcessEnv), false);
    assert.equal(frontDeskBookingEnabled({ FRONT_DESK_BOOKING: "OFF" } as unknown as NodeJS.ProcessEnv), false);
});

test("frontDeskMissLineEnabled requires exactly ON, default OFF", () => {
    assert.equal(frontDeskMissLineEnabled({} as unknown as NodeJS.ProcessEnv), false);
    assert.equal(frontDeskMissLineEnabled({ FRONT_DESK_MISS_LINE: "ON" } as unknown as NodeJS.ProcessEnv), true);
});

test("frontDeskTestInviteeDomains parses a comma-separated, trimmed, lower-cased list", () => {
    const list = frontDeskTestInviteeDomains({ FRONT_DESK_TEST_INVITEE_DOMAINS: " GoldenTouchRemodeling.com , Example.com" } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual(list, ["goldentouchremodeling.com", "example.com"]);
});

// ── Pacific time (§2.2, test 18) — the spec's own two DST instants ──────

test("2026-10-30 09:00 PDT (16:00Z, before the Nov 1 fall-back) reads correctly", () => {
    const d = new Date("2026-10-30T16:00:00.000Z");
    assert.equal(pacificDateString(d), "2026-10-30");
    assert.equal(pacificTimeString(d), "09:00");
    assert.match(pacificSpoken(d), /9:00\s*AM Pacific$/);
});

test("2026-11-02 09:00 PST (17:00Z, after the Nov 1 fall-back) reads correctly", () => {
    const d = new Date("2026-11-02T17:00:00.000Z");
    assert.equal(pacificDateString(d), "2026-11-02");
    assert.equal(pacificTimeString(d), "09:00");
    assert.match(pacificSpoken(d), /9:00\s*AM Pacific$/);
});

test("pacificDateString/pacificTimeString are correct across the spring-forward DST boundary (2026-03-08)", () => {
    const beforeSpring = new Date("2026-03-08T09:00:00.000Z"); // still PST (UTC-8)
    assert.equal(pacificTimeString(beforeSpring), "01:00");
    const afterSpring = new Date("2026-03-08T16:00:00.000Z"); // now PDT (UTC-7)
    assert.equal(pacificTimeString(afterSpring), "09:00");
});

test("isWithinTransferHours: Friday 16:59 Pacific is in, 17:00 is out, Saturday is out", () => {
    // 2026-10-02 is a Friday. 16:59 Pacific (PDT, UTC-7) = 23:59Z.
    assert.equal(isWithinTransferHours(new Date("2026-10-02T23:59:00.000Z")), true);
    // Still Friday 17:00 Pacific (the UTC date has rolled to Oct 3, the Pacific date has not).
    assert.equal(isWithinTransferHours(new Date("2026-10-03T00:00:00.000Z")), false);
    // 2026-10-03 is a Saturday, mid-day Pacific.
    assert.equal(isWithinTransferHours(new Date("2026-10-03T20:00:00.000Z")), false);
});

test("isWithinTransferHours: 08:00 Monday Pacific is in, 07:59 is out", () => {
    // 2026-10-05 is a Monday.
    assert.equal(isWithinTransferHours(new Date("2026-10-05T15:00:00.000Z")), true); // 08:00 PDT
    assert.equal(isWithinTransferHours(new Date("2026-10-05T14:59:00.000Z")), false); // 07:59 PDT
});

test("pacificParts normalizes weekday to ISO (1=Mon..7=Sun)", () => {
    assert.equal(pacificParts(new Date("2026-10-05T20:00:00.000Z")).isoWeekday, 1); // Monday
    assert.equal(pacificParts(new Date("2026-10-04T20:00:00.000Z")).isoWeekday, 7); // Sunday
});
