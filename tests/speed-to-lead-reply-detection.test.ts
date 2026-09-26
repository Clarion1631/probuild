import test from "node:test";
import assert from "node:assert/strict";
import { classifyInboundMessage, stripQuotedText, containsOptOutPhrase, isAutoSubmitted, isBounce } from "../src/lib/speed-to-lead/reply-detection";

test("an Auto-Submitted header other than 'no' classifies as auto-reply", () => {
    const result = classifyInboundMessage({
        fromAddress: "client@example.com",
        headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
        bodyText: "I am out of office, stop bothering me",
    });
    assert.equal(result, "auto-reply");
});

test("Auto-Submitted: no is NOT auto-submitted", () => {
    assert.equal(isAutoSubmitted([{ name: "Auto-Submitted", value: "no" }]), false);
    assert.equal(isAutoSubmitted([]), false);
});

test("a mailer-daemon From address classifies as bounce", () => {
    const result = classifyInboundMessage({ fromAddress: "mailer-daemon@example.com", headers: [], bodyText: "stop unsubscribe" });
    assert.equal(result, "bounce");
});

test("a delivery-status report Content-Type classifies as bounce", () => {
    assert.equal(isBounce("postmaster@somewhere.com", [{ name: "Content-Type", value: "multipart/report; report-type=delivery-status" }]), true);
});

test("a quoted 'stop' inside a normal reply's quoted history is ignored", () => {
    const body = "Thanks, sounds good!\n\nOn Mon, Jan 1 wrote:\n> stop unsubscribe remove me";
    const result = classifyInboundMessage({ fromAddress: "client@example.com", headers: [], bodyText: body });
    assert.equal(result, "reply");
});

test("stop in the NEW text (not quoted) is an opt-out", () => {
    const body = "Please stop emailing me.\n\nOn Mon, Jan 1 wrote:\n> original message";
    const result = classifyInboundMessage({ fromAddress: "client@example.com", headers: [], bodyText: body });
    assert.equal(result, "opt-out");
});

test("'not interested' is recognized as an opt-out phrase", () => {
    assert.equal(containsOptOutPhrase("Thanks but not interested at this time"), true);
});

test("a plain reply with none of the opt-out phrases classifies as reply", () => {
    const result = classifyInboundMessage({ fromAddress: "client@example.com", headers: [], bodyText: "Sounds great, let's schedule a call" });
    assert.equal(result, "reply");
});

test("'stop' as a SUBSTRING of a larger word (e.g. 'nonstop', 'doorstop') is NOT an opt-out — word-boundary, not substring, matching", () => {
    assert.equal(containsOptOutPhrase("We offer nonstop support and a sturdy doorstop too"), false);
    assert.equal(classifyInboundMessage({ fromAddress: "client@example.com", headers: [], bodyText: "We offer nonstop support" }), "reply");
});

test("stripQuotedText removes '>' quote lines", () => {
    const stripped = stripQuotedText("my reply\n> their original text\n> more quoted text");
    assert.equal(stripped, "my reply");
});

test("stripQuotedText cuts everything from a '-----Original Message-----' boundary", () => {
    const stripped = stripQuotedText("my reply text\n-----Original Message-----\nstop unsubscribe");
    assert.equal(stripped.includes("stop"), false);
});

test("auto-reply takes priority over an opt-out phrase appearing in its own text", () => {
    const result = classifyInboundMessage({
        fromAddress: "client@example.com",
        headers: [{ name: "Auto-Submitted", value: "auto-generated" }],
        bodyText: "I am out of office and not interested in checking email until Monday",
    });
    assert.equal(result, "auto-reply");
});

test("bounce takes priority over auto-reply headers", () => {
    const result = classifyInboundMessage({
        fromAddress: "mailer-daemon@example.com",
        headers: [{ name: "Auto-Submitted", value: "auto-generated" }],
        bodyText: "delivery failed",
    });
    assert.equal(result, "bounce");
});
