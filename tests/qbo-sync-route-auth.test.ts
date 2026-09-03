/**
 * Request-level auth tests for POST /api/quickbooks/sync.
 *
 * Codex gate (PR #438, round 33): the route trusted the reverse proxy's own
 * auth and never checked, in-handler, whether the caller held the
 * estimates/invoices permission or could reach the target record's project.
 * Any authenticated staff member — FIELD_CREW included — could sync ANY
 * estimate or invoice to QuickBooks by id alone.
 *
 * Same require()-patch technique as tests/takeoff-convert-tax.test.ts (see
 * that file's header comment for why: tsx transpiles both this test and the
 * route to CommonJS, and on Node 20 `node:test`'s own `mock.module()`
 * corrupts the require chain for every OTHER module in the file, including a
 * plain require() patch for a different specifier — so no other file in this
 * suite may call `mock.module()` either). Scoped to the two specifiers
 * route.ts imports that this test needs to control: "@/lib/permissions" (who
 * is calling) and "@/lib/prisma" (does the record exist / what project does
 * it belong to). Everything else — @/lib/quickbooks, @/lib/quickbooks-payments,
 * @/lib/integration-store — loads for real; none of the scenarios below reach
 * a QuickBooks call, so nothing there needs mocking.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { hasPermission, canAccessProject, canAccessEstimate } from "../src/lib/access-rules";

const state: {
    user: any | null;
    estimates: Record<string, any>;
    invoices: Record<string, any>;
    /** Every document create the route actually dispatched, with its requestid. */
    posts: Array<{ kind: "estimate" | "invoice"; requestId?: string }>;
    /** What the next create should do. Reset between tests. */
    createThrows: unknown;
    /** What a DocNumber lookup finds, and what it costs. */
    lookup: { estimates: any[]; invoices: any[]; throws: unknown; calls: string[] };
    /** What `Client.qbCustomerId` says when the claim re-reads it under the lock. */
    clientQbCustomerId: string | null;
    locksTaken: number;
    /** Fired inside the create, to model a concurrent edit mid-flight. */
    onCreate: (() => void) | null;
    /** The PrivateNote each create actually sent. */
    sentNotes: Array<string | undefined>;
} = {
    user: null, estimates: {}, invoices: {}, posts: [], createThrows: null,
    lookup: { estimates: [], invoices: [], throws: null, calls: [] },
    clientQbCustomerId: "42", locksTaken: 0, onCreate: null, sentNotes: [],
};

function resetState() {
    state.user = null;
    state.estimates = {};
    state.invoices = {};
    state.posts = [];
    state.createThrows = null;
    state.lookup = { estimates: [], invoices: [], throws: null, calls: [] };
    state.clientQbCustomerId = "42";
    state.locksTaken = 0;
    state.onCreate = null;
    state.sentNotes = [];
}

const fakePermissions = {
    currentStaffUserOrNull: async () => state.user,
    hasPermission,
    canAccessProject,
    canAccessEstimate,
};

/** Real WHERE matching and real count semantics — a CAS the fake cannot fake. */
function table(rows: Record<string, any>) {
    return {
        // A DETACHED copy, like real Prisma. Returning the live object made the
        // route snapshot move with a concurrent edit, so a CAS pinned to that
        // snapshot could never fail - which would have made the interleaving
        // tests below pass against no guard at all.
        findUnique: async (args: { where: { id: string } }) =>
            rows[args.where.id] ? { ...rows[args.where.id] } : null,
        updateMany: async (args: { where: Record<string, any>; data: Record<string, any> }) => {
            const row = rows[args.where.id];
            if (!row) return { count: 0 };
            const matches = Object.entries(args.where).every(([k, v]) => (row[k] ?? null) === v);
            if (!matches) return { count: 0 };
            Object.assign(row, args.data);
            return { count: 1 };
        },
    };
}

const fakePrisma = {
    get estimate() { return table(state.estimates); },
    get invoice() { return table(state.invoices); },
    // Round 40: the fresh claim is taken inside a transaction that holds the
    // canonical Estimate → Invoice → Client locks and RE-READS the customer
    // mapping under them. The fake runs the callback directly — it cannot model
    // Postgres blocking, which is what the DB-gated tests are for — but it does
    // model the re-read, which is the part the route decides on.
    get client() {
        return {
            findUnique: async () => ({ qbCustomerId: state.clientQbCustomerId }),
        };
    },
    $queryRaw: async () => {
        state.locksTaken++;
        return [];
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
};

const fakeQbPayments = {
    getFreshQBTokens: async () => ({ accessToken: "a", refreshToken: "r", realmId: "realm-1" }),
    resolveCustomerAndItem: async () => ({ customerId: "42", itemId: "7" }),
};

const fakeIntegrationStore = {
    getQBSettings: async () => ({ connected: true, glMappings: {} }),
};

const PERMISSIONS_SPECIFIER = "@/lib/permissions";
const PRISMA_SPECIFIER = "@/lib/prisma";
const QB_PAYMENTS_SPECIFIER = "@/lib/quickbooks-payments";
const INTEGRATION_STORE_SPECIFIER = "@/lib/integration-store";
const QUICKBOOKS_SPECIFIER = "@/lib/quickbooks";
/**
 * The SAME module, imported under a different specifier.
 *
 * `qbo-document-sync.ts` (the recovery probe) sits beside quickbooks.ts and
 * imports it relatively, so patching only the route alias let the REAL
 * DocNumber lookups run and try to reach Intuit — which failed as an outage
 * and made every recovery look ambiguous. Scoped by requiring FILENAME so this
 * cannot quietly stub the module for anything else in the graph.
 */
const RELATIVE_QUICKBOOKS_SPECIFIER = "./quickbooks";

let POST: (req: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let permissionsPatchHit = false;
    let prismaPatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PERMISSIONS_SPECIFIER) {
            permissionsPatchHit = true;
            return fakePermissions;
        }
        if (id === PRISMA_SPECIFIER) {
            prismaPatchHit = true;
            return { prisma: fakePrisma };
        }
        if (id === QB_PAYMENTS_SPECIFIER) return fakeQbPayments;
        if (id === INTEGRATION_STORE_SPECIFIER) return fakeIntegrationStore;
        if (id === QUICKBOOKS_SPECIFIER
            || (id === RELATIVE_QUICKBOOKS_SPECIFIER && /qbo-document-sync/.test(this.filename ?? ""))) {
            // SPREAD the real module: the route also imports the deadline helper
            // and the whole error-classifier family from here, and a stub that
            // dropped them would make these tests pass against a route that
            // could not classify anything.
            // eslint-disable-next-line prefer-rest-params
            const real = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...real,
                syncEstimateToQB: async (_t: unknown, e: any, _gl: unknown, _d: unknown, requestId?: string) => {
                    state.posts.push({ kind: "estimate", requestId });
                    state.sentNotes.push(e?.privateNote);
                    state.onCreate?.();
                    if (state.createThrows) throw state.createThrows;
                    return { qbId: "qb-est-1", qbUrl: "https://qbo/est/1" };
                },
                syncInvoiceToQB: async (_t: unknown, i: any, _d: unknown, requestId?: string) => {
                    state.posts.push({ kind: "invoice", requestId });
                    state.sentNotes.push(i?.privateNote);
                    state.onCreate?.();
                    if (state.createThrows) throw state.createThrows;
                    return { qbId: "qb-inv-1", qbUrl: "https://qbo/inv/1" };
                },
                // The recovery probe. A THROW here is "QuickBooks did not
                // answer", which must never read as absence.
                findQBEstimatesByDocNumber: async (_t: unknown, doc: string) => {
                    state.lookup.calls.push(doc);
                    if (state.lookup.throws) throw state.lookup.throws;
                    return state.lookup.estimates;
                },
                findQBInvoicesByDocNumber: async (_t: unknown, doc: string) => {
                    state.lookup.calls.push(doc);
                    if (state.lookup.throws) throw state.lookup.throws;
                    return state.lookup.invoices;
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    try {
        routeModule = await import("../src/app/api/quickbooks/sync/route");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof routeModule.POST !== "function") {
        throw new Error(
            `qbo-sync-route-auth.test.ts: mock did not apply — route module's POST export is ` +
                `${typeof routeModule.POST}, not a function. "${PERMISSIONS_SPECIFIER}" patch ` +
                `${permissionsPatchHit ? "WAS" : "was NOT"} hit; "${PRISMA_SPECIFIER}" patch ` +
                `${prismaPatchHit ? "WAS" : "was NOT"} hit.`,
        );
    }
    POST = routeModule.POST as any;
    ({ documentPrivateNote } = await import("../src/lib/qbo-document-sync"));
});

beforeEach(() => {
    resetState();
});

function postRequest(body: unknown) {
    return new Request("http://localhost/api/quickbooks/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }) as any;
}

test("no session: 401, before any record lookup or QuickBooks call", async () => {
    state.user = null;
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 401);
});

test("FIELD_CREW session syncing an estimate: 403 — proxy auth is not enough", async () => {
    // FIELD_CREW's role defaults (access-rules.ts) do not include "estimates".
    state.user = { id: "u1", role: "FIELD_CREW", permissions: null };
    state.estimates["est-1"] = { id: "est-1", projectId: "proj-1", leadId: null };
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 403);
});

test("FIELD_CREW session syncing an invoice: 403", async () => {
    state.user = { id: "u1", role: "FIELD_CREW", permissions: null };
    state.invoices["inv-1"] = { id: "inv-1", projectId: "proj-1" };
    const res = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(res.status, 403);
});

test("ADMIN session, bogus estimate id: 404", async () => {
    state.user = { id: "u1", role: "ADMIN", permissions: null };
    const res = await POST(postRequest({ type: "estimate", id: "does-not-exist" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Estimate not found" });
});

test("ADMIN session, bogus invoice id: 404", async () => {
    state.user = { id: "u1", role: "ADMIN", permissions: null };
    const res = await POST(postRequest({ type: "invoice", id: "does-not-exist" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Invoice not found" });
});

test("a staff member holding the permission but with no access to THIS project: 403", async () => {
    // FINANCE's role defaults include "estimates" — the permission check alone
    // would let this through. Only the horizontal project-scope check catches it.
    state.user = { id: "u1", role: "FINANCE", permissions: null, projectAccess: [], assignedProjects: [] };
    state.estimates["est-1"] = { id: "est-1", projectId: "proj-not-theirs", leadId: null };
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 403);
});

test("unknown type: 400, before any auth check spends a session lookup", async () => {
    // type validation is cheap and happens first — no need to touch state.user.
    const res = await POST(postRequest({ type: "widget", id: "x" }));
    assert.equal(res.status, 400);
});

// ─── Round 38 gate, finding 5: the document sync was not idempotent ──────

/**
 * The route created a QuickBooks estimate or invoice, returned its id, and
 * persisted NOTHING — it never checked for an existing link and left no trace
 * of an attempt. `retry: false` on the ambiguous 503 is advice to a client, not
 * a constraint: a refresh re-POSTed and QuickBooks had no reason to refuse it,
 * so the client ended up with two documents and ProBuild pointed at neither.
 */
const ADMIN = { id: "u1", role: "ADMIN", permissions: null };

/** The note the create writes and the recovery matches on. */
let documentPrivateNote: (code: string, label: string | null) => string;

function seedEstimate(overrides: Record<string, any> = {}) {
    state.estimates["est-1"] = {
        id: "est-1", code: "EST-00001", title: "Kitchen", status: "Sent",
        qbEstimateId: null, qbSyncMarker: null, qbSyncedAt: null,
        totalAmount: 1000, balanceDue: 1000, createdAt: new Date(),
        itemsRevision: 7,
        projectId: "proj-1", leadId: null, items: [],
        project: { name: "Kitchen", client: { id: "cli-1" } },
        ...overrides,
    };
    return state.estimates["est-1"];
}

function seedInvoice(overrides: Record<string, any> = {}) {
    state.invoices["inv-1"] = {
        id: "inv-1", code: "INV-00001", projectId: "proj-1",
        qbInvoiceId: null, qbSyncMarker: null, qbSyncedAt: null,
        totalAmount: 1000, balanceDue: 1000, taxAmount: 0,
        client: { id: "cli-1" }, project: { name: "Kitchen" },
        ...overrides,
    };
    return state.invoices["inv-1"];
}

test("round 38: an already-linked estimate answers with the id it holds and never POSTs", async () => {
    state.user = ADMIN;
    seedEstimate({ qbEstimateId: "qb-est-existing" });
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.qbId, "qb-est-existing");
    assert.equal(body.alreadyLinked, true);
    assert.deepEqual(state.posts, [], "no create, and not even a token refresh");
});

test("round 38: a successful sync persists the id, and the replay makes no second document", async () => {
    state.user = ADMIN;
    const row = seedEstimate();

    const first = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).qbId, "qb-est-1");
    assert.equal(row.qbEstimateId, "qb-est-1", "the id is persisted, not merely returned");
    assert.equal(row.qbSyncMarker, null, "and the claim is cleared by the SAME write");
    assert.ok(row.qbSyncedAt instanceof Date);
    assert.equal(state.posts.length, 1);

    const replay = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal((await replay.json()).qbId, "qb-est-1");
    assert.equal(state.posts.length, 1, "the replay is served from the stored link");
});

test("round 39: the requestid is a bounded digest, and fits Intuit 36-char cap", async () => {
    // Intuit dedupes server-side on this, and its documented maximum is 36.
    // The first cut concatenated `${recordId}:${nonce}` — a CUID plus a UUID,
    // about 62 characters — and the tests hid it by using "est-1" as the id.
    // An oversized key is worse than none: the caller believes it is protected.
    const { syncRequestId, QB_REQUEST_ID_MAX_LEN } = await import("../src/lib/qbo-document-sync");
    const realCuid = "cmpkiymjc000292jntwa4ts9b";
    const realNonce = "9f1c0b7e-4a2d-4f3b-8c1e-2d5a6b7c8d9e";
    const marker = `create-in-flight:${realNonce}`;

    const id = syncRequestId(realCuid, marker);
    assert.ok(id.length <= QB_REQUEST_ID_MAX_LEN, `requestid is ${id.length} chars, cap is ${QB_REQUEST_ID_MAX_LEN}`);
    assert.equal(id, syncRequestId(realCuid, marker), "same attempt, same key — a replay must dedupe");
    assert.notEqual(id, syncRequestId(realCuid, `create-in-flight:${realNonce.replace("9f1c", "9f1d")}`),
        "a different attempt is a different key");
    assert.notEqual(id, syncRequestId(realCuid + "x", marker), "and so is a different record");
    // The unconcatenated form would have been 62 characters; assert the naive
    // shape really is over the cap, so this test fails if someone reverts it.
    assert.ok(`${realCuid}:${realNonce}`.length > QB_REQUEST_ID_MAX_LEN);

    // ...and the route actually sends that value.
    state.user = ADMIN;
    seedEstimate();
    await POST(postRequest({ type: "estimate", id: "est-1" }));
    const sent = state.posts[0].requestId as string;
    assert.ok(sent && sent.length <= QB_REQUEST_ID_MAX_LEN);
    assert.match(sent, /^[0-9a-f]+$/, "a digest, not a joined pair of ids");
});

test("round 38: an unconfirmed create parks the record, and the replay refuses", async () => {
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedEstimate();
    state.createThrows = new QBAmbiguousDocumentCreateError("QB estimate sync");

    const first = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(first.status, 503);
    assert.equal((await first.json()).reason, "ambiguous-create");
    assert.ok(String(row.qbSyncMarker).startsWith("ambiguous-create:"),
        `the claim is PROMOTED, not released, got ${row.qbSyncMarker}`);
    assert.equal(row.qbEstimateId, null, "and nothing is linked — we never learned an id");

    // Round 39 gate, finding 4: the replay does NOT create, and it does not
    // refuse forever either. It asks QuickBooks. Here the document is there,
    // so it is adopted.
    state.createThrows = null;
    // Provably ours: the canonical marker note the create wrote, the customer
    // it billed, and the total it expected. Anything less is not adopted.
    state.lookup.estimates = [{
        id: "qb-est-real", docNumber: "EST-00001",
        privateNote: documentPrivateNote("EST-00001", "Kitchen"),
        total: 1000, customerId: "42",
    }];
    const replay = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(body.qbId, "qb-est-real");
    assert.equal(body.recovered, true);
    assert.equal(row.qbEstimateId, "qb-est-real", "the id the create never told us is now recorded");
    assert.equal(row.qbSyncMarker, null, "and the claim is cleared by the SAME write");
    assert.equal(state.posts.length, 1, "no second document, however many times it is retried");
});

test("round 38: a definitive refusal RELEASES the claim, so the record can be synced again", async () => {
    // The mutation control for the test above. If the marker were kept on
    // every failure, a plain validation error would strand the record forever
    // and that test would be proving nothing about ambiguity in particular.
    state.user = ADMIN;
    const row = seedEstimate();
    state.createThrows = new Error("QB estimate sync failed: estimate has no billable line items");

    const first = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(first.status, 500);
    assert.equal(row.qbSyncMarker, null, "QuickBooks answered no — nothing was created");

    state.createThrows = null;
    const retry = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(retry.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-1");
    assert.equal(state.posts.length, 2, "and the retry really did send");
});

test("round 38: the invoice rail behaves identically", async () => {
    const { QB_REQUEST_ID_MAX_LEN } = await import("../src/lib/qbo-document-sync");
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedInvoice();

    await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(row.qbInvoiceId, "qb-inv-1");
    assert.equal(row.qbSyncMarker, null);
    assert.ok(String(state.posts[0].requestId).length <= QB_REQUEST_ID_MAX_LEN);

    const replay = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal((await replay.json()).alreadyLinked, true);
    assert.equal(state.posts.length, 1);

    // ...and a parked invoice goes through the same recovery.
    resetState();
    state.user = ADMIN;
    const parked = seedInvoice();
    state.createThrows = new QBAmbiguousDocumentCreateError("QB invoice sync");
    assert.equal((await POST(postRequest({ type: "invoice", id: "inv-1" }))).status, 503);
    assert.ok(String(parked.qbSyncMarker).startsWith("ambiguous-create:"));

    state.createThrows = null;
    state.lookup.invoices = [{
        id: "qb-inv-real", docNumber: "INV-00001",
        privateNote: documentPrivateNote("INV-00001", "Kitchen"),
        total: 1000, customerId: "42",
    }];
    const recovered = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal((await recovered.json()).qbId, "qb-inv-real");
    assert.equal(parked.qbInvoiceId, "qb-inv-real");
    assert.equal(parked.qbSyncMarker, null);
    assert.equal(state.posts.length, 1, "recovered by lookup — nothing was created");
});

test("round 39: a claimed record whose document is ABSENT may create again, on the same requestid", async () => {
    // The case that made the first cut unusable: a process death after the
    // claim and BEFORE the POST bricked the record permanently, because the
    // route refused any stored marker and nothing in the product could clear
    // one. QuickBooks says there is no such document, so a create is exactly
    // what should happen.
    //
    // And it reuses the ORIGINAL nonce: if the document did exist but the
    // query index had not caught up, the identical requestid makes Intuit
    // return that document instead of making a second one. Claiming a fresh
    // nonce would have thrown that protection away exactly when it counts.
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedEstimate();
    state.createThrows = new QBAmbiguousDocumentCreateError("QB estimate sync");
    await POST(postRequest({ type: "estimate", id: "est-1" }));
    const firstRequestId = state.posts[0].requestId;
    const parkedMarker = String(row.qbSyncMarker);
    assert.ok(parkedMarker.startsWith("ambiguous-create:"));

    state.createThrows = null;
    state.lookup.estimates = [];          // authoritatively none
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-1");
    assert.equal(row.qbSyncMarker, null);
    assert.equal(state.posts.length, 2, "it really did create this time");
    assert.equal(state.posts[1].requestId, firstRequestId,
        "same nonce, same requestid — Intuit dedupes if the first one had landed");
});

test("round 39: an ambiguous probe keeps refusing and does NOT clear the claim", async () => {
    // The mutation control for the test above. If "could not ask" were treated
    // as "there is none", that test would pass while the route cheerfully
    // created a duplicate every time QuickBooks was unreachable.
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedEstimate();
    state.createThrows = new QBAmbiguousDocumentCreateError("QB estimate sync");
    await POST(postRequest({ type: "estimate", id: "est-1" }));
    const parkedMarker = String(row.qbSyncMarker);

    state.createThrows = null;
    state.lookup.throws = new Error("QuickBooks is unavailable");
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.retry, true, "retry LATER, not never — the sweep keeps trying too");
    assert.equal(row.qbSyncMarker, parkedMarker, "the claim is untouched");
    assert.equal(row.qbEstimateId, null);
    assert.equal(state.posts.length, 1, "and nothing was created on a question QuickBooks did not answer");
    // The operator text must not tell anyone to do something impossible.
    assert.doesNotMatch(String(body.error), /record its id|clear the marker/i);
});

test("round 39: documents under our code that are NOT ours are never adopted", async () => {
    // A hand-created QuickBooks estimate that happens to reuse the code is not
    // this record. Adopting it would link ProBuild to somebody else document;
    // creating alongside it is the duplicate this mechanism exists to stop.
    // Neither: ask a human.
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedEstimate();
    state.createThrows = new QBAmbiguousDocumentCreateError("QB estimate sync");
    await POST(postRequest({ type: "estimate", id: "est-1" }));

    state.createThrows = null;
    state.lookup.estimates = [{
        id: "qb-someone-else", docNumber: "EST-00001", privateNote: "Not ours",
        total: 1000, customerId: "42",
    }];
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 503);
    assert.equal(row.qbEstimateId, null, "not adopted");
    assert.equal(state.posts.length, 1, "and not duplicated either");
});

// ─── Round 40 gate, finding 2: the claim must protect the PAYLOAD ───

/**
 * Between the read at the top of the handler and the link write sit a token
 * refresh, a customer resolve and the document create — seconds of remote calls.
 * The claim pinned only `(id, unlinked, unclaimed)` and the finalize pinned only
 * the marker, so an edit landing in that window left the record LINKED to a
 * QuickBooks document describing something else, with nothing recording it.
 */
test("round 40: an item edit between claim and finalize does NOT link the document", async () => {
    state.user = ADMIN;
    const row = seedEstimate();

    // Somebody edits the estimate while the create is in flight. itemsRevision
    // is the canonical optimistic-concurrency token for items (#327) and moves
    // on ANY item write, which is why the finalize CAS pins it. Mutating the
    // row from inside the create is exactly when a concurrent editor would.
    state.onCreate = () => { row.itemsRevision = 99; };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();

    assert.equal(res.status, 409, "the document exists but must not be linked");
    assert.equal(body.qbId, "qb-est-1", "and the caller is told what was created");
    assert.equal(row.qbEstimateId, null, "the record is NOT linked to a stale document");
    assert.equal(state.posts.length, 1);
});

test("round 40: an UNEDITED estimate still links (the control)", async () => {
    // Without this, the test above would pass just as happily against a
    // finalize CAS that never matched anything.
    state.user = ADMIN;
    const row = seedEstimate();
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-1");
});

test("round 40: a customer remap between resolve and claim refuses BEFORE any create", async () => {
    // `resolveCustomerAndItem` answers, and then the mapping moves. The claim
    // re-reads Client.qbCustomerId under the money locks and refuses, so the
    // payload identity can never describe a customer the database disagrees
    // with — and nothing is sent at all.
    state.user = ADMIN;
    const row = seedEstimate();
    state.clientQbCustomerId = "99";   // remapped since the resolve returned 42

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.retry, true);
    assert.match(String(body.error), /customer changed/);
    assert.equal(state.posts.length, 0, "nothing reached QuickBooks");
    assert.equal(row.qbSyncMarker, null, "and no claim was left behind");
    assert.ok(state.locksTaken > 0, "the decision was taken under the money locks");
});

test("round 40: the claim records the realm, customer, note and total that were SENT", async () => {
    // Finding 3 depends on this: recovery can only prove ownership from what
    // the claim recorded, so the claim has to record it.
    const { parseCreateMarker } = await import("../src/lib/qbo-create-markers");
    state.user = ADMIN;
    const row = seedEstimate();
    state.createThrows = new (await import("../src/lib/quickbooks")).QBAmbiguousDocumentCreateError("x");
    await POST(postRequest({ type: "estimate", id: "est-1" }));

    const identity = parseCreateMarker(row.qbSyncMarker)?.identity;
    assert.equal(identity?.docNumber, "EST-00001");
    assert.equal(identity?.privateNote, documentPrivateNote("EST-00001", "Kitchen"));
    assert.equal(identity?.realmId, "realm-1");
    assert.equal(identity?.customerId, "42");
    assert.equal(identity?.expectedTotal, 1000);
    assert.ok(identity?.issuanceHash, "and a fingerprint of the payload it built");
});

test("round 40: the create sends the canonical marker note on BOTH rails", async () => {
    // The invoice rail used to send no PrivateNote at all, which left its
    // recovery matching on DocNumber alone.
    state.user = ADMIN;
    seedEstimate();
    seedInvoice();
    await POST(postRequest({ type: "estimate", id: "est-1" }));
    await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(state.sentNotes[0], documentPrivateNote("EST-00001", "Kitchen"));
    assert.equal(state.sentNotes[1], documentPrivateNote("INV-00001", "Kitchen"));
});
