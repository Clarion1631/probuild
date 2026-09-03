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
} = { user: null, estimates: {}, invoices: {}, posts: [], createThrows: null };

function resetState() {
    state.user = null;
    state.estimates = {};
    state.invoices = {};
    state.posts = [];
    state.createThrows = null;
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
        findUnique: async (args: { where: { id: string } }) => rows[args.where.id] ?? null,
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
        if (id === QUICKBOOKS_SPECIFIER) {
            // SPREAD the real module: the route also imports the deadline helper
            // and the whole error-classifier family from here, and a stub that
            // dropped them would make these tests pass against a route that
            // could not classify anything.
            // eslint-disable-next-line prefer-rest-params
            const real = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...real,
                syncEstimateToQB: async (_t: unknown, _e: unknown, _gl: unknown, _d: unknown, requestId?: string) => {
                    state.posts.push({ kind: "estimate", requestId });
                    if (state.createThrows) throw state.createThrows;
                    return { qbId: "qb-est-1", qbUrl: "https://qbo/est/1" };
                },
                syncInvoiceToQB: async (_t: unknown, _i: unknown, _d: unknown, requestId?: string) => {
                    state.posts.push({ kind: "invoice", requestId });
                    if (state.createThrows) throw state.createThrows;
                    return { qbId: "qb-inv-1", qbUrl: "https://qbo/inv/1" };
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

function seedEstimate(overrides: Record<string, any> = {}) {
    state.estimates["est-1"] = {
        id: "est-1", code: "EST-00001", title: "Kitchen", status: "Sent",
        qbEstimateId: null, qbSyncMarker: null, qbSyncedAt: null,
        totalAmount: 1000, balanceDue: 1000, createdAt: new Date(),
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
        totalAmount: 1000, balanceDue: 1000,
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

test("round 38: the create carries a requestid keyed off the record and its claim", async () => {
    // Intuit dedupes server-side on this. A fresh random value per attempt
    // would dedupe nothing, so it has to come from the marker — the only part
    // of the attempt that survives a process death.
    state.user = ADMIN;
    seedEstimate();
    await POST(postRequest({ type: "estimate", id: "est-1" }));
    const sent = state.posts[0].requestId as string;
    assert.ok(sent?.startsWith("est-1:"), `requestid must identify the record, got ${sent}`);
    assert.ok(sent.length > "est-1:".length, "and carry the claim nonce");
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

    // The replay is the whole point: `retry: false` was advice, this is a rule.
    state.createThrows = null;
    const replay = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).reason, "ambiguous-create");
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
    const { QBAmbiguousDocumentCreateError } = await import("../src/lib/quickbooks");
    state.user = ADMIN;
    const row = seedInvoice();

    await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(row.qbInvoiceId, "qb-inv-1");
    assert.equal(row.qbSyncMarker, null);
    assert.ok(String(state.posts[0].requestId).startsWith("inv-1:"));

    const replay = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal((await replay.json()).alreadyLinked, true);
    assert.equal(state.posts.length, 1);

    // ...and a parked invoice refuses too.
    resetState();
    state.user = ADMIN;
    const parked = seedInvoice();
    state.createThrows = new QBAmbiguousDocumentCreateError("QB invoice sync");
    assert.equal((await POST(postRequest({ type: "invoice", id: "inv-1" }))).status, 503);
    assert.ok(String(parked.qbSyncMarker).startsWith("ambiguous-create:"));
    assert.equal((await POST(postRequest({ type: "invoice", id: "inv-1" }))).status, 409);
    assert.equal(state.posts.length, 1);
});
