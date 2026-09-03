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
import { qboTxnDate } from "../src/lib/quickbooks";

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
    /** Bend one field of what QuickBooks says it booked. */
    createdDocumentPatch: Record<string, unknown> | null;
    /** A create response that describes no document at all. */
    createdDocumentNull: boolean;
    /** Every TxnDate the route actually sent, in order. */
    sentTxnDates: Array<string | undefined>;
    /** Every service item id the route actually sent, in order. */
    sentItemIds: Array<string | undefined>;
    /** Which client the document CURRENTLY hangs off, as read under its lock. */
    projectClientId: string;
    /** The QuickBooks company the tokens are for RIGHT NOW. */
    connectedRealm: string;
    /** How many times the route resolved (and therefore wrote) the mapping. */
    resolves: number;
    /** What a resolution answers, and persists. */
    resolvedCustomerId: string;
    resolvedItemId: string;
    locksTaken: number;
    /** Every row lock taken, in order, as `SQL|values`. */
    locks: string[];
    /** Fired as the FIRST row lock is granted — the peek-goes-stale window. */
    onFirstLock: (() => void) | null;
    /** Fired inside the create, to model a concurrent edit mid-flight. */
    onCreate: (() => void) | null;
    /**
     * Fired once, right after the handler's FIRST read of the record ' — ' the only
     * window in which an edit can make the pre-lock copy and the locked
     * snapshot disagree.
     */
    onFirstRead: (() => void) | null;
    /** The PrivateNote each create actually sent. */
    sentNotes: Array<string | undefined>;
    /** The line items and total each create actually sent. */
    sentItems: any[][];
    sentTotals: number[];
} = {
    user: null, estimates: {}, invoices: {}, posts: [], createThrows: null,
    lookup: { estimates: [], invoices: [], throws: null, calls: [] },
    clientQbCustomerId: "42", locksTaken: 0, onCreate: null, onFirstRead: null, sentNotes: [], sentItems: [], sentTotals: [],
    createdDocumentPatch: null, createdDocumentNull: false, sentTxnDates: [], sentItemIds: [], projectClientId: "cli-1", locks: [], onFirstLock: null,
    connectedRealm: "realm-1", resolves: 0, resolvedCustomerId: "42", resolvedItemId: "7",
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
    state.locks = [];
    state.onFirstLock = null;
    state.connectedRealm = "realm-1";
    state.resolves = 0;
    state.resolvedCustomerId = "42";
    state.resolvedItemId = "7";
    state.onCreate = null;
    state.onFirstRead = null;
    state.sentNotes = [];
    state.sentItems = [];
    state.sentTotals = [];
    state.sentTxnDates = [];
    state.sentItemIds = [];
    state.createdDocumentPatch = null;
    state.createdDocumentNull = false;
    state.projectClientId = "cli-1";
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
        findUnique: async (args: { where: { id: string } }) => {
            const row = rows[args.where.id];
            if (!row) return null;
            const snapshot = { ...row };
            // AFTER the copy is taken: the caller keeps the old state, the next
            // read sees the new one. That is the interleaving.
            const hook = state.onFirstRead;
            if (hook) {
                state.onFirstRead = null;
                hook();
            }
            return snapshot;
        },
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
    // Records the STATEMENT, not just a count: round 46 is about which rows
    // get locked and in what order, and a counter cannot tell
    // "locked the client the caller named" from "locked the client the
    // document actually hangs off".
    $queryRaw: async (strings?: TemplateStringsArray, ...values: any[]) => {
        state.locksTaken++;
        if (strings) state.locks.push(`${strings.join("?")}|${values.join(",")}`);
        // Fires as the FIRST lock is granted: after the lock-free peek, before
        // the re-read that has to catch a document which moved in between.
        if (state.locks.length === 1) {
            const hook = state.onFirstLock;
            if (hook) { state.onFirstLock = null; hook(); }
        }
        return [];
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
};

/**
 * What QuickBooks says it booked.
 *
 * A REAL create response echoes the document back, and the route now holds
 * that answer to the same rule a recovery holds a candidate to. The fake used
 * to return an id and nothing else, which described a QuickBooks that cannot
 * exist and left the direct path's new check with nothing to check.
 *
 * By default it echoes exactly what the payload sent, so a create matches its
 * own claim. `state.createdDocumentPatch` bends one field (what Automated
 * Sales Tax, a QuickBooks-side item edit, or a cross-midnight replay does in
 * production); `state.createdDocumentNull` models a response that describes
 * nothing at all.
 */
function createdDocument(id: string, sent: any) {
    if (state.createdDocumentNull) return null;
    return {
        id,
        docNumber: sent?.code ?? null,
        privateNote: sent?.privateNote ?? null,
        total: sent?.totalAmount ?? null,
        customerId: sent?.customerId ?? null,
        txnDate: sent?.txnDate ?? null,
        itemIds: sent?.itemId ? [sent.itemId] : [],
        ...(state.createdDocumentPatch ?? {}),
    };
}

const fakeQbPayments = {
    getFreshQBTokens: async () => ({ accessToken: "a", refreshToken: "r", realmId: state.connectedRealm }),
    // COUNTED, because the point of round 47 is that recovery must not call
    // this at all: it WRITES Client.qbCustomerId and the stored service item,
    // so calling it while connected to another company corrupts the mapping
    // before the realm can even be refused.
    resolveCustomerAndItem: async () => {
        state.resolves++;
        state.clientQbCustomerId = state.resolvedCustomerId;
        return { customerId: state.resolvedCustomerId, itemId: state.resolvedItemId };
    },
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
/**
 * Same trap, one module along: `decideUnderIdentity` now lives in
 * qbo-document-sync.ts, which imports prisma RELATIVELY. Patching only the
 * route alias left the identity decision talking to a real PrismaClient, so
 * every request 500ed. Scoped by requiring FILENAME so this cannot stub the
 * module for anything else in the graph.
 */
const RELATIVE_PRISMA_SPECIFIER = "./prisma";

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
        if (id === RELATIVE_PRISMA_SPECIFIER && /qbo-document-sync/.test(this.filename ?? "")) {
            return { prisma: fakePrisma };
        }
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
                    state.sentItems.push(e?.items ?? []);
                    state.sentTotals.push(e?.totalAmount);
                    state.sentTxnDates.push(e?.txnDate);
                    state.sentItemIds.push(e?.itemId);
                    state.onCreate?.();
                    if (state.createThrows) throw state.createThrows;
                    return {
                        qbId: "qb-est-1",
                        qbUrl: "https://qbo/est/1",
                        document: createdDocument("qb-est-1", e),
                    };
                },
                syncInvoiceToQB: async (_t: unknown, i: any, _d: unknown, requestId?: string) => {
                    state.posts.push({ kind: "invoice", requestId });
                    state.sentNotes.push(i?.privateNote);
                    state.sentTxnDates.push(i?.txnDate);
                    state.sentItemIds.push(i?.itemId);
                    state.onCreate?.();
                    if (state.createThrows) throw state.createThrows;
                    return {
                        qbId: "qb-inv-1",
                        qbUrl: "https://qbo/inv/1",
                        document: createdDocument("qb-inv-1", i),
                    };
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
        // `loadDocumentIdentity` reads the customer from the nested Client under
        // the lock, so the remap knob has to live there — not only on the
        // separate client.findUnique the claim used to consult.
        // `projectId`/`project.clientId` are SCALARS the decision reads under the
        // document's own lock, to find out which project and client rows to lock
        // next (round 46). Reading them through relations took no lock at all.
        project: {
            id: "proj-1",
            get clientId() { return state.projectClientId; },
            name: "Kitchen",
            client: { id: "cli-1", get qbCustomerId() { return state.clientQbCustomerId; } },
        },
        ...overrides,
    };
    return state.estimates["est-1"];
}

function seedInvoice(overrides: Record<string, any> = {}) {
    state.invoices["inv-1"] = {
        id: "inv-1", code: "INV-00001", projectId: "proj-1",
        // The SCALAR the decision reads under the invoice's lock — see seedEstimate.
        get clientId() { return state.projectClientId; },
        qbInvoiceId: null, qbSyncMarker: null, qbSyncedAt: null,
        totalAmount: 1000, balanceDue: 1000, taxAmount: 0,
        client: { id: "cli-1", get qbCustomerId() { return state.clientQbCustomerId; } },
        project: { name: "Kitchen" },
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
        total: 1000, customerId: "42", txnDate: qboTxnDate(), itemIds: ["7"],
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
        total: 1000, customerId: "42", txnDate: qboTxnDate(), itemIds: ["7"],
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
        total: 1000, customerId: "42", txnDate: qboTxnDate(), itemIds: ["7"],
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
    // The remap lands AFTER the resolve (which persists what it resolved) and
    // BEFORE the guarded re-read under the locks — the only window this guard
    // exists for. Pre-setting the value instead would also have passed against
    // a route that simply never resolved.
    state.onFirstLock = () => { state.clientQbCustomerId = "99"; };

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

// ─── Round 41 gate, findings 1 + 2: EVERY decision recomputes the identity ───

/**
 * Rounds 39, 40 and 41 each found the same bug somewhere new: a decision
 * comparing SOME of the state and missing whichever field the next reviewer
 * thought of. Adoption and replay were the two that still did it — both moved
 * on `(id, unlinked, marker)` alone and never asked whether the record still
 * described what was sent.
 */
async function parkEstimate() {
    // Leaves the estimate carrying an ambiguous-create claim.
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.createThrows = new QBAmbiguousDocumentCreateError("QB estimate sync");
    await POST(postRequest({ type: "estimate", id: "est-1" }));
    state.createThrows = null;
}

test("round 41: an edit after an ambiguous create is NOT adopted", async () => {
    state.user = ADMIN;
    const row = seedEstimate();
    await parkEstimate();

    // The document IS in QuickBooks and provably ours — but the record has
    // moved since, so linking it would attach a stale document to changed money.
    state.lookup.estimates = [{
        id: "qb-est-real", docNumber: "EST-00001",
        privateNote: documentPrivateNote("EST-00001", "Kitchen"),
        total: 1000, customerId: "42", txnDate: qboTxnDate(), itemIds: ["7"],
    }];
    row.itemsRevision = 99;

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.reason, "identity-mismatch");
    assert.equal(body.retry, false, "retrying will not help — only a human can settle it");
    assert.equal(body.qbId, "qb-est-real", "and the operator is told which document to look at");
    assert.equal(row.qbEstimateId, null, "not linked");
    assert.equal(state.posts.length, 1, "and not re-created either");
});

test("round 41: an UNEDITED record is still adopted (the control)", async () => {
    state.user = ADMIN;
    const row = seedEstimate();
    await parkEstimate();
    state.lookup.estimates = [{
        id: "qb-est-real", docNumber: "EST-00001",
        privateNote: documentPrivateNote("EST-00001", "Kitchen"),
        total: 1000, customerId: "42", txnDate: qboTxnDate(), itemIds: ["7"],
    }];
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-real");
});

test("round 41: an edited record with an ABSENT document does not replay the old identity", async () => {
    // The replay reuses the old claim, and therefore its requestid. That is only
    // safe while the payload is still the one that claim describes — otherwise
    // it would send NEW content under the OLD identity, and Intuit dedupe could
    // hand back the old document for it.
    state.user = ADMIN;
    const row = seedEstimate();
    await parkEstimate();
    state.lookup.estimates = [];          // authoritatively none
    row.totalAmount = 4321;               // repriced since the claim

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.reason, "identity-mismatch");
    assert.equal(state.posts.length, 1, "no create under an identity that no longer describes it");
    assert.ok(String(row.qbSyncMarker).startsWith("ambiguous-create:"), "the claim is untouched");
});

test("round 41: an UNEDITED record with an absent document still replays (the control)", async () => {
    state.user = ADMIN;
    const row = seedEstimate();
    await parkEstimate();
    state.lookup.estimates = [];
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-1");
    assert.equal(state.posts.length, 2, "it really did create the second time");
});

test("round 41: a legacy claim carrying no payload hash is parked, never adopted", async () => {
    // Markers written before this rail fingerprinted the payload cannot be
    // verified. Adopting on the fields that happen to be present is exactly the
    // guess the whole mechanism exists to refuse.
    //
    // Round 47 moved WHERE this one is refused, not whether: a marker with no
    // recorded service item cannot be replayed against the item the settings
    // happen to name today, so it is now parked before any resolution runs. The
    // hash refusal still stands for a marker that records customer and item but
    // no fingerprint — covered by the test below.
    const { composeSyncMarker, documentPrivateNote: note } = await import("../src/lib/qbo-document-sync");
    const { CREATE_IN_FLIGHT_MARKER } = await import("../src/lib/qbo-create-markers");
    state.user = ADMIN;
    const row = seedEstimate();
    row.qbSyncMarker = composeSyncMarker(CREATE_IN_FLIGHT_MARKER, {
        docNumber: "EST-00001",
        privateNote: note("EST-00001", "Kitchen"),
        expectedTotal: 1000,
        realmId: "realm-1",
        customerId: "42",
        // no issuanceHash: the legacy shape
    } as any);
    state.lookup.estimates = [{
        id: "qb-est-real", docNumber: "EST-00001",
        privateNote: note("EST-00001", "Kitchen"), total: 1000, customerId: "42", txnDate: qboTxnDate(), itemIds: ["7"],
    }];

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.match(String(body.error), /does not record the QuickBooks customer and service item/);
    assert.equal(row.qbEstimateId, null);
});

test("round 47: a claim recording customer and item but NO payload hash is still parked", async () => {
    // The original round-41 shape, now reachable only once the identity is
    // complete enough to replay. Adoption still refuses without a fingerprint.
    const { composeSyncMarker, documentPrivateNote: note } = await import("../src/lib/qbo-document-sync");
    const { CREATE_IN_FLIGHT_MARKER } = await import("../src/lib/qbo-create-markers");
    state.user = ADMIN;
    const row = seedEstimate();
    row.qbSyncMarker = composeSyncMarker(CREATE_IN_FLIGHT_MARKER, {
        docNumber: "EST-00001",
        privateNote: note("EST-00001", "Kitchen"),
        expectedTotal: 1000,
        realmId: "realm-1",
        customerId: "42",
        itemId: "7",
        txnDate: qboTxnDate(),
        // still no issuanceHash
    } as any);
    state.lookup.estimates = [{
        id: "qb-est-real", docNumber: "EST-00001",
        privateNote: note("EST-00001", "Kitchen"), total: 1000, customerId: "42", txnDate: qboTxnDate(), itemIds: ["7"],
    }];

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.match(String(body.error), /did not fingerprint the payload/);
    assert.equal(row.qbEstimateId, null);
});

test("round 41: a project RENAME between claim and finalize does not link", async () => {
    // The rename changes the QuickBooks document description, and the old
    // finalize pinned itemsRevision/totalAmount/title — none of which move.
    state.user = ADMIN;
    const row = seedEstimate();
    state.onCreate = () => { row.project.name = "Kitchen (phase 2)"; };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 409);
    assert.equal(row.qbEstimateId, null, "the document describes a project name that has changed");
});

test("round 41: a client REMAP between claim and finalize does not link", async () => {
    // Another field no column on the estimate records.
    state.user = ADMIN;
    const row = seedEstimate();
    state.onCreate = () => { state.clientQbCustomerId = "99"; };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 409);
    assert.equal(row.qbEstimateId, null);
});

test("round 41: a REPARENT (losing the billable client) between claim and finalize does not link", async () => {
    state.user = ADMIN;
    const row = seedEstimate();
    state.onCreate = () => { row.project = null; };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 409);
    assert.equal(row.qbEstimateId, null);
});

// ─── Round 42 gate, finding 2: hash and payload come from ONE read ───

test("round 42: an edit before the claim is SENT, not just fingerprinted", async () => {
    // The claim reloaded state under the locks while the POST still used the
    // copy read at the top of the handler. An edit committed in that window made
    // the marker fingerprint the NEW state while QuickBooks received the OLD
    // lines and totals — and finalize, comparing the new state against a marker
    // that also described it, recorded the link as if nothing had happened.
    state.user = ADMIN;
    const row = seedEstimate();
    row.items = [{ id: "it-1", parentId: null, name: "Old", quantity: 1, unitCost: 100, total: 100, type: "Material" }];
    row.totalAmount = 100;

    // Lands between the handler's read and the locked read the claim takes.
    state.onFirstRead = () => {
        row.items = [{ id: "it-1", parentId: null, name: "New", quantity: 2, unitCost: 250, total: 500, type: "Material" }];
        row.totalAmount = 500;
    };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    const sent = state.sentItems[0];
    assert.equal(sent?.[0]?.name, "New", "QuickBooks must receive the state the claim fingerprinted");
    assert.equal(state.sentTotals[0], 500);
    assert.equal(row.qbEstimateId, "qb-est-1", "and the link is recorded");
});

// ─── Round 43 gate, finding 2: an unreadable marker is answered ───

test("round 43: an unrecognised marker gets an explicit 409, not a silent CAS miss", async () => {
    // It used to fall through to the FRESH-CLAIM branch, whose CAS requires
    // `qbSyncMarker: null` — so it could never match, and the caller got the
    // generic "another sync claimed it first" with nothing to act on, forever.
    state.user = ADMIN;
    const row = seedEstimate();
    row.qbSyncMarker = "legacy-value-nobody-writes-any-more";

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.reason, "sync-marker-unrecognised");
    assert.equal(body.retry, false, "retrying cannot help — only an admin can clear it");
    assert.equal(body.markerLength, row.qbSyncMarker.length);
    // The value itself is an opaque string of unknown provenance on a money-path
    // record: enough to recognise it in the database, never the whole thing.
    assert.ok(!String(body.error).includes(row.qbSyncMarker), "the full value is not echoed");
    assert.equal(state.posts.length, 0, "and nothing was sent to QuickBooks");
    assert.equal(row.qbEstimateId, null);
});

test("round 43: the invoice rail refuses one too", async () => {
    state.user = ADMIN;
    const row = seedInvoice();
    row.qbSyncMarker = "??";
    const res = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "sync-marker-unrecognised");
    assert.equal(state.posts.length, 0);
});

test("round 43: a CLEAN row still syncs (the control)", async () => {
    // Without this, a guard that refused everything would satisfy both tests
    // above and break the product.
    state.user = ADMIN;
    const row = seedEstimate();
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-1");
});

// --- Round 46: what QuickBooks BOOKED is judged, not just its id ---

/**
 * The finding: recovery validated a candidate's total before adopting it, but
 * a create whose response arrived was linked on its `Id` alone. So the
 * identical QuickBooks document was accepted or refused depending only on
 * whether the first response came back — a property of the network, not of the
 * document. Automated Sales Tax recomputing the tax line is the everyday way
 * the two diverge.
 */
test("round 46: a created document whose TOTAL differs is parked, never linked", async () => {
    const { markerKind, parseCreateMarker, AMBIGUOUS_CREATE_MARKER } = await import("../src/lib/qbo-create-markers");
    state.user = ADMIN;
    const row = seedEstimate();
    state.createdDocumentPatch = { total: 1200 };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    const body = await res.json();

    assert.equal(res.status, 409);
    assert.equal(body.reason, "created-document-mismatch");
    assert.equal(body.qbId, "qb-est-1");
    assert.match(body.error, /total is \$1200\.00/);
    assert.equal(row.qbEstimateId, null, "a document for the wrong money is never linked");
    assert.equal(markerKind(row.qbSyncMarker), AMBIGUOUS_CREATE_MARKER, "the row is parked");
    assert.equal(
        parseCreateMarker(row.qbSyncMarker)?.identity?.qbId,
        "qb-est-1",
        "and the marker names the document a human has to go and fix",
    );
});

test("round 46: a created document dated into another period is parked", async () => {
    state.user = ADMIN;
    const row = seedEstimate();
    state.createdDocumentPatch = { txnDate: "2019-01-01" };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /different accounting period/);
    assert.equal(row.qbEstimateId, null);
});

test("round 46: a created document booked to another ITEM is parked", async () => {
    // The item decides the income account. Note, customer, total and date can
    // all agree while the money books somewhere else entirely.
    state.user = ADMIN;
    const row = seedEstimate();
    state.createdDocumentPatch = { itemIds: ["7", "99"] };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /QuickBooks item 99/);
    assert.equal(row.qbEstimateId, null);
});

test("round 46: a create response that describes nothing is parked, not linked", async () => {
    state.user = ADMIN;
    const row = seedEstimate();
    state.createdDocumentNull = true;

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /did not describe the document it created/);
    assert.equal(row.qbEstimateId, null);
});

test("round 46: the invoice rail is judged identically", async () => {
    const { markerKind, AMBIGUOUS_CREATE_MARKER } = await import("../src/lib/qbo-create-markers");
    state.user = ADMIN;
    const row = seedInvoice();
    state.createdDocumentPatch = { total: 999 };

    const res = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "created-document-mismatch");
    assert.equal(row.qbInvoiceId, null);
    assert.equal(markerKind(row.qbSyncMarker), AMBIGUOUS_CREATE_MARKER);
});

test("round 46: a document that MATCHES its claim still links (the control)", async () => {
    // Without this the four tests above would also pass against a route that
    // refused every create.
    state.user = ADMIN;
    const row = seedEstimate();

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-1");
    assert.equal(row.qbSyncMarker, null);
});

// --- Round 46: the claim records the date and the item, and a replay reuses them ---

test("round 46: the claim records the TxnDate and the ItemRef that were sent", async () => {
    const { parseCreateMarker } = await import("../src/lib/qbo-create-markers");
    const { qboTxnDate } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedEstimate();
    // Parked, so the marker survives the call and can be read back.
    await parkEstimate();

    const identity = parseCreateMarker(row.qbSyncMarker)?.identity;
    assert.equal(identity?.txnDate, qboTxnDate(), "the accounting date the payload carried");
    assert.equal(identity?.itemId, "7", "the service item every line carried");
});

test("round 46: a REPLAY re-sends the original accounting date, not todays", async () => {
    // The whole point of a replay is to re-send the SAME document. Deriving the
    // date at send time meant a retry after midnight, or after a period close,
    // quietly produced a different one — and recovery, which never looked at a
    // date, adopted it.
    const { parseCreateMarker, AMBIGUOUS_CREATE_MARKER } = await import("../src/lib/qbo-create-markers");
    const { composeSyncMarker } = await import("../src/lib/qbo-document-sync");
    const { qboTxnDate } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedEstimate();
    await parkEstimate();

    // Re-date the claim to model one taken before midnight: same identity, same
    // claim time, only the recorded TxnDate differs from today.
    const parsed = parseCreateMarker(row.qbSyncMarker);
    const originalDate = "2020-02-02";
    row.qbSyncMarker = composeSyncMarker(
        AMBIGUOUS_CREATE_MARKER,
        { ...(parsed?.identity as any), txnDate: originalDate },
        new Date(parsed?.atMs ?? Date.now()),
    );
    // QuickBooks holds nothing under that DocNumber, so the claim replays...
    state.lookup.estimates = [];
    // ...and the document it books carries the replayed date, so it matches.
    state.createdDocumentPatch = { txnDate: originalDate };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));

    assert.equal(res.status, 200);
    assert.equal(
        state.sentTxnDates[state.sentTxnDates.length - 1],
        originalDate,
        "the replay re-sent the ORIGINAL accounting date",
    );
    assert.notEqual(originalDate, qboTxnDate(), "and that is not simply today");
});

// --- Round 46: the decision locks the rows it reads ---

/**
 * The finding: `decideUnderIdentity` locked the `clientId` the CALLER passed —
 * read before the transaction opened — and then read the project, the
 * project's client and `Project.name` through relations, which take no lock at
 * all. A rename or a re-point committing in between was invisible to it.
 *
 * So the order has to be: lock the document, read from IT which project and
 * client it currently hangs off, lock those, and only then read the identity.
 */
test("round 46: the decision locks Project first, then Estimate, then Client", async () => {
    state.user = ADMIN;
    seedEstimate();

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);

    // PROJECT FIRST. Not the foreign-key direction — the direction every
    // attribution writer takes (`lockAttributionParents`). A money path that
    // locked the Estimate first and then reached for the Project would close a
    // 40P01 cycle against a Project-first editor holding the project and
    // waiting on the estimate.
    assert.match(state.locks[0], /"Project"[\s\S]*FOR SHARE[\s\S]*proj-1/);
    assert.match(state.locks[1], /"Estimate"[\s\S]*FOR UPDATE[\s\S]*est-1/);
    assert.match(state.locks[2], /"Client"[\s\S]*FOR SHARE[\s\S]*cli-1/);
});

test("round 46: the invoice rail locks Project first too", async () => {
    state.user = ADMIN;
    seedInvoice();

    const res = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(res.status, 200);

    assert.match(state.locks[0], /"Project"[\s\S]*FOR SHARE[\s\S]*proj-1/);
    assert.match(state.locks[1], /"Invoice"[\s\S]*FOR UPDATE[\s\S]*inv-1/);
    assert.match(state.locks[2], /"Client"[\s\S]*FOR SHARE[\s\S]*cli-1/);
});

test("round 46: a document re-pointed at another client is refused, never synced", async () => {
    // The caller resolved its QuickBooks customer against the client it read
    // before the transaction. If the document now hangs off a different one,
    // the payload and the record disagree about who is being billed.
    state.user = ADMIN;
    const row = seedEstimate();
    state.projectClientId = "cli-2";

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));

    assert.equal(res.status, 503, JSON.stringify(await res.clone().json()));
    assert.match((await res.json()).error, /different client/);
    assert.equal(state.posts.length, 0, "refused BEFORE any QuickBooks call");
    assert.equal(row.qbSyncMarker, null, "and nothing was claimed");
});

test("round 46: a document moved to another PROJECT between peek and lock is refused", async () => {
    // The peek only says which rows to lock. If the document moved between the
    // peek and the locks, the transaction is holding the WRONG project row —
    // refusing is the only honest answer.
    state.user = ADMIN;
    const row = seedEstimate();
    // The move commits while the first lock is being granted: the peek said
    // proj-1 (and that is the row now held), the re-read says proj-2.
    state.onFirstLock = () => { row.project = { ...row.project, id: "proj-2" }; };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));

    assert.equal(res.status, 503, JSON.stringify(await res.clone().json()));
    assert.match((await res.json()).error, /different project/);
    assert.equal(state.posts.length, 0, "refused BEFORE any QuickBooks call");
});

test("round 46: a project RENAMED between the claim and the link does not link", async () => {
    // `Project.name` rides in the PrivateNote QuickBooks stores, so a rename
    // makes the document already sent describe a project that no longer exists
    // under that name. The finalize recomputes the identity under the locks and
    // must see it.
    state.user = ADMIN;
    const row = seedEstimate();
    // Fires during the create: after the claim, before the finalize.
    state.onCreate = () => { row.project.name = "Kitchen Remodel v2"; };

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));

    assert.equal(res.status, 409);
    assert.equal(row.qbEstimateId, null, "the document is not linked to a record that moved");
});

test("round 46: an UNTOUCHED project still syncs (the control)", async () => {
    state.user = ADMIN;
    const row = seedEstimate();

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 200);
    assert.equal(row.qbEstimateId, "qb-est-1");
});

// --- Round 47: a stored claim freezes the identity, and recovery honours it ---

/**
 * `resolveCustomerAndItem` is not a read — it PERSISTS `Client.qbCustomerId`
 * and the service item. Both branches used to call it before so much as
 * looking at the stored marker, so reconnecting to another QuickBooks company
 * overwrote the local mapping with that company's ids, and only THEN did the
 * recovery refuse the realm. The refusal did not undo the corruption.
 */
test("round 47: a realm change under a stored claim parks BEFORE anything resolves", async () => {
    state.user = ADMIN;
    const row = seedEstimate();
    await parkEstimate();
    const mappingBefore = state.clientQbCustomerId;
    state.resolves = 0;
    // Reconnected to a different company, which would resolve to ITS ids.
    state.connectedRealm = "realm-2";
    state.resolvedCustomerId = "999";

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));

    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /claimed against QuickBooks company realm-1 and realm-2 is connected now/);
    assert.equal(state.resolves, 0, "nothing resolved, so nothing was written");
    assert.equal(state.clientQbCustomerId, mappingBefore, "the local mapping is untouched");
    assert.equal(state.lookup.calls.length, 0, "and QuickBooks was never asked about the other company");
    assert.equal(row.qbEstimateId, null);
});

test("round 47: the invoice rail refuses a realm change the same way", async () => {
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedInvoice();
    state.createThrows = new QBAmbiguousDocumentCreateError("QB invoice sync");
    await POST(postRequest({ type: "invoice", id: "inv-1" }));
    state.createThrows = null;
    state.resolves = 0;
    state.connectedRealm = "realm-2";

    const res = await POST(postRequest({ type: "invoice", id: "inv-1" }));

    assert.equal(res.status, 409);
    assert.equal(state.resolves, 0);
    assert.equal(row.qbInvoiceId, null);
});

test("round 47: a REPLAY sends the item frozen in the claim, not the one configured now", async () => {
    // The replay reuses the original `requestid`. Sending different content
    // under the same idempotency key is how a document lands against the wrong
    // income account and is then parked as mismatched — the item decides the
    // account, and nothing in the payload hash notices it moving.
    state.user = ADMIN;
    seedEstimate();
    await parkEstimate();
    state.resolves = 0;
    // The configured service item has changed since the claim.
    state.resolvedItemId = "99";
    state.lookup.estimates = [];

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));

    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(state.resolves, 0, "a recovery resolves nothing");
    assert.equal(
        state.sentItemIds[state.sentItemIds.length - 1],
        "7",
        "the replay sent the item the claim froze, not the newly configured one",
    );
});

test("round 47: a FRESH create still resolves, and sends what it resolved (control)", async () => {
    // Without this the tests above would also pass against a route that never
    // resolved at all, which could not create a first document.
    state.user = ADMIN;
    seedEstimate();
    state.resolvedItemId = "12";

    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));

    assert.equal(res.status, 200);
    assert.equal(state.resolves, 1, "a fresh create is the one path that may resolve");
    assert.equal(state.sentItemIds[0], "12");
});
