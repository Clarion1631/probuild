import test from "node:test";
import assert from "node:assert/strict";
import { parseFallbackEmail, decodeHtmlEntities } from "../src/lib/speed-to-lead/fallback-email";

test("decodeHtmlEntities handles named, decimal and hex entities", () => {
    assert.equal(decodeHtmlEntities("Kitchen &amp; bath"), "Kitchen & bath");
    assert.equal(decodeHtmlEntities("It&#39;s great"), "It's great");
    assert.equal(decodeHtmlEntities("caf&#x65;"), "cafe");
});

test("a well-formed site-shaped body promotes with every field filled", () => {
    const body = [
        "Name: Jane Doe",
        "Email: jane@example.com",
        "Phone: (360) 555-0100",
        "Project city: Vancouver, WA",
        "Project scope: Kitchen remodel",
        "Message:",
        "We&#39;d like a full kitchen remodel, please reach out soon.",
    ].join("\n");
    const result = parseFallbackEmail({ headers: [{ name: "Reply-To", value: "jane@example.com" }], bodyText: body, submissionId: "sub-1" });
    assert.equal(result.parsed, true);
    assert.equal(result.name, "Jane Doe");
    assert.equal(result.email, "jane@example.com");
    assert.equal(result.phone, "(360) 555-0100");
    assert.equal(result.city, "Vancouver, WA");
    assert.equal(result.scope, "Kitchen remodel");
    assert.equal(result.message, "We'd like a full kitchen remodel, please reach out soon.");
    assert.equal(result.submissionId, "sub-1");
});

test("email always comes from Reply-To, never a body label, when both are present and differ", () => {
    const body = "Name: Jane Doe\nEmail: fake@example.com\nMessage:\nHello there, thanks.";
    const result = parseFallbackEmail({ headers: [{ name: "Reply-To", value: "real@example.com" }], bodyText: body, submissionId: null });
    assert.equal(result.email, "real@example.com");
});

test("a malformed body still stores the raw text and reports parsed: false", () => {
    const result = parseFallbackEmail({ headers: [], bodyText: "some unstructured forwarded text with no labels", submissionId: null });
    assert.equal(result.parsed, false);
    assert.equal(result.name, null);
    assert.equal(result.email, null);
    assert.ok(result.message.length > 0);
});

test("a fallback with no submissionId is recorded as such (due immediately, per intake.ts)", () => {
    const result = parseFallbackEmail({ headers: [], bodyText: "Name: X\nEmail: x@example.com\nMessage:\nplease help me remodel this whole house", submissionId: null });
    assert.equal(result.submissionId, null);
});
