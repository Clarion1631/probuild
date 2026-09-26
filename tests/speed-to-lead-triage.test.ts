import test from "node:test";
import assert from "node:assert/strict";
import { pureTriageChecks, isServiceAreaOrUnset, clearsMinRenderDelay } from "../src/lib/speed-to-lead/triage";
import type { WebIntakePayload } from "../src/lib/speed-to-lead/payload";

function basePayload(overrides: Partial<WebIntakePayload> = {}): WebIntakePayload {
    return {
        submissionId: "sub-1",
        name: "Jane Doe",
        email: "jane@example.com",
        phone: "3605551234",
        message: "We would like a full kitchen remodel please, thank you.",
        projectType: "Kitchen",
        location: "Vancouver, WA",
        honeypot: "",
        renderedAtMs: 0,
        submittedAtMs: 10_000,
        smsConsent: false,
        attribution: {},
        ...overrides,
    };
}

test("a clean payload passes every pure check", () => {
    assert.deepEqual(pureTriageChecks(basePayload()), []);
});

test("a filled honeypot fails", () => {
    assert.deepEqual(pureTriageChecks(basePayload({ honeypot: "bot-filled-this" })), ["honeypot-filled"]);
});

test("submitting under 3 seconds after render fails", () => {
    const reasons = pureTriageChecks(basePayload({ renderedAtMs: 0, submittedAtMs: 2000 }));
    assert.ok(reasons.includes("submitted-too-fast"));
});

test("exactly 3 seconds clears the minimum", () => {
    assert.equal(clearsMinRenderDelay(0, 3000), true);
    assert.equal(clearsMinRenderDelay(0, 2999), false);
});

test("a message containing a link fails", () => {
    const reasons = pureTriageChecks(basePayload({ message: "check out https://spam.example.com for a deal" }));
    assert.ok(reasons.includes("contains-link"));
});

test("a message containing a bare domain-like link fails", () => {
    const reasons = pureTriageChecks(basePayload({ message: "visit totally-spam-site.com right now for a full remodel" }));
    assert.ok(reasons.includes("contains-link"));
});

test("a message containing a pitch word fails", () => {
    const reasons = pureTriageChecks(basePayload({ message: "guaranteed roi on your investment opportunity today" }));
    assert.ok(reasons.includes("contains-pitch-word"));
});

test("a description under 10 letters fails", () => {
    const reasons = pureTriageChecks(basePayload({ message: "hi. 123" }));
    assert.ok(reasons.includes("description-too-short"));
});

test("a description of exactly 10 letters passes that check", () => {
    const reasons = pureTriageChecks(basePayload({ message: "abcdefghij" }));
    assert.ok(!reasons.includes("description-too-short"));
});

test("no location given passes the service-area check", () => {
    assert.equal(isServiceAreaOrUnset(null), true);
    assert.equal(isServiceAreaOrUnset(""), true);
    assert.equal(isServiceAreaOrUnset("   "), true);
});

test("a known service-area city passes", () => {
    assert.equal(isServiceAreaOrUnset("Vancouver, WA"), true);
});

test("a known service-area zip passes", () => {
    assert.equal(isServiceAreaOrUnset("98682"), true);
});

test("an out-of-area location with no recognizable zip fails", () => {
    assert.equal(isServiceAreaOrUnset("Miami, FL"), false);
});

test("service-area cities can be overridden via env without touching the default list", () => {
    const env = { SPEED_TO_LEAD_SERVICE_AREA_CITIES: "Miami" } as unknown as NodeJS.ProcessEnv;
    assert.equal(isServiceAreaOrUnset("Miami, FL", env), true);
    assert.equal(isServiceAreaOrUnset("Vancouver, WA", env), false);
});

test("multiple failures accumulate rather than short-circuiting", () => {
    const reasons = pureTriageChecks(basePayload({ honeypot: "x", message: "hi", location: "Miami" }));
    assert.ok(reasons.includes("honeypot-filled"));
    assert.ok(reasons.includes("description-too-short"));
    assert.ok(reasons.includes("outside-service-area"));
});
