/**
 * The maintenance sweep has to be honest about what it did NOT do.
 *
 * Codex gate: it read one `take: 200` slice and reported `ok` whenever it did
 * not abort. Two ways that lied. The 201st unpaid invoice was never looked at,
 * run after run, and the response still said "checked 200, ok". And a row that
 * failed its own update was recorded in `results` and then reported inside a
 * clean pass.
 *
 * It now pages by id with a cursor, counts what is left when it stops, and
 * `ok` is false if anything failed or anything remains.
 *
 * Driven end to end: the real route handler, a fake Prisma (src/lib/prisma.ts
 * reads globalThis.prisma before building a client) and a fake QuickBooks over
 * global fetch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { encryptObject } from "../src/lib/crypto";

const INGEST_SECRET = "sweep-ingest-secret";

interface FakeRow {
    id: string;
    qbInvoiceId: string;
    name: string;
    invoice: { code: string };
}

function rows(count: number, prefix = "ps"): FakeRow[] {
    // Ids are zero-padded so lexical order (what the cursor pages by) matches
    // the order they were made in.
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${String(i).padStart(4, "0")}`,
        qbInvoiceId: `qb-${i}`,
        name: `Milestone ${i}`,
        invoice: { code: `INV-${i}` },
    }));
}

/** Paging semantics Prisma gives us: orderBy id asc, cursor + skip:1, take. */
function makePrisma(all: FakeRow[], opts: { onPage?: () => void } = {}) {
    const seen: string[] = [];
    return {
        seen,
        client: {
            integration: {
                async findUnique() {
                    return {
                        settings: encryptObject({
                            quickbooks: {
                                connected: true,
                                accessToken: "a",
                                refreshToken: "r",
                                realmId: "realm-1",
                                serviceItemId: "7",
                            },
                        }),
                    };
                },
                async upsert() {
                    return {};
                },
            },
            automationEvent: { async create() { return {}; } },
            progressBilling: { async findMany() { return []; }, async updateMany() { return { count: 0 }; } },
            paymentSchedule: {
                async findMany(args: any) {
                    opts.onPage?.();
                    if (args.select?.qbInvoiceId && args.where?.qbSyncError) return []; // the pay-link sweep
                    let list = all;
                    if (args.cursor?.id) {
                        const at = all.findIndex((r) => r.id === args.cursor.id);
                        list = all.slice(at + 1);
                    }
                    const page = list.slice(0, args.take ?? list.length);
                    for (const r of page) seen.push(r.id);
                    return page.map((r) => ({ ...r }));
                },
                async count(args: any) {
                    const gt = args?.where?.id?.gt;
                    return gt ? all.filter((r) => r.id > gt).length : all.length;
                },
                async updateMany() {
                    return { count: 0 };
                },
            },
        },
    };
}

/** A QuickBooks that answers the invoice read; `fail` ids answer with a status. */
function makeFetch(fail: Record<string, number> = {}) {
    return (async (url: string | URL) => {
        const href = String(url);
        const id = href.match(/\/invoice\/([^?]+)/)?.[1] ?? "";
        const status = fail[id];
        if (status) {
            return new Response(JSON.stringify({ Fault: {} }), { status, headers: { "content-type": "application/json" } });
        }
        return new Response(
            JSON.stringify({
                Invoice: { Id: id, SyncToken: "0", AllowOnlineCreditCardPayment: true, AllowOnlineACHPayment: true, Balance: 10 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as unknown as typeof fetch;
}

async function withEnvAndFakes<T>(
    prismaClient: unknown,
    fetchImpl: typeof fetch,
    run: () => Promise<T>,
): Promise<T> {
    const prev = {
        prisma: (globalThis as any).prisma,
        fetch: globalThis.fetch,
        secret: process.env.RECEIPT_INGEST_SECRET,
        nextauth: process.env.NEXTAUTH_SECRET,
        mock: process.env.E2E_QBO_MOCK,
        playwright: process.env.PLAYWRIGHT_TEST_SECRET,
        vercel: process.env.VERCEL,
    };
    (globalThis as any).prisma = prismaClient;
    globalThis.fetch = fetchImpl;
    process.env.RECEIPT_INGEST_SECRET = INGEST_SECRET;
    process.env.NEXTAUTH_SECRET = "test-nextauth-secret";
    // The existing QBO mock gate: returns canned tokens with NO network I/O, so
    // the token refresh is not part of what these tests are exercising.
    process.env.E2E_QBO_MOCK = "1";
    process.env.PLAYWRIGHT_TEST_SECRET = "pw";
    delete process.env.VERCEL;
    try {
        return await run();
    } finally {
        (globalThis as any).prisma = prev.prisma;
        globalThis.fetch = prev.fetch;
        for (const [key, value] of Object.entries({
            RECEIPT_INGEST_SECRET: prev.secret,
            NEXTAUTH_SECRET: prev.nextauth,
            E2E_QBO_MOCK: prev.mock,
            PLAYWRIGHT_TEST_SECRET: prev.playwright,
            VERCEL: prev.vercel,
        })) {
            if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
            else (process.env as Record<string, string>)[key] = value;
        }
    }
}

function request() {
    return new Request("https://probuild.test/api/integrations/qbo-maintenance", {
        method: "POST",
        body: JSON.stringify({ action: "sync-payment-options" }),
        headers: { "content-type": "application/json", "x-ingest-key": INGEST_SECRET },
    });
}

test("the sweep pages past the old 200-row cap instead of silently stopping", async () => {
    const all = rows(250);
    const { client, seen } = makePrisma(all);
    const body = await withEnvAndFakes(client, makeFetch(), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });

    assert.equal(body.checked, 250, "every unpaid invoice was looked at");
    assert.equal(seen.length, 250);
    assert.equal(new Set(seen).size, 250, "and each exactly once");
    assert.equal(body.ok, true);
    assert.equal(body.truncated, undefined);
    assert.equal(body.failed, 0);
});

test("a row that failed makes the whole run ok:false", async () => {
    // It used to be recorded in `results` and then reported inside a clean pass,
    // so nobody reading `ok` ever learned about it.
    const all = rows(5);
    const { client } = makePrisma(all);
    const body = await withEnvAndFakes(client, makeFetch({ "qb-2": 400 }), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });

    assert.equal(body.checked, 5, "the loop still finished the other rows");
    assert.equal(body.failed, 1);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "row-errors");
    assert.ok(body.results.some((r: any) => r.result.startsWith("error:")));
});

test("stopping early reports truncated + how many are left", async () => {
    // 401 is connection-level: the same credential fails for every remaining
    // row, so the sweep stops. What it must not do is report a clean pass.
    const all = rows(40);
    const failing: Record<string, number> = { "qb-3": 401 };
    const { client } = makePrisma(all);
    const body = await withEnvAndFakes(client, makeFetch(failing), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });

    assert.equal(body.ok, false);
    assert.equal(body.truncated, true);
    assert.equal(body.retry, true);
    assert.equal(body.reason, "qbo-unavailable");
    // Counted from the database after the last row it actually finished, so it
    // includes everything the cursor never reached.
    assert.equal(body.remaining, 37, `remaining was ${body.remaining}`);
});

test("a 404 row is a finding, not a failure", async () => {
    // "not-found-in-qbo" is a real answer about that invoice and must not make
    // the sweep look broken.
    const all = rows(3);
    const { client } = makePrisma(all);
    const body = await withEnvAndFakes(client, makeFetch({ "qb-1": 404 }), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });

    assert.equal(body.failed, 0);
    assert.equal(body.ok, true);
    assert.ok(body.results.some((r: any) => r.result === "not-found-in-qbo"));
});
