import test from "node:test";
import assert from "node:assert/strict";
import { pureTriageChecks, isServiceAreaOrUnset, clearsMinRenderDelay, triageWebLead, alertAudience } from "../src/lib/speed-to-lead/triage";
import type { WebIntakePayload } from "../src/lib/speed-to-lead/payload";

const BASE: WebIntakePayload = {
    submissionId: "sub-1",
    name: "Jane Doe",
    email: "jane@example.com",
    phone: null,
    message: "We would like a full kitchen remodel, please reach out soon.",
    projectType: null,
    location: null,
    honeypot: "",
    renderedAtMs: 0,
    submittedAtMs: 5000,
    smsConsent: false,
    attribution: {},
};

test("a filled honeypot fails triage", () => {
    const reasons = pureTriageChecks({ ...BASE, honeypot: "bot" });
    assert.ok(reasons.includes("honeypot-filled"));
});

test("submitting under 3 seconds after render fails triage", () => {
    const reasons = pureTriageChecks({ ...BASE, renderedAtMs: 0, submittedAtMs: 1000 });
    assert.ok(reasons.includes("submitted-too-fast"));
});

test("a link or pitch word in the message fails triage", () => {
    assert.ok(pureTriageChecks({ ...BASE, message: "check out http://spam.example please" }).includes("contains-link"));
    assert.ok(pureTriageChecks({ ...BASE, message: "guaranteed roi investment opportunity" }).includes("contains-pitch-word"));
});

test("a too-short description fails triage", () => {
    assert.ok(pureTriageChecks({ ...BASE, message: "hi" }).includes("description-too-short"));
});

test("isServiceAreaOrUnset: empty/unset location always passes", () => {
    assert.equal(isServiceAreaOrUnset(null), true);
    assert.equal(isServiceAreaOrUnset(""), true);
});

test("isServiceAreaOrUnset matches a known city or zip prefix", () => {
    assert.equal(isServiceAreaOrUnset("Vancouver, WA"), true);
    assert.equal(isServiceAreaOrUnset("98682"), true);
    assert.equal(isServiceAreaOrUnset("Miami, FL 33101"), false);
});

test("clearsMinRenderDelay never goes negative on clock skew", () => {
    assert.equal(clearsMinRenderDelay(5000, 0), false);
});

test("a clean payload with no prior history is REAL", async () => {
    const db = fakeDb();
    const result = await triageWebLead(BASE, db as any);
    assert.deepEqual(result, { verdict: "REAL", reasons: [] });
});

test("a junk-marked endpoint short-circuits to JUNK with zero other reasons", async () => {
    const db = fakeDb({ junkEmails: new Set(["jane@example.com"]) });
    // Even a payload that would ALSO fail other checks still reports only endpoint-junk.
    const result = await triageWebLead({ ...BASE, honeypot: "bot" }, db as any);
    assert.deepEqual(result, { verdict: "JUNK", reasons: ["endpoint-junk"] });
});

test("a reused phone under a different name is REVIEW", async () => {
    const db = fakeDb({ priorPhoneRows: [{ id: "x" }] });
    const result = await triageWebLead({ ...BASE, phone: "3605550100" }, db as any);
    assert.equal(result.verdict, "REVIEW");
    assert.ok(result.reasons.includes("phone-reused-different-name"));
});

// ── alertAudience ────────────────────────────────────────────────────────

test("alertAudience: JUNK never alerts on either channel", () => {
    assert.deepEqual(alertAudience("JUNK", ["endpoint-junk"], false), { ntfy: false, ntfyPriority: "4", chat: false });
});

test("alertAudience: REAL always gets both channels at priority 4", () => {
    assert.deepEqual(alertAudience("REAL", [], false), { ntfy: true, ntfyPriority: "4", chat: true });
});

test("alertAudience: REVIEW with a spam signal is ntfy-only, low priority, no Chat", () => {
    assert.deepEqual(alertAudience("REVIEW", ["contains-link"], false), { ntfy: true, ntfyPriority: "2", chat: false });
});

test("alertAudience: REVIEW with no spam signal gets both channels", () => {
    assert.deepEqual(alertAudience("REVIEW", ["email-fallback"], false), { ntfy: true, ntfyPriority: "4", chat: true });
    assert.deepEqual(alertAudience("REVIEW", ["voice"], false), { ntfy: true, ntfyPriority: "4", chat: true });
    assert.deepEqual(alertAudience("REVIEW", ["existing-customer"], false), { ntfy: true, ntfyPriority: "4", chat: true });
});

test("alertAudience: isTest always reaches both channels regardless of verdict/reasons, except JUNK", () => {
    assert.deepEqual(alertAudience("REVIEW", ["contains-link"], true), { ntfy: true, ntfyPriority: "4", chat: true });
    assert.deepEqual(alertAudience("JUNK", ["endpoint-junk"], true), { ntfy: false, ntfyPriority: "4", chat: false });
});

// ── fake db ──────────────────────────────────────────────────────────────

function fakeDb(opts: { junkEmails?: Set<string>; priorPhoneRows?: unknown[] } = {}) {
    return {
        contactEndpoint: {
            findUnique: async ({ where }: { where: { endpoint: string } }) => {
                const email = where.endpoint.replace(/^email:/, "");
                return opts.junkEmails?.has(email) ? { junkAt: new Date(), clearedAt: null } : null;
            },
        },
        leadIntakeEvent: {
            findFirst: async ({ where }: any) => {
                if (where?.payload?.path?.[0] === "phone") return opts.priorPhoneRows?.[0] ?? null;
                return null;
            },
        },
        client: {
            findFirst: async () => null,
        },
    };
}
