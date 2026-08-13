/**
 * Zip-override guard for job-site address normalization.
 *
 * The defect: geocodeJobSiteAddress stored Google's formatted_address whenever the
 * geocode succeeded. Google silently rewrites a zip it disagrees with (and does NOT
 * flag it as partial_match), so a hand-corrected zip reverted on every save — the
 * EST-00508 "zip won't stick" bug. The guard: when the user's input carries a zip
 * in address-tail position and Google's result carries a different one (or none),
 * the user's string is kept; lat/lng still apply since the street resolved.
 *
 * extractZip uses positive recognition — a 5-digit group directly after a
 * two-letter token or comma — so unit numbers, PO boxes, labelled numbers, and
 * 5-digit house numbers never read as zips. Google's zip comes from
 * address_components, with string parsing only as fallback.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { extractZip, geocodeJobSiteAddress } from "../src/lib/geocode";

// --- extractZip ------------------------------------------------------------

test("extracts trailing zip from a full address", () => {
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98665"), "98665");
});

test("extracts zip when followed by a country suffix", () => {
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98665, USA"), "98665");
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98665 United States"), "98665");
});

test("zip+4 keeps the first five digits", () => {
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98665-1234"), "98665");
});

test("returns null when no zip present", () => {
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA"), null);
});

test("a 5-digit street number is not a zip", () => {
    assert.equal(extractZip("12345 NE 72nd St, Vancouver, WA"), null);
    assert.equal(extractZip("12345"), null);
});

test("labelled numbers are not zips", () => {
    assert.equal(extractZip("PO Box 98665"), null);
    assert.equal(extractZip("Site: 12345"), null);
    assert.equal(extractZip("Lot 98665"), null);
    assert.equal(extractZip("# 98665"), null);
});

test("a trailing unit does not hide or replace the zip", () => {
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98661, Unit 205"), "98661");
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98661, Unit 20500"), "98661");
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA, Suite 20500"), null);
});

test("trailing punctuation and tight commas still yield the zip", () => {
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98661."), "98661");
    assert.equal(extractZip("1609 NE 72nd St, Vancouver, WA 98661,"), "98661");
    assert.equal(extractZip("1609 NE 72nd St, Vancouver,98661"), "98661");
});

test("unit number before the tail zip does not shadow it", () => {
    assert.equal(extractZip("Unit 20500, 1609 NE 72nd St, Vancouver, WA 98661"), "98661");
});

// --- geocodeJobSiteAddress guard (mocked Google) ---------------------------

const realFetch = global.fetch;
const realKey = process.env.GOOGLE_MAPS_SERVER_API_KEY;

function mockGoogle(result: any, status = "OK") {
    global.fetch = (async () => ({
        ok: true,
        json: async () => ({ status, results: result ? [result] : [] }),
    })) as any;
}

function googleResult(overrides: any = {}) {
    return {
        formatted_address: "1609 NE 72nd St, Vancouver, WA 98665, USA",
        partial_match: false,
        address_components: [
            { types: ["postal_code"], short_name: "98665", long_name: "98665" },
        ],
        geometry: { location_type: "ROOFTOP", location: { lat: 45.68, lng: -122.66 } },
        ...overrides,
    };
}

beforeEach(() => {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = "test-key";
});

afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    else process.env.GOOGLE_MAPS_SERVER_API_KEY = realKey;
});

test("user zip differing from Google's keeps the user's text, with coordinates", async () => {
    mockGoogle(googleResult());
    const geo = await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA 98661");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, WA 98661");
    assert.equal(geo?.lat, 45.68);
    assert.equal(geo?.lng, -122.66);
});

test("matching zip uses Google's formatting", async () => {
    mockGoogle(googleResult());
    const geo = await geocodeJobSiteAddress("1609 ne 72nd st vancouver wa 98665");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, WA 98665, USA");
});

test("zip+4 input matching Google's five digits uses Google's formatting", async () => {
    mockGoogle(googleResult());
    const geo = await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA 98665-1234");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, WA 98665, USA");
});

test("input without a zip uses Google's formatting", async () => {
    mockGoogle(googleResult());
    const geo = await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, WA 98665, USA");
});

test("Google result that dropped the zip keeps the user's text", async () => {
    mockGoogle(googleResult({
        formatted_address: "1609 NE 72nd St, Vancouver, WA, USA",
        address_components: [],
    }));
    const geo = await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA 98661");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, WA 98661");
});

test("mismatch guard still fires with a trailing unit after the zip", async () => {
    mockGoogle(googleResult());
    const geo = await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA 98661, Unit 205");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, WA 98661, Unit 205");
});

test("Google's zip is read from address_components, not the formatted string", async () => {
    // Formatted string carries no parseable zip; only the component does. A
    // fallback-only implementation would see a dropped zip and keep the raw
    // text — the component match must win and return Google's formatting.
    mockGoogle(googleResult({ formatted_address: "1609 NE 72nd St, Vancouver, USA" }));
    const geo = await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA 98665");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, USA");
});

test("empty short_name falls back to long_name", async () => {
    mockGoogle(googleResult({
        formatted_address: "1609 NE 72nd St, Vancouver, USA",
        address_components: [{ types: ["postal_code"], short_name: "", long_name: "98665" }],
    }));
    const geo = await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA 98665");
    assert.equal(geo?.formattedAddress, "1609 NE 72nd St, Vancouver, USA");
});

test("partial matches still return null", async () => {
    mockGoogle(googleResult({ partial_match: true }));
    assert.equal(await geocodeJobSiteAddress("1609 NE 72nd St, Vancouver, WA 98661"), null);
});
