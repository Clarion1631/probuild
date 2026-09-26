import test from "node:test";
import assert from "node:assert/strict";
import { authenticateMessage, trustedSenderPatterns } from "../src/lib/speed-to-lead/authentication";

const VOICE_FROM = "voice-noreply@google.com";
const env = { SPEED_TO_LEAD_TRUSTED_SENDERS: JSON.stringify([{ fromAddress: "website@gtr-sales.example.com", signingDomain: "gtr-sales.example.com" }]) } as unknown as NodeJS.ProcessEnv;

test("a genuine Google-authenticated Voice message is trusted", () => {
    const headers = [{ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.d=google.com; dmarc=pass header.from=google.com" }];
    const verdict = authenticateMessage(headers, VOICE_FROM);
    assert.equal(verdict.trusted, true);
});

test("an untrusted From address is rejected outright, before headers are even inspected", () => {
    const headers = [{ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.d=google.com; dmarc=pass" }];
    const verdict = authenticateMessage(headers, "someone-else@gmail.com");
    assert.equal(verdict.trusted, false);
    assert.match(verdict.reason ?? "", /trusted-sender/);
});

test("a spoofed LOWER Authentication-Results header (not the topmost) is ignored", () => {
    const headers = [
        { name: "Authentication-Results", value: "mx.google.com; dkim=fail header.d=google.com; dmarc=fail" },
        { name: "Authentication-Results", value: "spf.attacker.example; dkim=pass header.d=google.com; dmarc=pass" },
    ];
    // The TOPMOST is the receiving boundary and it fails — a second, lower
    // header claiming pass must not rescue it.
    const verdict = authenticateMessage(headers, VOICE_FROM);
    assert.equal(verdict.trusted, false);
});

test("d= matches but dkim=fail is rejected", () => {
    const headers = [{ name: "Authentication-Results", value: "mx.google.com; dkim=fail header.d=google.com; dmarc=pass" }];
    assert.equal(authenticateMessage(headers, VOICE_FROM).trusted, false);
});

test("dkim=pass but the signing domain does not match the expected pattern is rejected", () => {
    const headers = [{ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.d=some-other-domain.com; dmarc=pass" }];
    assert.equal(authenticateMessage(headers, VOICE_FROM).trusted, false);
});

test("an authserv-id other than mx.google.com is not trusted even if it claims pass", () => {
    const headers = [{ name: "Authentication-Results", value: "some.other.server; dkim=pass header.d=google.com; dmarc=pass" }];
    assert.equal(authenticateMessage(headers, VOICE_FROM).trusted, false);
});

test("ARC case: direct Authentication-Results fails (post-forward) but Google's own arc=pass vouches for the first Google ARC hop — trusted", () => {
    const headers = [
        { name: "Authentication-Results", value: "mx.google.com; arc=pass; dkim=fail header.d=gtr-sales.example.com; dmarc=fail" },
        { name: "ARC-Authentication-Results", value: "i=1; mx.google.com; dkim=pass header.d=gtr-sales.example.com; dmarc=pass header.from=gtr-sales.example.com" },
    ];
    const verdict = authenticateMessage(headers, "website@gtr-sales.example.com", env);
    assert.equal(verdict.trusted, true);
});

test("ARC case: the ARC hop is not from mx.google.com — not trusted", () => {
    const headers = [
        { name: "Authentication-Results", value: "mx.google.com; arc=pass; dkim=fail" },
        { name: "ARC-Authentication-Results", value: "i=1; some.other.host; dkim=pass header.d=gtr-sales.example.com; dmarc=pass header.from=gtr-sales.example.com" },
    ];
    const verdict = authenticateMessage(headers, "website@gtr-sales.example.com", env);
    assert.equal(verdict.trusted, false);
});

test("ARC case: an unsigned ARC-Authentication-Results claims pass, but Google's own receiving header says arc=fail — not trusted (a forged ARC header must never be trusted from text alone)", () => {
    const headers = [
        { name: "Authentication-Results", value: "mx.google.com; arc=fail; dkim=fail header.d=gtr-sales.example.com; dmarc=fail" },
        { name: "ARC-Authentication-Results", value: "i=1; mx.google.com; dkim=pass header.d=gtr-sales.example.com; dmarc=pass header.from=gtr-sales.example.com" },
    ];
    const verdict = authenticateMessage(headers, "website@gtr-sales.example.com", env);
    assert.equal(verdict.trusted, false);
});

test("ARC case: Google's receiving header carries no arc= verdict at all — the ARC fallback must fail closed, not trust the text", () => {
    const headers = [
        { name: "Authentication-Results", value: "mx.google.com; dkim=fail header.d=gtr-sales.example.com; dmarc=fail" },
        { name: "ARC-Authentication-Results", value: "i=1; mx.google.com; dkim=pass header.d=gtr-sales.example.com; dmarc=pass header.from=gtr-sales.example.com" },
    ];
    const verdict = authenticateMessage(headers, "website@gtr-sales.example.com", env);
    assert.equal(verdict.trusted, false);
});

test("DKIM and DMARC domains must be independently matched — a DKIM-domain match with no aligned DMARC From-domain is rejected", () => {
    const headers = [{ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.d=google.com; dmarc=pass" }];
    // dmarc=pass but no header.from= at all — the old code fell back to
    // header.d= for "domain" and accepted this; the two mechanisms must be
    // checked independently.
    assert.equal(authenticateMessage(headers, VOICE_FROM).trusted, false);
});

test("no Authentication-Results header at all is not trusted", () => {
    assert.equal(authenticateMessage([], VOICE_FROM).trusted, false);
});

test("trustedSenderPatterns falls back to the default list on invalid JSON", () => {
    const patterns = trustedSenderPatterns({ SPEED_TO_LEAD_TRUSTED_SENDERS: "not json" } as unknown as NodeJS.ProcessEnv);
    assert.ok(patterns.some(p => p.fromAddress === VOICE_FROM));
});
