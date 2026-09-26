import test from "node:test";
import assert from "node:assert/strict";
import { createLeadAlertsInTx } from "../src/lib/speed-to-lead/alerts";

interface RawCall {
    channel: "NTFY" | "CHAT";
    isTest: boolean;
}

function fakeTx() {
    const calls: RawCall[] = [];
    return {
        calls,
        // Prisma's tagged-template $executeRaw is invoked as
        // fn(templateStrings, ...substitutions) — the literal SQL text
        // (including 'NTFY'::"LeadAlertChannel") lives in the STRINGS, not
        // the substitutions, since it is not a `${}` interpolation.
        $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
            const text = strings.join("");
            const channel: RawCall["channel"] | undefined = text.includes("'NTFY'") ? "NTFY" : text.includes("'CHAT'") ? "CHAT" : undefined;
            const isTest = values.find(v => typeof v === "boolean") as boolean | undefined;
            if (channel) calls.push({ channel, isTest: isTest ?? false });
            return Promise.resolve(1);
        },
    };
}

test("REAL creates both NTFY and CHAT rows when Chat cards are enabled", async () => {
    process.env.SPEED_TO_LEAD_MODE = "LIVE";
    process.env.VERCEL_ENV = "production";
    const tx = fakeTx();
    await createLeadAlertsInTx(tx as any, { leadId: "lead-1", verdict: "REAL", reasons: [], isTest: false });
    assert.deepEqual(tx.calls.map(c => c.channel).sort(), ["CHAT", "NTFY"]);
});

test("REAL in TEST mode (or off production) creates only the NTFY row — no CHAT row candidate is ever attempted", async () => {
    process.env.SPEED_TO_LEAD_MODE = "TEST";
    delete process.env.VERCEL_ENV;
    const tx = fakeTx();
    await createLeadAlertsInTx(tx as any, { leadId: "lead-2", verdict: "REAL", reasons: [], isTest: false });
    assert.deepEqual(tx.calls.map(c => c.channel), ["NTFY"]);
});

test("REVIEW with a spam signal creates only NTFY, never CHAT, even in LIVE production", async () => {
    process.env.SPEED_TO_LEAD_MODE = "LIVE";
    process.env.VERCEL_ENV = "production";
    const tx = fakeTx();
    await createLeadAlertsInTx(tx as any, { leadId: "lead-3", verdict: "REVIEW", reasons: ["contains-link"], isTest: false });
    assert.deepEqual(tx.calls.map(c => c.channel), ["NTFY"]);
});

test("JUNK creates no alert rows at all", async () => {
    process.env.SPEED_TO_LEAD_MODE = "LIVE";
    process.env.VERCEL_ENV = "production";
    const tx = fakeTx();
    await createLeadAlertsInTx(tx as any, { leadId: "lead-4", verdict: "JUNK", reasons: ["endpoint-junk"], isTest: false });
    assert.deepEqual(tx.calls, []);
});

test("isTest is carried through onto the inserted rows", async () => {
    process.env.SPEED_TO_LEAD_MODE = "LIVE";
    process.env.VERCEL_ENV = "production";
    const tx = fakeTx();
    await createLeadAlertsInTx(tx as any, { leadId: "lead-5", verdict: "REAL", reasons: [], isTest: true });
    assert.ok(tx.calls.every(c => c.isTest === true));
});
