import test from "node:test";
import assert from "node:assert/strict";
import { buildRawMessage } from "../src/lib/speed-to-lead/dispatch";

function decode(raw: string): string {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
}

test("buildRawMessage never includes CC, BCC or Reply-To headers", () => {
    const decoded = decode(buildRawMessage({
        from: "gtrsupport@goldentouchremodeling.com", to: "client@example.com",
        subject: "Hi", body: "Body", footer: "Footer", messageId: "<pb-1@goldentouchremodeling.com>",
    }));
    assert.ok(!/^Cc:/im.test(decoded));
    assert.ok(!/^Bcc:/im.test(decoded));
    assert.ok(!/^Reply-To:/im.test(decoded));
});

test("buildRawMessage includes From, To, Subject and the exact Message-ID", () => {
    const decoded = decode(buildRawMessage({
        from: "gtrsupport@goldentouchremodeling.com", to: "client@example.com",
        subject: "Hi there", body: "Body", footer: "Footer", messageId: "<pb-abc@goldentouchremodeling.com>",
    }));
    assert.match(decoded, /^From: gtrsupport@goldentouchremodeling\.com/m);
    assert.match(decoded, /^To: client@example\.com/m);
    assert.match(decoded, /^Message-ID: <pb-abc@goldentouchremodeling\.com>/m);
});

test("buildRawMessage includes In-Reply-To and References only when given", () => {
    const withThreading = decode(buildRawMessage({
        from: "a@x.com", to: "b@x.com", subject: "s", body: "b", footer: "f",
        messageId: "<m1@x.com>", inReplyTo: "<orig@x.com>", references: "<orig@x.com>",
    }));
    assert.match(withThreading, /^In-Reply-To: <orig@x\.com>/m);
    assert.match(withThreading, /^References: <orig@x\.com>/m);

    const without = decode(buildRawMessage({ from: "a@x.com", to: "b@x.com", subject: "s", body: "b", footer: "f", messageId: "<m2@x.com>" }));
    assert.ok(!/^In-Reply-To:/m.test(without));
    assert.ok(!/^References:/m.test(without));
});

test("buildRawMessage produces a valid base64url string (no +, / or padding)", () => {
    const raw = buildRawMessage({ from: "a@x.com", to: "b@x.com", subject: "s", body: "b", footer: "f", messageId: "<m@x.com>" });
    assert.ok(!raw.includes("+"));
    assert.ok(!raw.includes("/"));
    assert.ok(!raw.includes("="));
});

test("buildRawMessage encodes a non-ASCII subject as an RFC 2047 encoded-word", () => {
    const decoded = decode(buildRawMessage({ from: "a@x.com", to: "b@x.com", subject: "Café Ünïcode", body: "b", footer: "f", messageId: "<m@x.com>" }));
    assert.match(decoded, /^Subject: =\?UTF-8\?B\?/m);
});

test("buildRawMessage body includes both the body text and the footer", () => {
    const decoded = decode(buildRawMessage({ from: "a@x.com", to: "b@x.com", subject: "s", body: "the body", footer: "the footer", messageId: "<m@x.com>" }));
    // Body is base64-encoded within the message; decode that inner layer too.
    const bodyPart = decoded.split(/\r\n\r\n/)[1] ?? "";
    const innerDecoded = Buffer.from(bodyPart.replace(/\r\n/g, ""), "base64").toString("utf8");
    assert.ok(innerDecoded.includes("the body"));
    assert.ok(innerDecoded.includes("the footer"));
});
