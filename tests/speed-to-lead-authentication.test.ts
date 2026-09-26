/**
 * Authentication rules (docs/plans/SPEED-TO-LEAD-V1A.md finding 1). Fixtures
 * are masked reconstructions of the real header shapes R0 captured
 * (R0-FINDINGS.md, samples 1a0cfd52fb38aade / website, 1a08714f94457353 /
 * Voice) — no customer data, matching R0's own no-PII rule.
 *
 * KNOWN OPEN ITEM: R0 recorded `cv=` on the real ARC-Seal i=1 header but not
 * `d=`. These fixtures assume `d=google.com` per the spec's documented rule
 * (authentication.ts's own header comment says the same) — Justin's R2/R3
 * production acceptance tests are what actually exercises this against a
 * real message; if the real value differs, the fix is a one-line constant
 * change in authentication.ts, not a redesign.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { authenticateMessage, type RawHeader } from "../src/lib/speed-to-lead/authentication";

function h(name: string, value: string): RawHeader {
    return { name, value };
}

const WEBSITE_TOP_AR =
    "mx.google.com; dkim=pass header.i=@goldentouchremodeling.com header.s=google header.b=H60chm; " +
    "arc=pass (i=2 spf=pass spfdomain=send.goldentouchremodeling.com dkim=pass dkdomain=goldentouchremodeling.com dkim=pass dkdomain=amazonses.com dmarc=pass fromdomain=goldentouchremodeling.com); " +
    "spf=pass (google.com: domain of connect+bnc@goldentouchremodeling.com designates 209.85.220.69 as permitted sender) smtp.mailfrom=connect+bnc@goldentouchremodeling.com; " +
    "dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=goldentouchremodeling.com; " +
    "dara=neutral header.i=@goldentouchremodeling.com";

const WEBSITE_AAR_I1_REAL =
    "i=1; mx.google.com; " +
    "dkim=pass header.i=@goldentouchremodeling.com header.s=resend header.b=abc123; " +
    "dkim=pass header.i=@amazonses.com header.s=224i4yxa5dv7c2xz3womw6peuasteono header.b=def456; " +
    "spf=pass (google.com: domain of 0100019-000000@send.goldentouchremodeling.com designates 54.240.48.1 as permitted sender) smtp.mailfrom=0100019-000000@send.goldentouchremodeling.com; " +
    "dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=goldentouchremodeling.com";

function realWebsiteHeaders(overrides: Partial<Record<string, string>> = {}, extra: RawHeader[] = []): RawHeader[] {
    return [
        h("From", "website@goldentouchremodeling.com"),
        h("X-Google-Group-Id", overrides.groupId ?? "347075611006"),
        h("List-ID", overrides.listId ?? "<Connect.goldentouchremodeling.com>"),
        h("Authentication-Results", overrides.topAr ?? WEBSITE_TOP_AR),
        h("ARC-Seal", overrides.arcSeal1 ?? "i=1; a=rsa-sha256; cv=none; d=google.com; s=arc-20160816; t=1; b=x"),
        h("ARC-Authentication-Results", overrides.aar1 ?? WEBSITE_AAR_I1_REAL),
        h("ARC-Seal", "i=2; a=rsa-sha256; cv=pass; d=google.com; s=arc-20160816; t=2; b=y"),
        h("ARC-Authentication-Results", "i=2; mx.google.com; " + WEBSITE_TOP_AR),
        ...extra,
    ];
}

const VOICE_TOP_AR =
    "mx.google.com; dkim=pass header.i=@google.com header.s=20251104 header.b=abc; " +
    "spf=pass (google.com: domain of x@grandcentral.bounces.google.com designates 209.85.220.73 as permitted sender) smtp.mailfrom=x@grandcentral.bounces.google.com; " +
    "dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=google.com; " +
    "dara=neutral header.i=@goldentouchremodeling.com";

function realVoiceHeaders(subject = "New missed call from (360) 555-0100", overrides: Partial<Record<string, string>> = {}): RawHeader[] {
    return [
        h("From", "Google Voice <voice-noreply@google.com>"),
        h("Subject", subject),
        h("Authentication-Results", overrides.topAr ?? VOICE_TOP_AR),
    ];
}

// ── Real shapes pass (test 10) ──────────────────────────────────────────

test("a real website-group-relay message is trusted", () => {
    const verdict = authenticateMessage(realWebsiteHeaders(), "website@goldentouchremodeling.com");
    assert.equal(verdict.trusted, true);
    assert.equal(verdict.rule, "website-group-relay");
});

test("a real Voice missed-call message is trusted", () => {
    const verdict = authenticateMessage(realVoiceHeaders(), "voice-noreply@google.com");
    assert.equal(verdict.trusted, true);
    assert.equal(verdict.rule, "voice-direct");
});

test("Voice DKIM matched via header.i (Gmail never emits header.d)", () => {
    // WEBSITE_AAR_I1_REAL and VOICE_TOP_AR above both use header.i=, matching
    // the real R0 shape — this test exists so a future "helpfully" restoring
    // a header.d-only check regresses visibly.
    const verdict = authenticateMessage(realVoiceHeaders(), "voice-noreply@google.com");
    assert.equal(verdict.trusted, true);
});

// ── Voice subject / non-lead filtering ──────────────────────────────────

test("'Welcome to Google Voice' is not trusted (account setup, not a lead)", () => {
    const verdict = authenticateMessage(realVoiceHeaders("Welcome to Google Voice"), "voice-noreply@google.com");
    assert.equal(verdict.trusted, false);
});

test("a voicemail and a text-message notification are both trusted", () => {
    assert.equal(authenticateMessage(realVoiceHeaders("New voicemail from (360) 555-0100"), "voice-noreply@google.com").trusted, true);
    assert.equal(authenticateMessage(realVoiceHeaders("New text message from (360) 555-0100"), "voice-noreply@google.com").trusted, true);
});

// ── Forgeries fail (test 11) ─────────────────────────────────────────────

test("(a) Group s=google top pass alone, with ARC i=1 dmarc=fail, is untrusted", () => {
    const headers = realWebsiteHeaders({
        aar1: WEBSITE_AAR_I1_REAL.replace("dmarc=pass", "dmarc=fail"),
    });
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(b) an attacker-sealed i=1 (ARC-Seal d=attacker.example) is untrusted even though it claims mx.google.com s=resend pass", () => {
    const headers = realWebsiteHeaders({ arcSeal1: "i=1; a=rsa-sha256; cv=none; d=attacker.example; s=x; t=1; b=z" });
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(c) duplicate i=1 ARC-Seal headers are untrusted", () => {
    const headers = realWebsiteHeaders();
    headers.push(h("ARC-Seal", "i=1; a=rsa-sha256; cv=none; d=google.com; s=x; t=9; b=dupe"));
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(d) a top authserv-id of attacker.example with arc=pass is untrusted", () => {
    const headers = realWebsiteHeaders({ topAr: WEBSITE_TOP_AR.replace("mx.google.com;", "attacker.example;") });
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(e) a spoofed lower Authentication-Results with no real ARC chain is untrusted", () => {
    const headers = [
        h("From", "website@goldentouchremodeling.com"),
        h("X-Google-Group-Id", "347075611006"),
        h("List-ID", "<Connect.goldentouchremodeling.com>"),
        h("Authentication-Results", WEBSITE_TOP_AR),
        // No ARC-Seal / ARC-Authentication-Results headers at all.
    ];
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(f) ARC i=1 dkim=fail (domain matches but result does not) is untrusted", () => {
    const headers = realWebsiteHeaders({ aar1: WEBSITE_AAR_I1_REAL.replace("dkim=pass header.i=@goldentouchremodeling.com header.s=resend", "dkim=fail header.i=@goldentouchremodeling.com header.s=resend") });
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(g) dmarc=pass appearing only inside a comment is never read as a real top-level result", () => {
    const forgedAar1 = "i=1; mx.google.com; " +
        "dkim=pass header.i=@goldentouchremodeling.com header.s=resend header.b=abc; " +
        "spf=pass (dmarc=pass header.from=goldentouchremodeling.com) smtp.mailfrom=x";
    const headers = realWebsiteHeaders({ aar1: forgedAar1 });
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(h) website@ without the Group ID or List-ID is untrusted", () => {
    const headers = realWebsiteHeaders().filter(header => header.name !== "X-Google-Group-Id" && header.name !== "List-ID");
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(i) a Voice From with a non-google.com DKIM domain is untrusted", () => {
    const headers = realVoiceHeaders(undefined, { topAr: VOICE_TOP_AR.replace("header.i=@google.com", "header.i=@attacker.example") });
    assert.equal(authenticateMessage(headers, "voice-noreply@google.com").trusted, false);
});

// ── Appended-chain forgery (round-5, RFC 8617 section 5.2) ─────────────────

test("(j) a correctly-signed i=3 ARC set appended AFTER a genuine 2-hop chain, sealed by an attacker domain, is untrusted", () => {
    const headers = realWebsiteHeaders();
    headers.push(h("ARC-Seal", "i=3; a=rsa-sha256; cv=pass; d=attacker.example; s=x; t=3; b=z"));
    headers.push(h("ARC-Authentication-Results", "i=3; mx.google.com; " + WEBSITE_TOP_AR));
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(k) an EXTRA i=3 ARC set appended after a genuine chain is STILL untrusted even when sealed by google.com itself — a topology-shape violation, not just a wrong sealing domain", () => {
    const headers = realWebsiteHeaders();
    headers.push(h("ARC-Seal", "i=3; a=rsa-sha256; cv=pass; d=google.com; s=arc-20160816; t=3; b=z"));
    headers.push(h("ARC-Authentication-Results", "i=3; mx.google.com; " + WEBSITE_TOP_AR));
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

test("(l) a genuine chain missing its i=2 hop entirely (only i=1 present) is untrusted — the permitted topology requires exactly {1, 2}, never a subset", () => {
    const headers = realWebsiteHeaders().filter(header => !(header.name === "ARC-Seal" && header.value.startsWith("i=2")) && !(header.name === "ARC-Authentication-Results" && header.value.startsWith("i=2")));
    assert.equal(authenticateMessage(headers, "website@goldentouchremodeling.com").trusted, false);
});

// ── Config ───────────────────────────────────────────────────────────────

test("an unknown From address is untrusted regardless of headers", () => {
    const verdict = authenticateMessage(realWebsiteHeaders(), "someone-else@example.com");
    assert.equal(verdict.trusted, false);
});

test("invalid SPEED_TO_LEAD_TRUSTED_SENDERS JSON falls back to the built-in defaults, not a crash", () => {
    const env = { SPEED_TO_LEAD_TRUSTED_SENDERS: "{not valid json" } as unknown as NodeJS.ProcessEnv;
    const verdict = authenticateMessage(realWebsiteHeaders(), "website@goldentouchremodeling.com", env);
    assert.equal(verdict.trusted, true);
});
