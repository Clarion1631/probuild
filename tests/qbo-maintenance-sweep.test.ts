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
function makePrisma(
    all: FakeRow[],
    opts: {
        onPage?: () => void;
        settings?: Map<string, string>;
        /** Estimates carrying an unfinished document-sync claim. */
        parkedEstimates?: Array<Record<string, any>>;
        /** Ids this run adopted, for the assertion. */
        adopted?: string[];
        /**
         * QuickBooks invoice ids of rows carrying `paylink-pending`, per rail.
         * Real rows, served by BOTH `findMany` and `count`, so the pay-link
         * sweep actually visits them and its counters mean what they say.
         */
        pendingPayLinks?: { milestone?: string[]; progressBilling?: string[] };
    } = {},
) {
    const seen: string[] = [];
    // Backs automationSettingCursorStore (src/lib/quickbooks-payments.ts) —
    // the same key/value table the sweep's resume cursor now persists to.
    // Pre-seed via `opts.settings`, or read it back afterward, to assert on
    // what a run stored for the NEXT invocation to pick up.
    const settingsStore = opts.settings ?? new Map<string, string>();
    const pending = (kind: "milestone" | "progressBilling", prefix: string) =>
        (opts.pendingPayLinks?.[kind] ?? []).map((qbInvoiceId, i) => ({
            id: `${prefix}-${String(i).padStart(4, "0")}`,
            qbInvoiceId,
            code: `${prefix.toUpperCase()}-${i}`,
            invoice: { code: `${prefix.toUpperCase()}-${i}` },
        }));
    const pendingPage = (list: any[], args: any) => {
        const where = args?.where ?? {};
        const matched = list.filter((r) => {
            if (where.id?.gt !== undefined && !(r.id > where.id.gt)) return false;
            if (where.id?.lt !== undefined && !(r.id < where.id.lt)) return false;
            return true;
        });
        return typeof args?.take === "number" ? matched.slice(0, args.take) : matched;
    };
    return {
        seen,
        settingsStore,
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
            automationSetting: {
                async findUnique(args: any) {
                    const value = settingsStore.get(args.where.key);
                    return value === undefined ? null : { value };
                },
                async upsert(args: any) {
                    settingsStore.set(args.where.key, args.create?.value ?? args.update?.value);
                    return { key: args.where.key, value: settingsStore.get(args.where.key) };
                },
            },
            automationEvent: { async create() { return {}; } },
            // Round 39: the maintenance pass also walks estimates and invoices
            // left claimed by an unfinished document sync. Empty by default, so
            // the existing cases are unchanged — but PRESENT, because a fake
            // that made that sweep throw would have turned it into a silent
            // no-op in every test here.
            estimate: {
                async findMany() { return (opts.parkedEstimates ?? []).map((r) => ({ ...r })); },
                async count() { return (opts.parkedEstimates ?? []).length; },
                async updateMany(args: any) {
                    const row = (opts.parkedEstimates ?? []).find((r) => r.id === args.where.id);
                    if (!row || row.qbSyncMarker !== args.where.qbSyncMarker) return { count: 0 };
                    Object.assign(row, args.data);
                    opts.adopted?.push(row.id);
                    return { count: 1 };
                },
            },
            invoice: {
                async findMany() { return []; },
                async count() { return 0; },
                async updateMany() { return { count: 0 }; },
            },
            progressBilling: {
                async findMany(args: any) {
                    return pendingPage(pending("progressBilling", "pb"), args).map((r) => ({ ...r }));
                },
                async count(args: any) {
                    return pendingPage(pending("progressBilling", "pb"), { where: args?.where }).length;
                },
                // Nothing clears here: these fixtures model rows QuickBooks
                // refuses per-invoice, which keep their marker by design.
                async updateMany() { return { count: 0 }; },
            },
            paymentSchedule: {
                async findMany(args: any) {
                    opts.onPage?.();
                    // The pay-link sweep's page, not the payment-options one.
                    if (args.select?.qbInvoiceId && args.where?.qbSyncError) {
                        return pendingPage(pending("milestone", "pl"), args).map((r) => ({ ...r }));
                    }
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
                    // Two different collections share this delegate: the
                    // payment-options sweep (unpaid, linked rows) and the
                    // pay-link sweep (rows carrying the pending marker). Only
                    // the marker filter identifies the second one, and
                    // answering it with `all.length` would report every unpaid
                    // milestone as an unresolved pay link.
                    if (args?.where?.qbSyncError !== undefined) {
                        return pendingPage(pending("milestone", "pl"), { where: args.where }).length;
                    }
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
    // Named as the CREDENTIAL failure it is, not as a generic outage. The
    // health digest counts only the reconnect family toward its "reconnect
    // QuickBooks" alert, so filing a 401 under "qbo-unavailable" made a broken
    // connection read like ordinary Intuit flakiness and nobody was told.
    assert.equal(body.reason, "qbo-auth");
    // Counted from the database after the last row it actually finished, so it
    // includes everything the cursor never reached.
    assert.equal(body.remaining, 37, `remaining was ${body.remaining}`);
});

// --- Codex gate (round 30): the cursor used to be re-seeded to null every ---
// --- invocation, so a stopped run re-walked the SAME leading rows on retry ---
// --- and anything past the cap was never reached — a starved tail, forever.

test("an outage persists the resume cursor for the NEXT invocation", async () => {
    const all = rows(40);
    const settings = new Map<string, string>();

    const { client: client1 } = makePrisma(all, { settings });
    await withEnvAndFakes(client1, makeFetch({ "qb-3": 401 }), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        await POST(request());
    });
    assert.equal(
        settings.get("qbo-maintenance.sync-payment-options.cursor"),
        "ps-0002",
        "resumes after the last row it actually finished, not from the top",
    );

    // A second, independent invocation — same persisted store, no more
    // failures — must resume straight into the tail rather than re-checking
    // rows 0-2 again.
    const { client: client2, seen } = makePrisma(all, { settings });
    const body = await withEnvAndFakes(client2, makeFetch(), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });
    assert.deepEqual(seen, all.slice(3).map((r) => r.id), "resumed into the tail, never re-checked the already-finished head");
    assert.equal(body.checked, 37);
    assert.equal(body.ok, true);
});

test("a run that walks the WHOLE collection resets the cursor to the top", async () => {
    // Otherwise the window would keep resuming from the tail end forever and
    // never come back around to re-verify the rows near the top.
    const all = rows(5);
    const settings = new Map<string, string>();
    const { client } = makePrisma(all, { settings });
    const body = await withEnvAndFakes(client, makeFetch(), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });
    assert.equal(body.ok, true);
    assert.equal(settings.get("qbo-maintenance.sync-payment-options.cursor"), "", "reset to the top for a fresh rolling window");
});

test("a run that starts with no stored cursor at all behaves exactly as before", async () => {
    // The fake Prisma's automationSetting table starts empty (get() -> null),
    // matching automationSettingCursorStore's own "never throws" contract —
    // this is the very first invocation ever, or a lost/expired setting.
    const all = rows(5);
    const { client, seen } = makePrisma(all);
    const body = await withEnvAndFakes(client, makeFetch(), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });
    assert.equal(body.checked, 5);
    assert.deepEqual(seen, all.map((r) => r.id));
});

test("round 35 gate: an invoice that has vanished from QuickBooks is outstanding work, not a clean pass", async () => {
    // This used to assert ok:true on the reading that a 404 is "a finding, not
    // a failure". But a LINKED invoice that is no longer in QuickBooks is not a
    // neutral observation: it is a bill the client can no longer pay, on a row
    // ProBuild still believes is outstanding — and the sweep returning ok:true
    // meant nobody was ever told. It is now named and counted.
    const all = rows(3);
    const { client } = makePrisma(all);
    const body = await withEnvAndFakes(client, makeFetch({ "qb-1": 404 }), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });

    // Still not a row FAILURE — the call succeeded and gave a real answer.
    assert.equal(body.failed, 0);
    assert.equal(body.ok, false, "a vanished invoice must not read as a clean sweep");
    assert.equal(body.missingInQbo, 1);
    assert.equal(body.reason, "qbo-invoice-missing", "actionable, and distinct from a row error");
    // The ids, not just the count: "one invoice vanished" is not actionable.
    assert.deepEqual(body.missingInQboRows, [{ qbInvoiceId: "qb-1", code: "INV-1" }]);
    assert.ok(body.results.some((r: any) => r.result === "not-found-in-qbo"));
});

test("round 35 gate: a sweep with nothing missing still reports ok", async () => {
    // The guard above must not make every clean run look broken.
    const all = rows(3);
    const { client } = makePrisma(all);
    const body = await withEnvAndFakes(client, makeFetch(), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });
    assert.equal(body.ok, true);
    assert.equal(body.missingInQbo, undefined);
    assert.equal(body.reason, undefined);
});

test("round 37 gate: a pay-link row left unresolved makes the run ok:false", async () => {
    // The false green this gate closes. The options loop finished cleanly and
    // the pay-link sweep returned without aborting, so every existing signal
    // said "clean" — while a milestone sat there LINKED to a QuickBooks invoice
    // with no pay link on it, which is a bill the client cannot pay.
    const all = rows(3);
    const { client } = makePrisma(all, { pendingPayLinks: { milestone: ["qb-pl-1"] } });
    // 404 on the pay-link read is a per-invoice refusal: the sweep visits the
    // row, deliberately leaves the marker, and moves its cursor past it.
    const body = await withEnvAndFakes(client, makeFetch({ "qb-pl-1": 404 }), async () => {
        const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
        return (await POST(request())).json();
    });

    assert.equal(body.failed, 0);
    assert.equal(body.missingInQbo, undefined);
    assert.equal(body.ok, false, "a row still carrying paylink-pending is outstanding work");
    assert.equal(body.reason, "pay-link-unresolved");
    assert.equal(body.payLinks.unresolved.milestone, 1);
    assert.equal(body.payLinks.unresolved.total, 1);
    // Nothing was UNVISITED: the sweep reached everything it could see. The two
    // counters answer different questions and must not be conflated — and it is
    // `unresolved`, not `unvisited`, that names this run.
    assert.equal(body.payLinks.unvisited.total, 0);
    assert.equal(body.payLinks.skipped, 1, "visited, and deliberately left pending");
});

test("round 37 gate: pay-link counters cover BOTH rails and sum", async () => {
    const all = rows(2);
    const { client } = makePrisma(all, {
        pendingPayLinks: { milestone: ["qb-pl-1", "qb-pl-2"], progressBilling: ["qb-pb-1", "qb-pb-2", "qb-pb-3"] },
    });
    const body = await withEnvAndFakes(
        client,
        makeFetch({ "qb-pl-1": 404, "qb-pl-2": 404, "qb-pb-1": 404, "qb-pb-2": 404, "qb-pb-3": 404 }),
        async () => {
            const { POST } = await import("../src/app/api/integrations/qbo-maintenance/route");
            return (await POST(request())).json();
        },
    );

    assert.equal(body.ok, false);
    assert.equal(body.payLinks.unresolved.milestone, 2);
    assert.equal(body.payLinks.unresolved.progressBilling, 3);
    assert.equal(body.payLinks.unresolved.total, 5);
});

// ─── Round 38 gate, finding 6: Break QB Link must not unlink before the delete ──

/**
 * The action cleared the local link FIRST and then attempted the QuickBooks
 * delete on an unbounded clock — a 45s token refresh followed by a 20s delete,
 * which cannot fit the 60s ceiling. So the platform could kill it mid-delete,
 * and by then the milestone was already unlinked and freely re-sendable: a
 * re-send racing a delete that may or may not have landed is how one milestone
 * ends up with two collectible invoices.
 *
 * The link now survives until the delete is CONFIRMED, and a row left
 * `pending-deletion` is finished by this sweep rather than by nobody.
 */
function pendingDeletionDb(rows: Array<{ id: string; qbInvoiceId: string }>) {
    const live = [...rows];
    return {
        db: {
            paymentSchedule: {
                async findMany() { return live.map((r) => ({ ...r })); },
                async count() { return live.length; },
            },
        },
        live,
    };
}

test("round 39: `false` from the delete is CONFIRMED ABSENCE, so the row still unlinks", async () => {
    // deleteQBInvoice returns false ONLY for a 404 / read-miss, and THROWS for
    // a real refusal. Reading false as "still there" left an invoice somebody
    // had already deleted by hand parked forever: the sweep asked QuickBooks to
    // remove a document that was gone, got the honest answer, and concluded it
    // had failed. Both values mean the remote document is gone.
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const { db, live } = pendingDeletionDb([
        { id: "ps-1", qbInvoiceId: "qb-1" },   // deleted just now
        { id: "ps-2", qbInvoiceId: "qb-2" },   // already absent
    ]);
    const unlinked: string[] = [];

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        {
            db: db as any,
            deleteInvoice: async (_t, qbId) => qbId === "qb-1",
            unlink: async (id) => {
                unlinked.push(id);
                live.splice(live.findIndex((r) => r.id === id), 1);
                return true;
            },
        },
    );

    assert.deepEqual(unlinked, ["ps-1", "ps-2"], "BOTH are gone remotely, so both unlink");
    assert.equal(res.checked, 2);
    assert.equal(res.finished, 2);
    assert.equal(res.stillPending, 0);
    assert.equal(res.reason, null);
});

test("round 39: a REFUSAL throws, and that row stays linked and parked", async () => {
    // The mutation control for the test above. If every delete outcome unlinked,
    // that test would pass while an invoice with a payment attached — the case
    // QuickBooks genuinely refuses — silently lost its link.
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const { db, live } = pendingDeletionDb([
        { id: "ps-1", qbInvoiceId: "qb-1" },
        { id: "ps-2", qbInvoiceId: "qb-2" },
    ]);
    const unlinked: string[] = [];

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        {
            db: db as any,
            deleteInvoice: async (_t, qbId) => {
                if (qbId === "qb-2") throw new Error("QuickBooks refused: payment attached");
                return true;
            },
            unlink: async (id) => {
                unlinked.push(id);
                live.splice(live.findIndex((r) => r.id === id), 1);
                return true;
            },
        },
    );

    assert.deepEqual(unlinked, ["ps-1"], "the refused one must keep its link");
    assert.equal(res.finished, 1);
    assert.equal(res.stillPending, 1, "and it is reported, so the run is not clean");
});

test("round 38: the deadline stops the sweep, and the rows it never reached stay linked", async () => {
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const { db, live } = pendingDeletionDb([
        { id: "ps-1", qbInvoiceId: "qb-1" },
        { id: "ps-2", qbInvoiceId: "qb-2" },
        { id: "ps-3", qbInvoiceId: "qb-3" },
    ]);
    const deleted: string[] = [];
    // Already spent: the wall is hit before the first row.
    const spent = createRouteDeadline(1_000, Date.now() - 5_000);

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        spent,
        {
            db: db as any,
            deleteInvoice: async (_t, qbId) => { deleted.push(qbId); return true; },
            unlink: async () => true,
        },
    );

    assert.deepEqual(deleted, [], "out of budget is a clean stop, not a half-finished delete");
    assert.equal(res.reason, "budget-exhausted");
    assert.equal(res.stillPending, 3, "every row is still linked — none can be re-sent");
    assert.equal(live.length, 3);
});

test("round 38: Break QB Link deletes BEFORE it unlinks, under one shared deadline", async () => {
    // A source tripwire, because the ORDER is the invariant and it is invisible
    // to any assertion about the outcome: an action that unlinked first and
    // deleted second would look identical on the happy path and only diverge
    // when the delete failed — which is precisely the case that shipped.
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/actions.ts", "utf8"));
    const start = src.indexOf("export async function breakQBInvoiceLink");
    assert.ok(start > -1);
    const fn = src.slice(start, src.indexOf("\nexport ", start + 10));

    const marks = fn.indexOf("PENDING_DELETION_MARKER");
    const del = fn.indexOf("deleteQBInvoice(tokens");
    const unlink = fn.indexOf("claimQBInvoiceUnlink(prisma, schedule.id, schedule.qbInvoiceId)");
    assert.ok(marks > -1, "the intent must be recorded durably before the remote call");
    assert.ok(del > -1 && unlink > -1);
    assert.ok(marks < del, "mark the row BEFORE touching QuickBooks");
    assert.ok(del < fn.indexOf("clearedAfterDelete"), "and only unlink once the delete came back confirmed");

    // One budget, threaded into BOTH remote calls. Either one unbounded puts
    // the pair back over the ceiling.
    assert.match(fn, /createRouteDeadline\(BREAK_QB_LINK_BUDGET_MS\)/);
    assert.match(fn, /getFreshQBTokens\(deadline\)/);
    assert.match(fn, /deleteQBInvoice\(tokens, schedule\.qbInvoiceId, deadline\)/);
});

// ─── Round 38 gate, finding 8: a no-progress abort must keep its cursor ────

test("round 38: a resumed run that aborts before finishing a row keeps the stored cursor", async () => {
    // `lastCompletedId` started at null even when a cursor had been loaded, so
    // an abort on the very first row wrote "" — "start from the top" — and threw
    // away a checkpoint that was still good. The next run then re-walked the
    // same leading rows and aborted in the same place: the tail starved
    // forever, which is the exact failure the cursor exists to prevent.
    const src = await import("node:fs").then((fs) =>
        fs.readFileSync("src/app/api/integrations/qbo-maintenance/route.ts", "utf8"));
    assert.match(src, /let checkpoint: string \| null = cursor;/,
        "the checkpoint is SEEDED from what this run inherited");
    assert.ok(!/let lastCompletedId: string \| null = null;/.test(src),
        "and the old null-seeded variable is gone, not merely shadowed");
    assert.match(src, /automationSettingCursorStore\.set\(SWEEP_CURSOR_KEY, abortedReason \? \(checkpoint \?\? ""\) : ""\)/);
    assert.match(src, /where: checkpoint \? \{ \.\.\.scheduleWhere, id: \{ gt: checkpoint \} \} : scheduleWhere,/,
        "and `remaining` is measured from the retained checkpoint");
});

// ─── Round 39 gate, finding 4: parked document syncs are a work queue ───

test("round 39: the maintenance pass recovers an estimate left claimed by an unfinished sync", async () => {
    // Until this existed, a record claimed by a create whose outcome was never
    // learned was invisible: nothing read the column, so it sat until somebody
    // happened to press Sync again. That is precisely where a duplicate hides.
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    const parked = [
        { id: "est-1", code: "EST-00001", privateNote: "Kitchen", marker: "ambiguous-create:n1", kind: "estimate" as const },
        { id: "est-2", code: "EST-00002", privateNote: "Bath", marker: "ambiguous-create:n2", kind: "estimate" as const },
    ];
    const adopted: Array<[string, string]> = [];
    let remaining = 2;

    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            listParked: async () => parked,
            // EST-00001 is in QuickBooks; EST-00002 is not, and the sweep must
            // leave that one alone rather than creating it unattended.
            probe: (async (_t: unknown, input: { code: string }) =>
                input.code === "EST-00001"
                    ? { state: "found", qbId: "qb-est-real" }
                    : { state: "absent" }) as any,
            adopt: async (row, qbId) => { adopted.push([row.id, qbId]); remaining--; return 1; },
            countParked: async () => remaining,
        },
    );

    assert.equal(res.checked, 2);
    assert.equal(res.recovered, 1);
    assert.deepEqual(adopted, [["est-1", "qb-est-real"]]);
    assert.equal(res.stillParked, 1, "the absent one is still claimed, and is reported");
});

test("round 39: the sweep NEVER adopts on an unanswered question", async () => {
    // The mutation control. "Could not ask" must not read as "there is none",
    // and it must certainly not adopt: either would be a guess about a document
    // that decides whether a client gets billed twice.
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    let adopts = 0;
    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            listParked: async () => [
                { id: "inv-1", code: "INV-00001", privateNote: null, marker: "create-in-flight:n1", kind: "invoice" as const },
            ],
            probe: (async () => ({ state: "unknown", reason: "QuickBooks is unavailable" })) as any,
            adopt: async () => { adopts++; return 1; },
            countParked: async () => 1,
        },
    );
    assert.equal(adopts, 0);
    assert.equal(res.recovered, 0);
    assert.equal(res.stillParked, 1);
    assert.match(String(res.reason), /unavailable/);
});

// ─── Round 39 gate, finding 2: Break QB Link had no project scope ───

/**
 * `assertInvoicePermission` proves the caller may work with invoices SOMEWHERE.
 * It says nothing about THIS milestone project, and nothing else in the action
 * did either: a FINANCE user scoped to one job could unlink — and with
 * deleteInQBO, destroy the QuickBooks invoice for — any milestone in the
 * company by id alone. Same hole and same fix as the estimate IDOR (#333).
 *
 * A source tripwire rather than a request-level test: actions.ts pulls in most
 * of the app, and what has to be true here is an ORDERING — the scope check
 * precedes every mutation, including the ambiguous-create resolver branch,
 * which writes too. An outcome assertion on the happy path cannot see that.
 */
test("round 39: breakQBInvoiceLink checks project scope before ANY mutation", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/actions.ts", "utf8"));
    const start = src.indexOf("export async function breakQBInvoiceLink");
    assert.ok(start > -1);
    const fn = src.slice(start, src.indexOf("\nexport ", start + 10));

    const scope = fn.indexOf("canAccessProject(user, schedule.invoice.projectId)");
    assert.ok(scope > -1, "the horizontal check must exist at all");

    // Every write in this function, local or remote, must come after it.
    for (const mutation of [
        "resolveAmbiguousInvoiceCreateCore(",   // writes: adopts or releases the row
        "PENDING_DELETION_MARKER",              // writes: claims the delete intent
        "deleteQBInvoice(tokens",               // remote destructive write
        "claimQBInvoiceUnlink(prisma",          // local unlink
    ]) {
        const at = fn.indexOf(mutation);
        assert.ok(at > -1, `${mutation} not found — has the action been restructured?`);
        assert.ok(at > scope, `${mutation} runs BEFORE the project-scope check`);
    }

    // FINANCE is not exempt: the check is the shared helper, not a role test.
    assert.doesNotMatch(fn.slice(0, scope), /role === "FINANCE"|isAdminOrManager/,
        "scope must not be short-circuited by a role before it is checked");
});

test("round 39: canAccessProject really does refuse a scoped user on another project", async () => {
    // The tripwire above proves the ORDER; this proves the PREDICATE it calls
    // actually says no. Without this, a check placed correctly but calling
    // something permissive would pass both.
    const { canAccessProject } = await import("../src/lib/access-rules");
    const scoped = {
        id: "u1", role: "FINANCE", permissions: null,
        projectAccess: [], assignedProjects: [],
    } as any;
    assert.equal(canAccessProject(scoped, "proj-not-theirs"), false,
        "holding the invoices permission is not access to THIS project");
    assert.equal(canAccessProject({ ...scoped, role: "ADMIN" }, "proj-not-theirs"), true,
        "and an ADMIN still passes, so the guard is not simply always-false");
});

// ─── Round 39 gate, finding 3: the delete result read backwards ───

test("round 39: every deleteQBInvoice caller treats `false` as confirmed absence", async () => {
    // The contract is stated once, at the source, and three call sites read it
    // the other way round. A tripwire because the failure only shows when the
    // invoice is ALREADY gone — the happy path looks identical either way.
    const fs = await import("node:fs");
    const contract = fs.readFileSync("src/lib/quickbooks.ts", "utf8");
    assert.match(contract, /CONFIRMED ABSENCE/,
        "deleteQBInvoice must say what its return value means");

    for (const [file, marker] of [
        ["src/lib/actions.ts", "await deleteQBInvoice(tokens, schedule.qbInvoiceId, deadline);"],
        ["src/lib/quickbooks-payments.ts", "await remove(tokens, row.qbInvoiceId as string, deadline);"],
        ["src/lib/billing-core.ts", "await deleteQBInvoice(tokens, row.oldQbInvoiceId, qbDeadline);"],
    ] as const) {
        const src = fs.readFileSync(file, "utf8");
        assert.ok(src.includes(marker), `${file}: the call must not branch on the boolean`);
    }
    // ...and none of them still tests it.
    const payments = fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8");
    assert.doesNotMatch(payments, /if \(!deleted\)/, "a `false` branch is the bug this closes");
    // Scoped to breakQBInvoiceLink: an unrelated `deleted` flag elsewhere in
    // actions.ts (a selections decision) is not this contract.
    const actions = fs.readFileSync("src/lib/actions.ts", "utf8");
    const breakStart = actions.indexOf("export async function breakQBInvoiceLink");
    const breakFn = actions.slice(breakStart, actions.indexOf("\nexport ", breakStart + 10));
    assert.doesNotMatch(breakFn, /if \(!deleted\)/, "a false-branch is the bug this closes");
    assert.doesNotMatch(breakFn, /let deleted/, "and the boolean is not captured at all any more");
});
