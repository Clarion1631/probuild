import test from "node:test";
import assert from "node:assert/strict";
import { webIntakePayloadSchema } from "../src/lib/speed-to-lead/payload";

const VALID = {
    submissionId: "sub-1",
    name: "Jane Doe",
    email: "jane@example.com",
    message: "We would like a full kitchen remodel, please reach out soon.",
    renderedAtMs: 0,
    submittedAtMs: 5000,
};

test("a minimal valid payload parses, with defaults applied", () => {
    const result = webIntakePayloadSchema.safeParse(VALID);
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.honeypot, "");
        assert.equal(result.data.smsConsent, false);
        assert.deepEqual(result.data.attribution, {});
    }
});

test("an invalid email is rejected", () => {
    const result = webIntakePayloadSchema.safeParse({ ...VALID, email: "not-an-email" });
    assert.equal(result.success, false);
});

test("a missing submissionId is rejected", () => {
    const { submissionId, ...rest } = VALID;
    void submissionId;
    const result = webIntakePayloadSchema.safeParse(rest);
    assert.equal(result.success, false);
});

test("smsConsent and attribution are accepted as evidence-only fields", () => {
    const result = webIntakePayloadSchema.safeParse({ ...VALID, smsConsent: true, attribution: { utm_source: "google" } });
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.smsConsent, true);
        assert.equal(result.data.attribution.utm_source, "google");
    }
});

test("an oversized message is rejected", () => {
    const result = webIntakePayloadSchema.safeParse({ ...VALID, message: "a".repeat(10_001) });
    assert.equal(result.success, false);
});

test("phone/projectType/location are optional and accept null", () => {
    const result = webIntakePayloadSchema.safeParse({ ...VALID, phone: null, projectType: null, location: null });
    assert.equal(result.success, true);
});
