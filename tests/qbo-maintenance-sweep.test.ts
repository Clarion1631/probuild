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
            // The marker the sweep selects on. Present because the sweep now
            // reads it back to decide the NEXT state (attempt count, or the
            // durable paylink-missing), and pins it in the CAS.
            qbSyncError: "paylink-pending",
            invoice: { code: `${prefix.toUpperCase()}-${i}` },
        }));
    const pendingPage = (list: any[], args: any) => {
        const where = args?.where ?? {};
        const matched = list.filter((r) => {
            // The sweep selects `{ OR: payLinkPendingWhere() }`; every fixture
            // row carries the bare marker, so the OR is satisfied by the first
            // clause. Honoured explicitly rather than ignored, so a where this
            // fake does not understand cannot silently match everything.
            if (Array.isArray(where.OR)) {
                const ok = where.OR.some((c: any) => {
                    const cond = c.qbSyncError;
                    if (typeof cond === "string") return r.qbSyncError === cond;
                    if (cond && typeof cond.startsWith === "string") {
                        return typeof r.qbSyncError === "string" && r.qbSyncError.startsWith(cond.startsWith);
                    }
                    return false;
                });
                if (!ok) return false;
            }
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
                    if (args.select?.qbInvoiceId && (args.where?.qbSyncError !== undefined || Array.isArray(args.where?.OR))) {
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
                    if (args?.where?.qbSyncError !== undefined || Array.isArray(args?.where?.OR)) {
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
/**
 * The PaymentSchedule table as the deletion sweep really uses it.
 *
 * Round 49 (P0) added a CLAIM before the irreversible delete: a short
 * transaction, under the invoice money lock, that compare-and-sets the row
 * from `{ status: Pending, qbSyncError: <observed> }` to a claim marker. So
 * this fake now has to model a transaction, an `updateMany` that honours its
 * WHERE, and a `count` that answers about ONE row rather than the whole
 * table — a fake without them would make every claim fail and the tests would
 * pass against a sweep that never deleted anything at all.
 *
 * `onClaimed` fires immediately after a claim commits: that is the window a
 * settlement lands in, and the only place the post-claim race can be staged.
 */
function pendingDeletionDb(
    rows: Array<{ id: string; qbInvoiceId: string; status?: string; qbSyncError?: string | null; invoiceId?: string | null }>,
    opts: { onClaimed?: (id: string) => void } = {},
) {
    const live = rows.map((r) => ({
        status: "Pending",
        qbSyncError: "pending-deletion",
        invoiceId: "inv-1",
        ...r,
    }));
    const matches = (row: any, where: any): boolean =>
        Object.entries(where ?? {}).every(([k, v]) => {
            // A CLAIMED row is still a pending deletion, so the sweep selects
            // with an OR. A fake that ignored it would hand back every row.
            if (k === "OR") return (v as any[]).some((clause) => matches(row, clause));
            if (v !== null && typeof v === "object") {
                if ("startsWith" in (v as any)) {
                    return typeof row[k] === "string" && row[k].startsWith((v as any).startsWith);
                }
                if ("in" in (v as any)) return (v as any).in.includes(row[k]);
                if ("not" in (v as any)) return row[k] !== (v as any).not;
                if ("gt" in (v as any)) return row[k] > (v as any).gt;
                throw new Error(`unsupported condition on ${k}: ${JSON.stringify(v)}`);
            }
            return row[k] === v;
        });
    const table = {
        async findMany(args: any) {
            const hit = live.filter((r) => matches(r, args?.where)).map((r) => ({ ...r }));
            return typeof args?.take === "number" ? hit.slice(0, args.take) : hit;
        },
        async count(args: any) {
            return live.filter((r) => matches(r, args?.where)).length;
        },
        async updateMany(args: any) {
            const hit = live.filter((r) => matches(r, args?.where));
            for (const r of hit) Object.assign(r, args.data);
            if (hit.length && String(args.data?.qbSyncError ?? "").startsWith("pending-deletion:claimed:")) {
                opts.onClaimed?.(hit[0].id);
            }
            return { count: hit.length };
        },
    };
    const db = {
        paymentSchedule: table,
        // The claim takes the invoice lock; the fake records that it was asked
        // for one rather than pretending locks do not exist.
        locks: [] as string[],
        async $queryRaw(strings: TemplateStringsArray, ...values: any[]) {
            (db as any).locks.push(`${strings.join("?")}|${values.join(",")}`);
            return [];
        },
        async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
            return fn(db);
        },
    };
    return { db, live };
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
    const unlink = fn.indexOf("claimQBInvoiceUnlink(");
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

test("round 40: the document sweep pages by cursor, so an unresolvable head row cannot starve the rest", async () => {
    // The first cut took the first 25 rows of each rail every run. A row that
    // cannot be resolved stays eligible, so it was re-probed at the head of
    // every run forever and everything behind it was never reached —
    // head-of-line starvation, in a queue whose whole purpose is to finish work
    // nobody is watching.
    const { sweepPendingDocumentSyncs, DOCUMENT_SYNC_CURSOR_KEYS } =
        await import("../src/lib/qbo-document-sync");

    // Three estimates. The FIRST can never be resolved (QuickBooks will not
    // answer about it); the other two are sitting in QuickBooks.
    const rows = [
        { id: "est-1", marker: "ambiguous-create:@1|EST-1|note", kind: "estimate" as const , clientId: "cli-1" },
        { id: "est-2", marker: "ambiguous-create:@1|EST-2|note", kind: "estimate" as const , clientId: "cli-1" },
        { id: "est-3", marker: "ambiguous-create:@1|EST-3|note", kind: "estimate" as const , clientId: "cli-1" },
    ];
    const live = new Map(rows.map((r) => [r.id, r]));
    const kv = new Map<string, string>();
    const cursors = {
        get: async (k: string) => kv.get(k) ?? null,
        set: async (k: string, v: string) => { kv.set(k, v); },
    };
    const adopted: string[] = [];

    const run = (take: number) => sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            cursors,
            railFirst: "estimate",
            // ONE row per run, so "did the cursor move" is the only thing that
            // decides whether row 2 is ever seen.
            pageSize: take,
            listParked: async (rail, after) => {
                if (rail !== "estimate") return [];
                const remaining = [...live.values()].filter((r) => !after || r.id > after);
                return remaining.slice(0, take);
            },
            probe: (async (_t: unknown, input: { marker: string }) =>
                input.marker.includes("EST-1")
                    ? { state: "unknown", reason: "QuickBooks is unavailable" }
                    : { state: "found", qbId: `qb-${input.marker}` }) as any,
            adopt: async (row) => { adopted.push(row.id); live.delete(row.id); return 1; },
            countParked: async () => live.size,
        },
    );

    await run(1);
    assert.deepEqual(adopted, [], "the head row could not be resolved");
    assert.equal(kv.get(DOCUMENT_SYNC_CURSOR_KEYS.estimate), "est-1",
        "and the cursor still advanced PAST it — that is the whole fix");

    await run(1);
    assert.deepEqual(adopted, ["est-2"], "the second run reaches the row behind the blocked one");

    await run(1);
    assert.deepEqual(adopted, ["est-2", "est-3"]);
});

test("round 40: the document sweep wraps back to the head once its tail drains", async () => {
    // Without a bounded wrap the rows BEFORE the cursor are stranded until
    // somebody resets it by hand — the mirror image of the starvation above.
    const { sweepPendingDocumentSyncs, DOCUMENT_SYNC_CURSOR_KEYS } =
        await import("../src/lib/qbo-document-sync");
    const kv = new Map<string, string>([[DOCUMENT_SYNC_CURSOR_KEYS.estimate, "est-9"]]);
    const seen: string[] = [];

    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            cursors: {
                get: async (k: string) => kv.get(k) ?? null,
                set: async (k: string, v: string) => { kv.set(k, v); },
            },
            railFirst: "estimate",
            listParked: async (rail, after) => {
                if (rail !== "estimate") return [];
                // Nothing after est-9; one row at the head.
                if (after) return [];
                return seen.length
                    ? []
                    : [{ id: "est-1", marker: "ambiguous-create:@1|EST-1|note", kind: "estimate" as const , clientId: "cli-1" }];
            },
            probe: (async () => ({ state: "absent" })) as any,
            adopt: async () => 1,
            countParked: async () => 1,
        },
    );
    void seen;
    assert.equal(res.checked, 1, "the wrap really did reach the head row");
    assert.equal(kv.get(DOCUMENT_SYNC_CURSOR_KEYS.estimate), "est-1");
});

test("round 49: a run that started at the head never wraps, so no row is probed twice", async () => {
    // The wrap was decided from `cursor !== null`, and `cursor` is ALSO non-null
    // the moment the row loop has stepped past a row — it assigns `cursor =
    // row.id` as it goes. So a run that began at the head (no stored cursor),
    // walked a short page, and then saw an empty next page concluded it must
    // have "started in the tail", wrapped back to null, and listed and probed
    // the very rows it had just finished. Every parked row on the rail got two
    // QuickBooks calls instead of one, `checked` and `unresolved` were reported
    // at double their true value, and the route budget the pagination exists to
    // protect was spent re-doing work — worse the emptier the rail, because a
    // short page is exactly what a nearly-drained rail returns.
    //
    // Three rows, a page size far larger than that, and nothing stored: the run
    // must touch each row EXACTLY once.
    const { sweepPendingDocumentSyncs, DOCUMENT_SYNC_CURSOR_KEYS } =
        await import("../src/lib/qbo-document-sync");
    const rows = [
        { id: "est-1", marker: "ambiguous-create:@1|EST-1|note", kind: "estimate" as const , clientId: "cli-1" },
        { id: "est-2", marker: "ambiguous-create:@1|EST-2|note", kind: "estimate" as const , clientId: "cli-1" },
        { id: "est-3", marker: "ambiguous-create:@1|EST-3|note", kind: "estimate" as const , clientId: "cli-1" },
    ];
    const kv = new Map<string, string>();
    const probes: string[] = [];

    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            cursors: {
                get: async (k: string) => kv.get(k) ?? null,
                set: async (k: string, v: string) => { kv.set(k, v); },
            },
            railFirst: "estimate",
            pageSize: 25,
            listParked: async (rail, after, limit) => {
                if (rail !== "estimate") return [];
                return rows.filter((r) => !after || r.id > after).slice(0, limit);
            },
            // `absent` keeps every row eligible, which is what makes a second
            // pass over them visible here: nothing is consumed, so a wrap can
            // hand the same three rows straight back.
            probe: (async (_t: unknown, input: { marker: string }) => {
                probes.push(input.marker);
                return { state: "absent" };
            }) as any,
            adopt: async () => 1,
            countParked: async () => rows.length,
        },
    );

    assert.deepEqual(probes, rows.map((r) => r.marker),
        "each parked row is asked about ONCE per run, in order");
    assert.equal(probes.length, rows.length, "no row is re-probed by a bogus wrap");
    assert.equal(res.checked, 3, "and the tally counts rows, not visits");
    assert.equal(res.rails.estimate.checked, 3);
    assert.equal(kv.get(DOCUMENT_SYNC_CURSOR_KEYS.estimate), "est-3",
        "the checkpoint still lands past the last row visited, unchanged by this fix");
});

test("round 40: the sweep NEVER adopts on an unanswered question", async () => {
    // The mutation control. "Could not ask" must not read as "there is none",
    // and it must certainly not adopt: either would be a guess about a document
    // that decides whether a client gets billed twice.
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    let adopts = 0;
    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            railFirst: "invoice",
            // One row is the whole rail, so the run stops rather than wrapping
            // back over the row it just probed.
            pageSize: 1,
            listParked: async (rail, after) =>
                rail === "invoice" && !after
                    ? [{ id: "inv-1", marker: "create-in-flight:@1|INV-1|note", kind: "invoice" as const , clientId: "cli-1" }]
                    : [],
            probe: (async () => ({ state: "unknown", reason: "QuickBooks is unavailable" })) as any,
            adopt: async () => { adopts++; return 1; },
            countParked: async () => 1,
        },
    );
    assert.equal(adopts, 0);
    assert.equal(res.recovered, 0);
    assert.equal(res.stillParked, 1);
    // Round 42: a per-row refusal is recorded against its OWN rail and does
    // not become a run-wide stop — setting `reason` here made the outer loop
    // skip the other rail entirely.
    assert.equal(res.reason, null, "not a shared stop");
    assert.match(String(res.rails.invoice.note), /unavailable/);
    assert.equal(res.rails.invoice.unresolved, 1);
});

test("round 40: the deletion sweep pages by cursor too", async () => {
    // Same failure, same fix. QuickBooks refuses to delete an invoice with a
    // payment attached, and that row keeps its marker by design — so under a
    // fixed "first 50" it was retried at the head of every run and the rows
    // behind it were never touched.
    const { sweepPendingDeletions, PENDING_DELETION_CURSOR_KEY } =
        await import("../src/lib/quickbooks-payments");
    const kv = new Map<string, string>();
    const cursorStore = {
        get: async (k: string) => kv.get(k) ?? null,
        set: async (k: string, v: string) => { kv.set(k, v); },
    };
    const unlinked: string[] = [];
    // The shared fake, because the sweep now CLAIMS a row (a transaction, a
    // lock and a pinned compare-and-set) before the irreversible delete. A
    // hand-rolled table without those makes every claim fail, and the test
    // would then pass against a sweep that deleted nothing at all.
    const { db, live } = pendingDeletionDb([
        { id: "ps-1", qbInvoiceId: "qb-1" },   // QuickBooks always refuses this one
        { id: "ps-2", qbInvoiceId: "qb-2" },
    ]);
    const opts = {
        db: db as any,
        cursorStore: cursorStore as any,
        deleteInvoice: async (_t: unknown, qbId: string) => {
            if (qbId === "qb-1") throw new Error("QuickBooks refused: payment attached");
            return true;
        },
        unlink: async (id: string) => {
            unlinked.push(id);
            live.splice(live.findIndex((r) => r.id === id), 1);
            return true;
        },
    };
    const tokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };

    const first = await sweepPendingDeletions(tokens, undefined, opts);
    assert.deepEqual(unlinked, ["ps-2"], "the blocked head row does not stop the one behind it");
    assert.equal(kv.get(PENDING_DELETION_CURSOR_KEY), "ps-2", "the cursor advanced past BOTH");
    assert.equal(first.stillPending, 1);

    // Next run: the tail is empty, so it wraps and re-tries the blocked row
    // rather than stranding it behind its own cursor forever.
    const second = await sweepPendingDeletions(tokens, undefined, opts);
    assert.equal(second.checked, 1, "the wrap brought the head row back into view");
    assert.equal(second.stillPending, 1, "and it is still reported, so the run is not clean");
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
        "claimQBInvoiceUnlink(",                // local unlink
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

    // Round 40 gate, finding 1: a local-only unlink must REFUSE while somebody
    // else has a remote delete in flight, and every unlink must pin the marker
    // it observed rather than only the link.
    assert.match(breakFn, /isPendingDeletion\(schedule\.qbSyncError\)/,
        "the local-only path must refuse a row already being deleted remotely");
    assert.match(breakFn, /schedule\.qbInvoiceId, schedule\.qbSyncError/,
        "and pin the marker it read");
    assert.match(breakFn, /schedule\.qbInvoiceId, PENDING_DELETION_MARKER/,
        "while the post-delete unlink pins the one it wrote");
});

// ─── Round 40 gate, finding 3: adoption must be PROVABLE ───

/**
 * The durable claim used to store a bare nonce, and recovery accepted a single
 * DocNumber match (plus, on the estimate rail, the record CURRENT title). But
 * QuickBooks does not enforce DocNumber uniqueness, the invoice rail sent no
 * PrivateNote at all, and neither rail looked at the customer or the total it
 * already had in hand. A hand-created document sharing the code, or one in
 * another company entirely, would have been adopted and linked.
 *
 * The claim now records what was SENT — realm, customer, DocNumber, the canonical
 * PrivateNote marker and the expected total — and every one has to agree.
 */
async function probeWith(opts: {
    marker: string;
    realmId?: string;
    // The shape the DocNumber lookup really returns. `docNumber` is part of
    // the acceptance rule as of round 48, so a fixture that cannot express it
    // could not describe a candidate the probe would accept.
    found?: Array<Partial<import("../src/lib/quickbooks").RemoteDocumentFacts> & { id: string }>;
}) {
    const { probeDocumentSync } = await import("../src/lib/qbo-document-sync");
    return probeDocumentSync(
        { accessToken: "a", refreshToken: "r", realmId: opts.realmId ?? "realm-1" },
        { kind: "estimate", marker: opts.marker },
        undefined,
        { findEstimates: (async () => opts.found ?? []) as any },
    );
}

async function claimMarker(over: Record<string, unknown> = {}) {
    const { composeSyncMarker, documentPrivateNote } = await import("../src/lib/qbo-document-sync");
    const { CREATE_IN_FLIGHT_MARKER } = await import("../src/lib/qbo-create-markers");
    return composeSyncMarker(CREATE_IN_FLIGHT_MARKER, {
        docNumber: "EST-00001",
        privateNote: documentPrivateNote("EST-00001", "Kitchen"),
        expectedTotal: 1000,
        realmId: "realm-1",
        customerId: "42",
        ...over,
    } as any);
}

test("round 40: an exact match IS adopted (the control)", async () => {
    const { documentPrivateNote } = await import("../src/lib/qbo-document-sync");
    const res = await probeWith({
        marker: await claimMarker(),
        found: [{
            // The DOCUMENT NUMBER is part of the acceptance rule now (round 48):
            // a candidate that does not carry the number the claim was made
            // under is not a document any later recovery could find again.
            id: "qb-9", docNumber: "EST-00001",
            privateNote: documentPrivateNote("EST-00001", "Kitchen"),
            total: 1000, customerId: "42",
        }],
    });
    assert.deepEqual(res, { state: "found", qbId: "qb-9" });
});

test("round 40: a hand-created document sharing the DocNumber is NOT adopted", async () => {
    const res = await probeWith({
        marker: await claimMarker(),
        // Same code, no ProBuild note. Somebody typed it in QuickBooks.
        found: [{ id: "qb-theirs", privateNote: null, total: 1000, customerId: "42" }],
    });
    assert.equal(res.state, "unknown");
    assert.match(String((res as any).reason), /none matches this claim/);
});

test("round 40: a document billed to another customer is NOT adopted", async () => {
    const { documentPrivateNote } = await import("../src/lib/qbo-document-sync");
    const res = await probeWith({
        marker: await claimMarker(),
        found: [{
            id: "qb-9", privateNote: documentPrivateNote("EST-00001", "Kitchen"),
            total: 1000, customerId: "99",
        }],
    });
    assert.equal(res.state, "unknown");
});

test("round 40: a document whose total differs is NOT adopted", async () => {
    const { documentPrivateNote } = await import("../src/lib/qbo-document-sync");
    const res = await probeWith({
        marker: await claimMarker(),
        found: [{
            id: "qb-9", privateNote: documentPrivateNote("EST-00001", "Kitchen"),
            total: 1250, customerId: "42",
        }],
    });
    assert.equal(res.state, "unknown");
});

test("round 40: a claim made against ANOTHER QuickBooks company is never queried", async () => {
    // The connection can legitimately point somewhere else now. Against the
    // wrong books the lookup finds nothing, which would read as "no document
    // exists" — while ours sits collectible in the original company.
    const { documentPrivateNote } = await import("../src/lib/qbo-document-sync");
    const res = await probeWith({
        marker: await claimMarker({ realmId: "realm-OTHER" }),
        realmId: "realm-1",
        found: [{
            id: "qb-9", privateNote: documentPrivateNote("EST-00001", "Kitchen"),
            total: 1000, customerId: "42",
        }],
    });
    assert.equal(res.state, "unknown");
    assert.match(String((res as any).reason), /realm-OTHER/);
});

test("round 40: a claim recording no realm or customer is refused, not guessed", async () => {
    const { composeSyncMarker } = await import("../src/lib/qbo-document-sync");
    const { CREATE_IN_FLIGHT_MARKER } = await import("../src/lib/qbo-create-markers");
    const res = await probeWith({
        marker: composeSyncMarker(CREATE_IN_FLIGHT_MARKER, {
            docNumber: "EST-00001", privateNote: "ProBuild EST-00001",
        } as any),
        found: [{ id: "qb-9", privateNote: "ProBuild EST-00001", total: 1000, customerId: "42" }],
    });
    assert.equal(res.state, "unknown");
    assert.match(String((res as any).reason), /company or customer/);
});

test("round 40: no document under that code at all is ABSENT, so a create may proceed", async () => {
    // The distinction that makes the recovery usable rather than a permanent
    // refusal: an authoritative empty answer means the claim can go on to
    // create, reusing its own requestid.
    const res = await probeWith({ marker: await claimMarker(), found: [] });
    assert.deepEqual(res, { state: "absent" });
});

// ─── Round 41 gate, finding 3: QuickBooks actions need project scope ───

/**
 * `assertInvoicePermission()` answers "may this user touch invoices at all",
 * never "may this user touch THIS invoice", and every one of these is a
 * remotely invokable Server Action taking a bare id. `createQBPaymentLink`
 * hands back a hosted PAY LINK — a URL that collects money — so an unscoped id
 * was a way to mint one for any project in the company.
 *
 * A source tripwire because what has to hold is an ORDERING: the scope check
 * precedes the first token fetch or remote call. An outcome assertion on the
 * happy path cannot see that, and actions.ts pulls in most of the app.
 */
test("round 41: every QuickBooks action scopes to its project before any remote call", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/actions.ts", "utf8"));
    const body = (name: string) => {
        const at = src.indexOf(`export async function ${name}(`);
        assert.ok(at > -1, `${name} not found — has it been renamed?`);
        return src.slice(at, src.indexOf("\nexport ", at + 10));
    };

    // name -> the gate it must use, and the first thing that must come AFTER it.
    const gated: Array<[string, string, string]> = [
        ["createQBPaymentLink", "assertMilestoneAccess(", "pushMilestoneToQuickBooks"],
        ["refreshQBPayments", "assertInvoiceAccess(", "syncQuickBooksPayments"],
        ["sendMilestoneInvoices", "assertInvoiceAccess(", "sendMilestoneInvoicesCore"],
        ["recordPayment", "assertInvoiceAccess(", "recordPaymentCore"],
    ];
    for (const [name, gate, thenWhat] of gated) {
        const fn = body(name);
        const at = fn.indexOf(gate);
        assert.ok(at > -1, `${name} is missing its horizontal gate (${gate})`);
        const work = fn.indexOf(thenWhat);
        assert.ok(work > -1, `${name}: ${thenWhat} not found`);
        assert.ok(at < work, `${name} does its work BEFORE checking project scope`);
    }

    // ...and the gates really do refuse. A check placed correctly but calling
    // something permissive would satisfy the ordering above and nothing else.
    const { canAccessProject } = await import("../src/lib/access-rules");
    const scoped = { id: "u1", role: "FINANCE", permissions: null, projectAccess: [], assignedProjects: [] } as any;
    assert.equal(canAccessProject(scoped, "proj-not-theirs"), false);
    assert.equal(canAccessProject({ ...scoped, role: "ADMIN" }, "proj-not-theirs"), true,
        "and an ADMIN still passes, so the guard is not simply always-false");
});

test("round 41: the horizontal gates fail CLOSED on a row that does not exist", async () => {
    // "Not found" and "not yours" must answer alike, or the gate becomes a way
    // to probe which ids exist.
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/actions.ts", "utf8"));
    for (const helper of ["assertInvoiceAccess", "assertMilestoneAccess"]) {
        const at = src.indexOf(`async function ${helper}(`);
        assert.ok(at > -1, `${helper} not found`);
        const fn = src.slice(at, src.indexOf("\n}", at) + 2);
        assert.match(fn, /if \(!\w+ \|\| !canAccessProject\(/,
            `${helper} must refuse a missing row the same way it refuses a foreign one`);
    }
});

// ─── Round 41 gate, finding 4: corrupt markers must not wedge the queue ───

test("round 41: a page of unrecognised markers is stepped over, not read as exhaustion", async () => {
    // The sweep selected every non-null marker and filtered the recognised ones
    // in memory, so a page made entirely of legacy or corrupt values came back
    // EMPTY — which the pager read as "this rail is done", leaving every valid
    // row behind it unvisited.
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    const rows = [
        { id: "est-1", marker: "gibberish", kind: "estimate" as const , clientId: "cli-1" },
        { id: "est-2", marker: "voided", kind: "estimate" as const , clientId: "cli-1" },
        { id: "est-3", marker: "ambiguous-create:@1|EST-3|note", kind: "estimate" as const , clientId: "cli-1" },
    ];
    const adopted: string[] = [];
    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            railFirst: "estimate",
            // Three rows is the whole rail, so the run stops there rather than
            // wrapping back over what it just did.
            pageSize: 3,
            listParked: async (rail, after) => {
                if (rail !== "estimate") return [];
                return rows.filter((r) => !after || r.id > after);
            },
            probe: (async () => ({ state: "found", qbId: "qb-3" })) as any,
            adopt: async (row) => { adopted.push(row.id); return 1; },
            countParked: async () => 2,
        },
    );
    assert.deepEqual(adopted, ["est-3"], "the valid row behind the junk is reached");
    assert.equal(res.unrecognised, 2, "and the junk is counted, not silently dropped");
    assert.equal(res.checked, 1, "only the readable row cost a QuickBooks call");
});

test("round 43: maintenance selects EVERY non-null marker, so corrupt ones are counted", async () => {
    // Filtering to recognised prefixes in the query fixed one starvation bug and
    // created a blind spot: an unreadable value was then invisible to both the
    // page AND the count, so `unrecognised` could never be anything but zero and
    // a run carrying corrupt markers reported ok:true. The sweep steps its cursor
    // over a row it cannot read and counts it, so selecting everything is safe.
    const { documentSyncMarkerWhere } = await import("../src/lib/qbo-document-sync");
    // Still exported and still correct — the sync route uses it to recognise a
    // marker; it is the maintenance QUERY that must not filter on it.
    assert.deepEqual(documentSyncMarkerWhere(), [
        { qbSyncMarker: "create-in-flight" },
        { qbSyncMarker: { startsWith: "create-in-flight:" } },
        { qbSyncMarker: "ambiguous-create" },
        { qbSyncMarker: { startsWith: "ambiguous-create:" } },
    ]);

    const src = await import("node:fs").then((fs) =>
        fs.readFileSync("src/app/api/integrations/qbo-maintenance/route.ts", "utf8"));
    assert.match(src, /const markerWhere = \{ qbSyncMarker: \{ not: null \} \}/,
        "the page query, and the parked COUNT, must see every marker");
    assert.doesNotMatch(src, /OR: documentSyncMarkerWhere\(\)/,
        "filtering recognised prefixes in the query is the blind spot this closes");
    // ...and an unreadable marker is outstanding work, not a clean pass.
    assert.match(src, /docSyncsUnrecognised > 0/);
    assert.match(src, /"sync-marker-unrecognised"/);
});

// ─── Round 42 gate ───

test("round 42: maintenance does NOT adopt a document whose record has moved", async () => {
    // The adoption callback was a bare marker CAS, and the probe only ever
    // compares QuickBooks against the HISTORICAL marker — so nothing asked
    // whether the record still described it. An edited record would have had
    // the stale document linked to it by a background sweep, unattended.
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    const adopts: string[] = [];
    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            railFirst: "estimate",
            pageSize: 1,
            listParked: async (rail, after) =>
                rail === "estimate" && !after
                    ? [{ id: "est-1", marker: "ambiguous-create:@1|EST-1|note", kind: "estimate" as const, clientId: "cli-1" }]
                    : [],
            probe: (async () => ({ state: "found", qbId: "qb-9" })) as any,
            // This is what `decideUnderIdentity` returns when the recomputed
            // identity no longer matches the claim: zero rows written.
            adopt: async (row) => { adopts.push(row.id); return 0; },
            countParked: async () => 1,
        },
    );
    assert.deepEqual(adopts, ["est-1"], "it did try");
    assert.equal(res.recovered, 0, "and nothing was linked");
    assert.equal(res.stillParked, 1, "the row stays parked for a human");
    assert.equal(res.rails.estimate.unresolved, 1, "reported against its own rail");
});

test("round 42: the maintenance adoption really is routed through the identity decision", async () => {
    // The behavioural test above drives the sweep with an injected `adopt`, so
    // it cannot see WHICH adopt the route supplies. This can.
    const src = await import("node:fs").then((fs) =>
        fs.readFileSync("src/app/api/integrations/qbo-maintenance/route.ts", "utf8"));
    const at = src.indexOf("adopt: async (row, qbId)");
    assert.ok(at > -1, "the adoption callback moved — has it been renamed?");
    const cb = src.slice(at, at + 1600);
    assert.match(cb, /decideUnderIdentity\(\{/, "adoption must take the money locks and compare");
    assert.match(cb, /expectMarker: row\.marker/, "against the claim the row carries");
});

test("round 42: one rail refusing a row does not skip the other rail", async () => {
    // Any `unknown` probe used to set the run-wide `reason`, and the outer loop
    // breaks on it — so a single permanently-unresolvable estimate meant the
    // invoice rail was never examined, run after run.
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    const seen: string[] = [];
    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            railFirst: "estimate",
            pageSize: 1,
            listParked: async (rail, after) => {
                if (after) return [];
                return rail === "estimate"
                    ? [{ id: "est-1", marker: "ambiguous-create:@1|EST-1|note", kind: "estimate" as const, clientId: "cli-1" }]
                    : [{ id: "inv-1", marker: "ambiguous-create:@1|INV-1|note", kind: "invoice" as const, clientId: "cli-1" }];
            },
            probe: (async (_t: unknown, input: { kind: string }) => {
                seen.push(input.kind);
                return input.kind === "estimate"
                    ? { state: "unknown", reason: "two documents match EST-1" }
                    : { state: "found", qbId: "qb-inv-9" };
            }) as any,
            adopt: async () => 1,
            countParked: async () => 1,
        },
    );
    assert.deepEqual(seen, ["estimate", "invoice"], "the invoice rail is still examined");
    assert.equal(res.recovered, 1, "and its recoverable row is recovered");
    assert.equal(res.reason, null, "a per-row refusal is not a run-wide stop");
    assert.equal(res.rails.estimate.unresolved, 1);
    assert.match(String(res.rails.estimate.note), /two documents match/);
    assert.equal(res.rails.invoice.recovered, 1);
});

test("round 42: a SHARED failure still stops both rails (the control)", async () => {
    // If nothing crossed rails any more, a QuickBooks outage would burn a full
    // deadline on the second rail proving what the first already knew.
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    const seen: string[] = [];
    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            railFirst: "estimate",
            isExhausted: () => true,
            listParked: async (rail) => { seen.push(rail); return []; },
            probe: (async () => ({ state: "absent" })) as any,
            adopt: async () => 1,
            countParked: async () => 0,
        },
    );
    assert.equal(res.reason, "budget-exhausted");
    assert.deepEqual(seen, [], "out of budget stops before either rail is paged");
});

test("round 42: a Paid pending-deletion row reaches a terminal state, both ways", async () => {
    // Settlement now cancels the deletion intent, so this only turns up on a
    // legacy row or a settle that raced. It used to be unrecoverable: the sweep
    // kept selecting it, but the final unlink requires status != Paid.
    const { sweepPendingDeletions, PAID_PENDING_DELETION_FLAG } =
        await import("../src/lib/quickbooks-payments");
    const tokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };

    for (const [probeState, expectFlag, label] of [
        ["ok", null, "the invoice is there, so the intent is simply wrong now"],
        ["notFound", PAID_PENDING_DELETION_FLAG, "gone remotely and Paid locally: a human must settle it"],
    ] as const) {
        const writes: any[] = [];
        const deleted: string[] = [];
        const db = {
            paymentSchedule: {
                async findMany() {
                    // Carrying the SETTLED intent: a settle promotes the marker
                    // rather than clearing it, so this is the shape the sweep
                    // actually meets after a payment landed mid-delete.
                    return [{ id: "ps-1", qbInvoiceId: "qb-1", status: "Paid", qbSyncError: "pending-deletion:settled" }];
                },
                async count() { return 1; },
                async updateMany(args: any) { writes.push(args); return { count: 1 }; },
            },
        };
        await sweepPendingDeletions(tokens, undefined, {
            db: db as any,
            cursorStore: { get: async () => null, set: async () => {} } as any,
            probeInvoice: (async () => ({ state: probeState, balance: 0, total: 0, paymentTxnIds: [] })) as any,
            deleteInvoice: async (_t, qbId) => { deleted.push(qbId); return true; },
            unlink: async () => true,
        });
        assert.deepEqual(deleted, [], `${label}: a Paid invoice must never be deleted`);
        assert.equal(writes.length, 1, label);
        assert.equal(writes[0].data.qbSyncError, expectFlag, label);
        assert.equal(writes[0].where.qbSyncError, "pending-deletion:settled",
            "the release is CAS-pinned to the intent state it OBSERVED, not a constant");
    }
});

test("round 42: settling a pending-deletion row cancels the intent, both settle paths", async () => {
    // A separate write rather than a clause on the settle claim: a settle must
    // never be made conditional on a marker.
    const fs = await import("node:fs");
    for (const [file, fn] of [
        ["src/lib/payment-record-core.ts", "recordPaymentCore"],
        ["src/lib/quickbooks-payments.ts", "settleMilestonePaidInTx"],
    ] as const) {
        const src = fs.readFileSync(file, "utf8");
        // The DECLARATION, not the first mention: a comment naming the function
        // above its own definition (round 51 added one) would otherwise anchor
        // this slice thousands of characters early and the pin would fail for a
        // reason unrelated to the property it guards.
        const at = src.indexOf(`function ${fn}(`);
        assert.ok(at > -1, `${fn} declaration not found`);
        // A generous window on purpose. A fixed 4000 chars silently stopped
        // covering the promotion the moment round 51 added the claim fence above
        // it, and the test then failed for a reason that had nothing to do with
        // the property — the promotion was still exactly where it should be, just
        // outside the slice. The ORDER is what this asserts, so the window only
        // has to be big enough to contain both landmarks.
        const body = src.slice(at, at + 12000);
        const claim = body.indexOf("claim.count === 0");
        const cancel = body.indexOf("qbSyncError: PENDING_DELETION_MARKER");
        assert.ok(cancel > -1, `${fn} must cancel a pending-deletion intent on settle`);
        assert.ok(claim > -1 && cancel > claim,
            `${fn}: the cancel must follow the settle claim, never gate it`);
    }
});

test("round 42: the maintenance response explains both new sweeps", async () => {
    // They affected ok/truncated and appeared in neither the reason chain nor
    // the body, so a caller got {ok:false, truncated:true, retry:true} with
    // nothing at all to act on.
    const src = await import("node:fs").then((fs) =>
        fs.readFileSync("src/app/api/integrations/qbo-maintenance/route.ts", "utf8"));
    for (const key of [
        "pendingDeletions:", "documentSyncs:", "remaining: deletions.stillPending",
        "unrecognised: docSyncs.unrecognised", "rails: docSyncs.rails",
    ]) {
        assert.ok(src.includes(key), `the response must report ${key}`);
    }
    for (const reason of [
        "document-sync-failed", "pending-deletions-outstanding", "document-sync-parked",
    ]) {
        assert.ok(src.includes(reason), `the reason chain must include ${reason}`);
    }
});

// ─── Round 43 gate ───

/**
 * Break-QB-Link writes the deletion marker, performs the IRREVERSIBLE remote
 * delete, and only then unlinks. Round 42 had settlement CLEAR the marker; a
 * settle landing in that window therefore cleared it and set Paid, so the
 * post-delete unlink CAS lost on both counts and the row was left Paid, still
 * linked to an invoice that no longer exists, carrying no marker at all —
 * invisible to the sweep that exists to find exactly that.
 */
test("round 43: settlement PROMOTES the deletion intent, it never clears it", async () => {
    const fs = await import("node:fs");
    for (const [file, fn] of [
        ["src/lib/payment-record-core.ts", "recordPaymentCore"],
        ["src/lib/quickbooks-payments.ts", "settleMilestonePaidInTx"],
    ] as const) {
        const src = fs.readFileSync(file, "utf8");
        // The DECLARATION, not the first mention: a comment naming the function
        // above its own definition (round 51 added one) would otherwise anchor
        // this slice thousands of characters early and the pin would fail for a
        // reason unrelated to the property it guards.
        const at = src.indexOf(`function ${fn}(`);
        assert.ok(at > -1, `${fn} declaration not found`);
        const body = src.slice(at, at + 8000);
        const claim = body.indexOf("claim.count === 0");
        const promote = body.indexOf("qbSyncError: PENDING_DELETION_SETTLED_MARKER");
        assert.ok(promote > -1, `${fn} must RECORD the intent, not clear it`);
        assert.ok(claim > -1 && promote > claim,
            `${fn}: the promotion must follow the settle claim, never gate it`);
        // The old rule, gone: clearing it is what made the row invisible.
        const pinned = body.indexOf("where: { id: paymentId, qbSyncError: PENDING_DELETION_MARKER }");
        const pinned2 = body.indexOf("where: { id: paymentScheduleId, qbSyncError: PENDING_DELETION_MARKER }");
        const where = pinned > -1 ? pinned : pinned2;
        assert.ok(where > -1, `${fn}: the promotion must be CAS-pinned to the pending intent`);
    }
});

test("round 43: a lost post-delete unlink flags the row itself", async () => {
    // The delete is irreversible, so losing that CAS cannot end in a shrug. This
    // path flags the row rather than hoping the sweep gets there.
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/actions.ts", "utf8"));
    const at = src.indexOf("export async function breakQBInvoiceLink");
    const fn = src.slice(at, src.indexOf("\nexport ", at + 10));

    const unlink = fn.indexOf("clearedAfterDelete");
    assert.ok(unlink > -1, "the post-delete unlink moved");
    // Searched from AFTER the unlink: the function destructures the flag from
    // its import at the top, which is not the write this is asserting.
    const flag = fn.indexOf("data: { qbSyncError: PAID_PENDING_DELETION_FLAG }", unlink);
    assert.ok(flag > -1, "the lost-CAS branch must flag the row for reconciliation");
    // Re-read, then CAS on what the row says NOW: what it carries at that point
    // is precisely what this path does not know.
    assert.match(fn, /qbSyncError: now\.qbSyncError/,
        "the flag write must be CAS-pinned to the re-read value");
    assert.match(fn, /now\?\.qbInvoiceId === schedule\.qbInvoiceId/,
        "and only while the row still points at the invoice we deleted");
});

test("round 43: the sweep still finds a row settled mid-delete", async () => {
    // The promotion is only useful if the sweep selects the promoted state too.
    const src = await import("node:fs").then((fs) =>
        fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    assert.match(src,
        /qbSyncError: \{ in: \[PENDING_DELETION_MARKER, PENDING_DELETION_SETTLED_MARKER\] \}/,
        "sweepPendingDeletions must select BOTH intent states");
});

test("round 43: an unreadable marker makes the maintenance run ok:false", async () => {
    const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
    const res = await sweepPendingDocumentSyncs(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        undefined,
        {
            railFirst: "estimate",
            pageSize: 2,
            listParked: async (rail, after) =>
                rail === "estimate" && !after
                    ? [
                        { id: "est-1", marker: "gibberish", kind: "estimate" as const, clientId: "cli-1" },
                        { id: "est-2", marker: "ambiguous-create:@1|EST-2|note", kind: "estimate" as const, clientId: "cli-1" },
                    ]
                    : [],
            probe: (async () => ({ state: "found", qbId: "qb-2" })) as any,
            adopt: async () => 1,
            // The count now sees EVERY non-null marker, so the corrupt row is in it.
            countParked: async () => 1,
        },
    );
    assert.equal(res.unrecognised, 1, "reachable at last: the count no longer filters it out");
    assert.equal(res.recovered, 1, "and the valid row behind it is still processed");
});

// --- Round 47: a broken connection stops the sweep, and the rails alternate ---

/**
 * `probeDocumentSync` flattened every timeout, transport error, 401 and 5xx
 * into a bare `state: "unknown"`, which is also what "this ROW is ambiguous"
 * looks like. So the sweep advanced the cursor and asked QuickBooks about the
 * next parked row, and the next, at a fresh timeout each — burning the whole
 * route budget against a connection that was never going to answer, delaying
 * the cron, and filing a bad credential as ordinary trouble.
 */
function connectionSweep(probeError: unknown, kv = new Map<string, string>()) {
    const probes: string[] = [];
    const rows = {
        estimate: ["est-1", "est-2", "est-3"],
        invoice: ["inv-1", "inv-2"],
    };
    const cursors = {
        get: async (k: string) => kv.get(k) ?? null,
        set: async (k: string, v: string) => { kv.set(k, v); },
    };
    return {
        probes,
        kv,
        run: async () => {
            const { sweepPendingDocumentSyncs, classifyDocumentSyncFailure } =
                await import("../src/lib/qbo-document-sync");
            return sweepPendingDocumentSyncs(
                { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
                undefined,
                {
                    cursors,
                    railFirst: "estimate",
                    pageSize: 25,
                    listParked: async (rail: "estimate" | "invoice", after?: string | null) =>
                        rows[rail]
                            .filter((id) => !after || id > after)
                            .map((id) => ({ id, marker: `ambiguous-create:@1|${id}|note`, kind: rail, clientId: "cli-1" })),
                    // The REAL classifier, against a real error object: a fake
                    // that simply returned the failure code would prove nothing
                    // about how a 401 is recognised.
                    probe: (async () => {
                        probes.push("probe");
                        const failure = classifyDocumentSyncFailure(probeError);
                        return {
                            state: "unknown",
                            reason: (probeError as Error)?.message ?? "failed",
                            ...(failure ? { failure } : {}),
                        };
                    }) as any,
                    adopt: async () => 1,
                    countParked: async () => 5,
                },
            );
        },
    };
}

test("round 47: a 401 stops BOTH rails after exactly one probe, named as the credential", async () => {
    const { QboHttpError } = await import("../src/lib/quickbooks");
    const sweep = connectionSweep(new QboHttpError("unauthorized", 401));
    const res = await sweep.run();

    assert.equal(sweep.probes.length, 1, "one probe, not one per parked row");
    assert.equal(res.reason, "qbo-auth", "named as the credential, which health counts for the reconnect alert");
    assert.equal(res.rails.estimate.stopped, "qbo-auth");
    assert.equal(res.rails.invoice.checked, 0, "the second rail was never started");
});

test("round 47: a timeout and a 5xx are named as themselves and stop the same way", async () => {
    const { QBTimeoutError, QboRetryableError } = await import("../src/lib/quickbooks");
    const timeout = connectionSweep(new QBTimeoutError("QuickBooks request timed out after 20000ms"));
    const timedOut = await timeout.run();
    assert.equal(timeout.probes.length, 1);
    assert.equal(timedOut.reason, "qbo-timeout");

    const down = connectionSweep(new QboRetryableError("service unavailable", 503));
    const unavailable = await down.run();
    assert.equal(down.probes.length, 1);
    assert.equal(unavailable.reason, "qbo-unavailable");
});

test("round 47: a shared failure does NOT step the cursor over the row it never examined", async () => {
    const { QBTimeoutError } = await import("../src/lib/quickbooks");
    const { DOCUMENT_SYNC_CURSOR_KEYS } = await import("../src/lib/qbo-document-sync");
    const sweep = connectionSweep(new QBTimeoutError("timed out"));
    await sweep.run();
    assert.equal(
        sweep.kv.get(DOCUMENT_SYNC_CURSOR_KEYS.estimate) || "",
        "",
        "the head row was never really looked at, so the cursor stays before it",
    );
});

test("round 47: a ROW-specific ambiguity still advances, one probe per row (control)", async () => {
    // Without this the tests above would also pass against a sweep that stopped
    // on any `unknown` at all — which would wedge the queue behind one
    // unresolvable document, the round-40 starvation bug all over again.
    const sweep = connectionSweep(new Error("two documents match this code"));
    const res = await sweep.run();

    // Every row on both rails, and each of them ONCE. This used to assert
    // `> 5` — five rows plus a second pass over them, because a run starting at
    // the head wrapped back to the top the moment its first page ran out. That
    // extra pass was the round-49 bug, not the bounded wrap: the wrap is for a
    // run that RESUMED in the tail. What this control is actually for is that
    // the sweep did NOT stop at the first ambiguous row.
    assert.equal(sweep.probes.length, 5, `expected every row examined once, got ${sweep.probes.length}`);
    assert.equal(res.reason, null);
    assert.ok(res.rails.invoice.checked > 0, "the second rail ran");
});

// --- Round 47: the rails genuinely alternate ---

test("round 47: three consecutive runs alternate the starting rail", async () => {
    // `Date.now() % 2` is a coin flip per run, not alternation: the same rail
    // can win indefinitely, which is the starvation the comment claimed to
    // prevent. The order is now persisted next to the cursors and flipped.
    const kv = new Map<string, string>();
    const order: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) {
        const { sweepPendingDocumentSyncs } = await import("../src/lib/qbo-document-sync");
        const res = await sweepPendingDocumentSyncs(
            { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
            undefined,
            {
                cursors: {
                    get: async (k: string) => kv.get(k) ?? null,
                    set: async (k: string, v: string) => { kv.set(k, v); },
                },
                pageSize: 5,
                listParked: async () => [],
                adopt: async () => 1,
                countParked: async () => 0,
            },
        );
        order.push(res.railFirst);
    }

    assert.deepEqual(order, ["estimate", "invoice", "estimate"], order.join(","));
    // Deterministic proof of the MECHANISM, not just of the outcome: a coin
    // flip produces this sequence about one run in four, so the sequence alone
    // is not evidence. The order having been PERSISTED is.
    const { DOCUMENT_SYNC_ORDER_KEY } = await import("../src/lib/qbo-document-sync");
    assert.equal(kv.get(DOCUMENT_SYNC_ORDER_KEY), "estimate", "the run recorded which rail it started with");
});

// --- Round 48: the connection classification survives the route ---

/**
 * The sweep classifies a connection failure precisely (`qbo-auth` /
 * `qbo-timeout` / `qbo-unavailable`) and the maintenance route threw that away,
 * propagating only `budget-exhausted`. So an expired credential was reported as
 * `document-sync-parked`, the cron logged an automation event under THAT
 * reason, and pipeline-health — which counts events reasoned `qbo-auth` toward
 * the reconnect alert — never saw it. The one failure that cannot fix itself
 * was the one the digest could not name.
 */
test("round 48: every document-sweep stop reason reaches the route response", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/app/api/integrations/qbo-maintenance/route.ts", "utf8"));
    assert.match(
        src,
        /if \(docSyncs\.reason\) abortedReason = docSyncs\.reason;/,
        "every run-wide reason must propagate, not just budget-exhausted",
    );
    assert.ok(
        !/docSyncs\.reason === "budget-exhausted"/.test(src),
        "the budget-only filter must be gone",
    );
    // `abortedReason` heads the reason chain, so the propagated value is what
    // the response reports — ahead of the generic document-sync-parked.
    const chain = src.slice(src.indexOf("const reason ="));
    assert.ok(
        chain.indexOf("abortedReason") < chain.indexOf("document-sync-parked"),
        "the classified reason must outrank the generic parked one",
    );
});

test("round 48: qbo-auth is a reason pipeline-health counts toward the reconnect alert", async () => {
    // The other half of the path: the cron logs an automation event under the
    // body's reason, and health only raises `quickbooks-reconnect-needed` for
    // reasons on this list. A sweep reason that is not on it is invisible.
    const { QBO_RECONNECT_EVENT_REASONS, QBO_AUTH_EVENT_REASON } = await import("../src/lib/pipeline-health");
    const { classifyDocumentSyncFailure } = await import("../src/lib/qbo-document-sync");
    const { QboHttpError } = await import("../src/lib/quickbooks");

    const classified = classifyDocumentSyncFailure(new QboHttpError("unauthorized", 401));
    assert.equal(classified, QBO_AUTH_EVENT_REASON);
    assert.ok(
        QBO_RECONNECT_EVENT_REASONS.includes(classified as string),
        "the sweep's credential reason must be one health acts on",
    );

    // The cron files the event under the body's reason verbatim.
    const cron = await import("node:fs").then((fs) => fs.readFileSync("src/app/api/cron/qbo-maintenance/route.ts", "utf8"));
    assert.match(cron, /reason: ok \? undefined : String\(\(body as \{ reason\?: string \} \| null\)\?\.reason \?\? "maintenance-incomplete"\)/);
});

// --- Round 49: a settlement racing the deletion sweep (P0) ---

/**
 * The sweep read `status` once, at page time, and decided whether to delete
 * from that snapshot. A settlement committing in between — a manual Record
 * Payment, a Stripe webhook — left the sweep DELETING the QuickBooks invoice of
 * a milestone that had just been paid. The post-delete unlink then lost its
 * compare-and-set (the settle had promoted the marker), so the row stayed
 * Paid, still linked, pointing at an invoice that no longer existed.
 *
 * The fix is a claim: a short transaction under the invoice money lock that
 * compare-and-sets `{ status: Pending, qbSyncError: <observed> }` into a claim
 * marker. A settle that got there first makes that CAS fail, so the remote
 * call never happens — which is what these assert on the delete count.
 */
test("round 49: a settle that commits before the claim stops the delete entirely", async () => {
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const { db, live } = pendingDeletionDb([{ id: "ps-1", qbInvoiceId: "qb-1" }]);
    // The settle lands between the page read and the claim: status Paid, and
    // the marker promoted, exactly as payment-record-core does it.
    live[0].status = "Paid";
    live[0].qbSyncError = "pending-deletion:settled";
    const deleted: string[] = [];

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        {
            db: db as any,
            deleteInvoice: async (_t, qbId) => { deleted.push(qbId); return true; },
            unlink: async () => true,
            // The row reads Paid, so the sweep takes the PROBE branch and finds
            // the invoice alive: the deletion intent is simply wrong now.
            probeInvoice: async () => ({ state: "ok", balance: 0, total: 100 }) as any,
        },
    );

    assert.deepEqual(deleted, [], "a paid milestone's invoice is NEVER deleted");
    assert.equal(res.finished, 1, "the intent is cancelled instead");
});

test("round 49: a settle that commits after the page read makes the CLAIM fail, and nothing is deleted", async () => {
    // The exact interleaving from the finding: the page saw Pending, and the
    // settle commits before the claim runs. The claim is pinned to BOTH the
    // status and the marker it was decided from, so it loses.
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const deleted: string[] = [];
    const { db, live } = pendingDeletionDb([{ id: "ps-1", qbInvoiceId: "qb-1" }]);
    const realFindMany = db.paymentSchedule.findMany.bind(db.paymentSchedule);
    db.paymentSchedule.findMany = async (args: any) => {
        const page = await realFindMany(args);
        // ...and NOW the settlement commits, after the sweep has its snapshot.
        live[0].status = "Paid";
        live[0].qbSyncError = "pending-deletion:settled";
        return page;
    };

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        {
            db: db as any,
            deleteInvoice: async (_t, qbId) => { deleted.push(qbId); return true; },
            unlink: async () => true,
        },
    );

    assert.deepEqual(deleted, [], "the claim lost, so the irreversible call never happened");
    assert.equal(live[0].status, "Paid", "and the settlement stands");
    assert.equal(res.finished, 0);
});

test("round 51: a settle cannot land at all while the deletion claim is held", async () => {
    // Round 49 had the settle CANCEL a live claim, and the sweep re-read the
    // claim just before dispatching. Round 51: a re-read is a READ, not a fence
    // — a settle committing between it and the network call still won, and the
    // delete destroyed the invoice of a milestone that had just been paid.
    //
    // The claim is now the exclusion: every settlement rail refuses a row whose
    // marker is `pending-deletion:claimed:*`. So the interleaving this test used
    // to stage — settle lands after the claim — cannot happen, and what is
    // asserted instead is that the settle path itself declines it.
    const { isIrreversibleClaimHeld, deletionClaimMarker, compensationClaimMarker } =
        await import("../src/lib/qbo-create-markers");

    assert.equal(isIrreversibleClaimHeld(deletionClaimMarker("abc123")), true);
    assert.equal(isIrreversibleClaimHeld(compensationClaimMarker("abc123")), true);
    // ...and nothing else is fenced: an ordinary deletion intent, a settled one,
    // and a clean row all still settle normally.
    for (const marker of ["pending-deletion", "pending-deletion:settled", "paylink-pending", null]) {
        assert.equal(isIrreversibleClaimHeld(marker), false, String(marker));
    }

    // The manual rail consults it before claiming the row Paid.
    const core = await import("node:fs").then((fs) => fs.readFileSync("src/lib/payment-record-core.ts", "utf8"));
    const at = core.indexOf("function recordPaymentCore(");
    assert.ok(at > -1);
    const body = core.slice(at, at + 12000);
    const fence = body.indexOf("isIrreversibleClaimHeld(");
    const claim = body.indexOf("claim.count === 0");
    assert.ok(fence > -1, "the manual settle must consult the fence");
    assert.ok(fence < claim, "and it must do so BEFORE it claims the row Paid");

    // The QuickBooks rail excludes both claims in its claim predicate.
    const qbo = await import("node:fs").then((fs) => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const settleAt = qbo.indexOf("function settleMilestonePaidInTx(");
    const settleBody = qbo.slice(settleAt, settleAt + 12000);
    // The fence is a JS check on the marker it read, NOT a `NOT ... LIKE` in
    // the WHERE: three-valued logic makes that NULL for a null marker, which
    // excluded every clean row and stopped ordinary settlement (round 53).
    assert.match(settleBody, /isIrreversibleClaimHeld\(current\?\.qbSyncError\)/);
    assert.doesNotMatch(settleBody, /NOT: \[/);
});
test("round 49: an UNCONTESTED row still deletes (the control)", async () => {
    // Without this, the three tests above would pass just as happily against a
    // sweep that had stopped deleting anything at all.
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const deleted: string[] = [];
    const { db } = pendingDeletionDb([{ id: "ps-1", qbInvoiceId: "qb-1" }]);

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        {
            db: db as any,
            deleteInvoice: async (_t, qbId) => { deleted.push(qbId); return true; },
            unlink: async () => true,
        },
    );

    assert.deepEqual(deleted, ["qb-1"]);
    assert.equal(res.finished, 1);
});

test("round 49: the claim is taken under the invoice money lock", async () => {
    // A claim that took no lock would serialize against nothing: the settle
    // takes the same lock, and that is what makes the two orderings the only
    // two orderings.
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline } = await import("../src/lib/quickbooks");
    const { db } = pendingDeletionDb([{ id: "ps-1", qbInvoiceId: "qb-1", invoiceId: "inv-7" }]);

    await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        { db: db as any, deleteInvoice: async () => true, unlink: async () => true },
    );

    assert.ok(
        (db as any).locks.some((l: string) => /"Invoice"[\s\S]*FOR UPDATE[\s\S]*inv-7/.test(l)),
        `the claim must lock the parent invoice, got ${JSON.stringify((db as any).locks)}`,
    );
});

// --- Round 49: the deletion sweep names a credential failure (P1) ---

test("round 49: a 401 stops the deletion sweep as qbo-auth, not as an outage", async () => {
    // `qbo-unavailable` is deliberately excluded from QBO_RECONNECT_EVENT_REASONS,
    // so filing a credential failure under it meant pipeline-health never raised
    // `quickbooks-reconnect-needed` — the one failure that cannot fix itself was
    // the one nobody was told about.
    const { sweepPendingDeletions } = await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline, QboHttpError } = await import("../src/lib/quickbooks");
    const { QBO_RECONNECT_EVENT_REASONS } = await import("../src/lib/pipeline-health");
    const { db } = pendingDeletionDb([{ id: "ps-1", qbInvoiceId: "qb-1" }, { id: "ps-2", qbInvoiceId: "qb-2" }]);

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        {
            db: db as any,
            deleteInvoice: async () => { throw new QboHttpError("unauthorized", 401); },
            unlink: async () => true,
        },
    );

    assert.equal(res.reason, "qbo-auth");
    assert.ok(QBO_RECONNECT_EVENT_REASONS.includes(res.reason as string), "health must act on it");
});

test("round 49: a shared failure leaves the cursor BEFORE the row it never examined", async () => {
    // The checkpoint used to advance before the QuickBooks call, so a row the
    // connection prevented us from examining was stepped over and not retried
    // until the next wrap.
    const { sweepPendingDeletions, PENDING_DELETION_CURSOR_KEY } =
        await import("../src/lib/quickbooks-payments");
    const { createRouteDeadline, QBTimeoutError } = await import("../src/lib/quickbooks");
    const kv = new Map<string, string>();
    const { db } = pendingDeletionDb([{ id: "ps-1", qbInvoiceId: "qb-1" }]);

    const res = await sweepPendingDeletions(
        { accessToken: "a", refreshToken: "r", realmId: "realm-1" },
        createRouteDeadline(30_000),
        {
            db: db as any,
            cursorStore: {
                get: async (k: string) => kv.get(k) ?? null,
                set: async (k: string, v: string) => { kv.set(k, v); },
            } as any,
            deleteInvoice: async () => { throw new QBTimeoutError("timed out"); },
            unlink: async () => true,
        },
    );

    assert.equal(res.reason, "qbo-timeout");
    assert.equal(kv.get(PENDING_DELETION_CURSOR_KEY) || "", "", "the unexamined row is not stepped over");
    assert.equal(res.checked, 0, "and it is not counted as examined either");
});
