/**
 * Customer payment reminders are disabled (Justin, Oct 2026).
 *
 * The cron route keeps its CRON_SECRET gate but does nothing else: no reminder
 * sweep, no email, no writes. vercel.json no longer schedules it. Re-enabling
 * means restoring both on purpose, and this test is the tripwire for that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GET } from "../src/app/api/cron/payment-reminders/route";

const ROUTE_PATH = "src/app/api/cron/payment-reminders/route.ts";

function withEnv(env: Record<string, string | undefined>, run: () => Promise<void>) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return run().finally(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

const request = (headers: Record<string, string> = {}) =>
    new Request("https://probuild.test/api/cron/payment-reminders", { headers });

test("GET answers { status: \"disabled\" }", async () => {
    await withEnv({ VERCEL_ENV: undefined, CRON_SECRET: undefined }, async () => {
        const res = await GET(request());
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: "disabled" });
    });
});

test("deployed: 401 without the cron secret, disabled with it", async () => {
    await withEnv({ VERCEL_ENV: "production", CRON_SECRET: "test-secret" }, async () => {
        assert.equal((await GET(request())).status, 401);
        assert.equal((await GET(request({ authorization: "Bearer wrong" }))).status, 401);
        const ok = await GET(request({ authorization: "Bearer test-secret" }));
        assert.equal(ok.status, 200);
        assert.deepEqual(await ok.json(), { status: "disabled" });
    });
});

test("deployed with CRON_SECRET unset: fails closed", async () => {
    await withEnv({ VERCEL_ENV: "preview", CRON_SECRET: undefined }, async () => {
        assert.equal((await GET(request({ authorization: "Bearer undefined" }))).status, 401);
    });
});

test("the route cannot send or write anything", () => {
    const src = readFileSync(ROUTE_PATH, "utf8");
    for (const banned of ["sendPaymentReminders", "sendNotification", "lastReminderAt", "prisma"]) {
        assert.ok(!src.includes(banned), `${ROUTE_PATH} must not reference ${banned}`);
    }
});

test("vercel.json no longer schedules the payment-reminders cron", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string }> };
    assert.ok(vercel.crons.length > 0, "the other crons are still there");
    assert.ok(!vercel.crons.some((c) => c.path.startsWith("/api/cron/payment-reminders")));
});
