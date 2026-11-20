/**
 * A typed send-dialog email must reach the Client record (blank-only) and the
 * QuickBooks invoice BillEmail, or QuickBooks makes no pay link.
 *
 * The push tests drive the REAL pushMilestoneToQuickBooks create path against a
 * fake Prisma (src/lib/prisma.ts reads globalThis.prisma) and a fake QuickBooks
 * over global fetch, and inspect the invoice POST body.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fillClientEmailIfBlank, normalizeFillEmail } from "../src/lib/client-email-fill";
import { pushMilestoneToQuickBooks } from "../src/lib/quickbooks-payments";
import { createRouteDeadline, type QBTokens } from "../src/lib/quickbooks";
import { encryptObject } from "../src/lib/crypto";

function fakeDb(result: { count: number } | Error = { count: 1 }) {
    const calls: any[] = [];
    return {
        calls,
        db: {
            client: {
                async updateMany(args: any) {
                    calls.push(args);
                    if (result instanceof Error) throw result;
                    return result;
                },
            },
        },
    };
}

test("normalizeFillEmail trims and rejects non-emails", () => {
    assert.equal(normalizeFillEmail("  a@b.com "), "a@b.com");
    for (const bad of ["", "   ", null, undefined, "nope", "a@b", "a b@c.com", "@b.com", "pat@example..com"]) {
        assert.equal(normalizeFillEmail(bad as any), null, String(bad));
    }
});

test("fills a blank-email client: WHERE is id + blank-only, email trimmed", async () => {
    const { db, calls } = fakeDb({ count: 1 });
    assert.equal(await fillClientEmailIfBlank("cl-1", "  pat@example.com  ", db), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
        where: { id: "cl-1", OR: [{ email: null }, { email: "" }] },
        data: { email: "pat@example.com" },
    });
});

test("invalid, empty or null email returns false without touching the db", async () => {
    for (const bad of ["not-an-email", "", "   ", null, undefined]) {
        const { db, calls } = fakeDb();
        assert.equal(await fillClientEmailIfBlank("cl-1", bad as any, db), false);
        assert.equal(calls.length, 0);
    }
});

test("missing clientId returns false without touching the db", async () => {
    for (const id of [null, undefined, ""]) {
        const { db, calls } = fakeDb();
        assert.equal(await fillClientEmailIfBlank(id as any, "a@b.com", db), false);
        assert.equal(calls.length, 0);
    }
});

test("count 0 (client already had an email) returns false", async () => {
    const { db } = fakeDb({ count: 0 });
    assert.equal(await fillClientEmailIfBlank("cl-1", "a@b.com", db), false);
});

test("a db error is swallowed and returns false", async () => {
    const { db } = fakeDb(new Error("db down"));
    const origError = console.error;
    const logged: unknown[][] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
        assert.equal(await fillClientEmailIfBlank("cl-1", "a@b.com", db), false);
    } finally {
        console.error = origError;
    }
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /\[fillClientEmailIfBlank\]/);
});

// ---- pushMilestoneToQuickBooks: BillEmail precedence ----------------------

const TOKENS: QBTokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };

function makePrisma(clientEmail: string | null) {
    const state: any = {};
    const tx: any = {
        async $queryRaw() { return []; },
        progressBillingLine: { async findFirst() { return null; } },
        paymentSchedule: {
            async updateMany(args: any) {
                Object.assign(state, args.data);
                return { count: 1 };
            },
        },
    };
    return {
        integration: {
            async findUnique() {
                return { id: "system_settings", settings: encryptObject({ quickbooks: { connected: true, serviceItemId: "item-1" } }) };
            },
        },
        client: {
            async findUnique() { return { id: "cl-1", name: "Mesplay", email: clientEmail, qbCustomerId: "42" }; },
        },
        progressBillingLine: { async findFirst() { return null; } },
        paymentSchedule: {
            async findUnique() {
                return {
                    id: "ps-1",
                    invoiceId: "inv-1",
                    status: "Pending",
                    name: "Rough-in",
                    amount: 1089,
                    pretaxAmount: 1000,
                    taxAmount: 89,
                    dueDate: new Date("2026-09-15T00:00:00.000Z"),
                    qbPaymentId: null,
                    qbInvoiceId: null,
                    qbInvoiceLink: null,
                    qbSyncError: null,
                    invoice: {
                        code: "INV-00171",
                        clientId: "cl-1",
                        taxRate: 8.9,
                        client: { id: "cl-1", name: "Mesplay", email: clientEmail, qbCustomerId: "42" },
                        project: { id: "proj-1", name: "Mesplay Kitchen" },
                        payments: [{ id: "ps-1", createdAt: new Date() }],
                    },
                };
            },
            async updateMany(args: any) {
                Object.assign(state, args.data);
                return { count: 1 };
            },
        },
        async $transaction(fn: (t: any) => Promise<unknown>) { return fn(tx); },
    };
}

/** Runs the push and returns the BillEmail in the invoice POST body (undefined when absent). */
async function billEmailSent(clientEmail: string | null, opts?: { billEmailFallback?: string | null }) {
    const prev = { prisma: (globalThis as any).prisma, fetch: globalThis.fetch, secret: process.env.NEXTAUTH_SECRET };
    process.env.NEXTAUTH_SECRET = "test-secret";
    (globalThis as any).prisma = makePrisma(clientEmail);
    let posted: any = null;
    globalThis.fetch = (async (url: string, init?: any) => {
        const u = String(url);
        if (init?.method === "POST" && /\/invoice\b/.test(u)) {
            posted = JSON.parse(init.body);
            // A definite "no": nothing created, the push releases its claim and throws.
            return new Response(JSON.stringify({ Fault: { Error: [{ Message: "stop" }] } }), {
                status: 400, headers: { "content-type": "application/json" },
            });
        }
        // Customer existence check (the stored mapping "42" is trusted when found).
        return new Response(JSON.stringify({ QueryResponse: { Customer: [{ Id: "42" }] } }), {
            status: 200, headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    try {
        await pushMilestoneToQuickBooks("ps-1", TOKENS, createRouteDeadline(30_000), opts).catch(() => null);
    } finally {
        (globalThis as any).prisma = prev.prisma;
        globalThis.fetch = prev.fetch;
        if (prev.secret === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = prev.secret;
    }
    assert.ok(posted, "the invoice create POST was reached");
    return posted.BillEmail?.Address as string | undefined;
}

test("blank client email: the typed fallback becomes the QBO BillEmail", async () => {
    assert.equal(await billEmailSent(null, { billEmailFallback: "typed@example.com" }), "typed@example.com");
    assert.equal(await billEmailSent("", { billEmailFallback: "typed@example.com" }), "typed@example.com");
});

test("saved client email wins over the fallback", async () => {
    assert.equal(await billEmailSent("saved@example.com", { billEmailFallback: "typed@example.com" }), "saved@example.com");
});

test("no fallback and no saved email: no BillEmail (unchanged behaviour)", async () => {
    assert.equal(await billEmailSent(null), undefined);
});
