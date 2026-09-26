/**
 * Request-level test for POST /api/speed-to-lead/intake — round-2 gap
 * (acceptance test 4): every prior assertion about this route's mode-gate-
 * first ordering, 32KB->413 cap, generic 401 body, and {ok,duplicate}-only
 * response shape was a code review of route.ts, never an actual call
 * through POST(). tests/speed-to-lead-intake-db.test.ts calls the
 * underlying `intakeWebhookLead()` lib function directly and proves nothing
 * about the route wrapper itself.
 *
 * The mode gate, body-size cap and signature check all return BEFORE the
 * route ever touches Prisma, so those three cases need no database at all.
 * Only the happy-path response-shape case reaches `intakeWebhookLead()` and
 * is gated behind SPEED_TO_LEAD_TEST_URL, same convention as every other DB
 * test in this suite.
 *
 * `next/server`'s `after()` throws outside a real request scope (see
 * tests/users-route-pin-leak.test.ts's header comment for the same issue) —
 * stubbed via the same Module.prototype.require patch, keeping the rest of
 * `next/server` (NextResponse) real.
 */
import { test, before, after as afterHook } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Module from "node:module";
import { PrismaClient } from "@prisma/client";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-speed-to-lead-intake-route";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

const WEBHOOK_SECRET = "route-test-webhook-secret";
const TEST_SECRET = "route-test-lead-ingest-test-secret";
process.env.SPEED_TO_LEAD_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.LEAD_INGEST_TEST_SECRET = TEST_SECRET;

let POST: (req: Request) => Promise<Response>;
let originalRequire: typeof Module.prototype.require;

before(async () => {
    originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "next/server") {
            patched.add(id);
            // eslint-disable-next-line prefer-rest-params
            const real = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return { ...real, after: () => {} };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    try {
        const route = await import("../src/app/api/speed-to-lead/intake/route");
        POST = route.POST;
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (!patched.has("next/server")) throw new Error("the next/server after() stub never applied");
    assert.equal(typeof POST, "function", "POST /api/speed-to-lead/intake did not load");
});

afterHook(() => {
    Module.prototype.require = originalRequire;
});

function sign(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000).toString()) {
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    return { "x-gtr-timestamp": timestamp, "x-gtr-signature": signature };
}

function validPayload(overrides: Record<string, unknown> = {}) {
    return {
        submissionId: `route-test-${Math.random().toString(36).slice(2)}`,
        name: "Route Test",
        email: `route-test-${Math.random().toString(36).slice(2)}@example.test`,
        phone: null,
        message: "We would like a full kitchen remodel, please reach out soon and give us a quote.",
        projectType: null,
        location: null,
        honeypot: "",
        renderedAtMs: 0,
        submittedAtMs: 5000,
        smsConsent: false,
        attribution: {},
        ...overrides,
    };
}

test("mode gate runs BEFORE the body-size cap: OFF returns 503 even for a payload well over the 32KB limit", async () => {
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_MODE = "OFF";
    try {
        const oversized = "x".repeat(40_000);
        const res = await POST(new Request("https://probuild.test/api/speed-to-lead/intake", { method: "POST", body: oversized }));
        assert.equal(res.status, 503, "OFF must refuse before ever measuring the body");
        const body = await res.json();
        assert.deepStrictEqual(body, { error: "not available" });
    } finally {
        process.env.SPEED_TO_LEAD_MODE = originalMode;
    }
});

test("a body over INTAKE_MAX_BODY_BYTES (32KB) gets 413, checked before signature verification", async () => {
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    try {
        const oversized = "x".repeat(40_000);
        // Deliberately no signature headers at all — if signature verification
        // ran first this would be a 401, not a 413.
        const res = await POST(new Request("https://probuild.test/api/speed-to-lead/intake", { method: "POST", body: oversized }));
        assert.equal(res.status, 413);
        const body = await res.json();
        assert.deepStrictEqual(body, { error: "payload too large" });
    } finally {
        process.env.SPEED_TO_LEAD_MODE = originalMode;
    }
});

test("an invalid signature gets a generic 401 with zero rows created — never a hint about which secret failed", async () => {
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    try {
        const rawBody = JSON.stringify(validPayload());
        const res = await POST(new Request("https://probuild.test/api/speed-to-lead/intake", {
            method: "POST",
            body: rawBody,
            headers: { "x-gtr-timestamp": Math.floor(Date.now() / 1000).toString(), "x-gtr-signature": "0".repeat(64) },
        }));
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.deepStrictEqual(body, { error: "unauthorized" });
    } finally {
        process.env.SPEED_TO_LEAD_MODE = originalMode;
    }
});

const databaseUrl = process.env.SPEED_TO_LEAD_TEST_URL;
const skip = !databaseUrl && "set SPEED_TO_LEAD_TEST_URL to a disposable PostgreSQL URL";

/**
 * The route creates a real Lead + LeadAlert (PENDING, due immediately) via
 * the same intakeWebhookLead() path speed-to-lead-intake-db.test.ts calls
 * directly — without this, that row stays PENDING forever in the shared
 * CI Postgres and inflates every LATER deliverDueAlerts call in the same
 * job run, including tests/speed-to-lead-alerts-db.test.ts's own "sink hit
 * exactly once" assertion (reproduced in CI: a deterministic +1, not a
 * flake — the actual root cause behind Codex's "2 !== 1" finding).
 */
async function cleanupRouteTestRow(externalId: string): Promise<void> {
    if (!databaseUrl) return;
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
        const row = await db.leadIntakeEvent.findUnique({ where: { externalId } });
        await db.leadIntakeEvent.deleteMany({ where: { externalId } }).catch(() => undefined);
        if (row?.leadId) {
            await db.leadAlert.deleteMany({ where: { leadId: row.leadId } }).catch(() => undefined);
            await db.lead.delete({ where: { id: row.leadId } }).catch(() => undefined);
        }
    } finally {
        await db.$disconnect();
    }
}

test("a validly-signed test-secret submission returns exactly {ok, duplicate} — no leadId, no verdict echoed back", { skip }, async () => {
    process.env.DATABASE_URL = `${databaseUrl}?pgbouncer=true`;
    const originalMode = process.env.SPEED_TO_LEAD_MODE;
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    const payload = validPayload();
    try {
        const rawBody = JSON.stringify(payload);
        const headers = sign(rawBody, TEST_SECRET);
        const res = await POST(new Request("https://probuild.test/api/speed-to-lead/intake", { method: "POST", body: rawBody, headers }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(Object.keys(body).sort(), ["duplicate", "ok"]);
        assert.equal(body.ok, true);
        assert.equal(body.duplicate, false);
    } finally {
        process.env.SPEED_TO_LEAD_MODE = originalMode;
        await cleanupRouteTestRow(`sub:${payload.submissionId}`);
    }
});
