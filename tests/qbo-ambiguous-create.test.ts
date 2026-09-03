/**
 * The recovery path for an invoice create whose outcome we never learned.
 *
 * Codex gate (round 27, item 3): the row was parked `ambiguous-create`, every
 * send path refused it, and the error told the operator to "clear the
 * QuickBooks link" — but the unlink action rejected exactly that state
 * (qbInvoiceId is null), and progress billings had no clear operation at all.
 *
 * These drive the REAL resolver against a fake Prisma and a fake QuickBooks.
 * The rule under test is that it only ever acts on an unambiguous answer:
 * exactly one matching invoice, or an explicit human confirmation of none.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    resolveAmbiguousInvoiceCreateCore,
    ambiguousCreateFingerprint,
} from "../src/lib/qbo-ambiguous-create";
import { QBTimeoutError, type QBInvoiceMatch, type QBTokens } from "../src/lib/quickbooks";
import { milestonePrivateNote, milestoneDocNumber } from "../src/lib/quickbooks-payments";
import { progressBillingPrivateNote, deleteProgressBillingCore } from "../src/lib/progress-billing";
import {
    QBResolveRequiredError,
    composeCreateMarker,
    parseCreateMarker,
    markerKind,
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    CREATE_IN_FLIGHT_STALE_MS,
} from "../src/lib/qbo-create-markers";
import { milestoneIssuanceHash, progressBillingIssuanceHash, milestoneTaxSplit } from "../src/lib/qbo-issuance";

const TOKENS: QBTokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };
const ADMIN = { id: "u1", email: "admin@example.com", role: "ADMIN" };

/**
 * Ambiguous-create markers now carry the ORIGINAL in-flight claim's timestamp
 * (a promotion must preserve it, not reset it — see composeCreateMarker), and
 * the resolver's liveness cooldown applies to both marker kinds. Fixtures
 * default to a marker well past CREATE_IN_FLIGHT_STALE_MS so the existing
 * "confirmed-none" tests exercise the resolver's document-matching logic
 * rather than the cooldown — the cooldown itself is covered by its own
 * "round 29 gate" tests below, which pin their own timestamps.
 */
const AMBIGUOUS_MARKER_AT = new Date(Date.now() - CREATE_IN_FLIGHT_STALE_MS - 60_000);

/** The milestone's real DocNumber and PrivateNote, from the shared helpers. */
const MILESTONE_DOC = milestoneDocNumber("INV-00171", 2);
const MILESTONE_NOTE = milestonePrivateNote("INV-00171", "Rough-in", "Mesplay Kitchen");
const BILLING_NOTE = progressBillingPrivateNote("INV-00171", "INV-00171-P1");

/**
 * The MONEY STATE the QuickBooks invoice was issued from — what the marker's
 * issuance hash pins. The resolver recomputes it off the row and refuses to
 * link on any difference, so a fixture that changes one of these fields is
 * deliberately no longer linkable.
 */
const MILESTONE_STATE = {
    status: "Pending",
    amount: 1089,
    name: "Rough-in",
    dueDate: new Date("2026-09-15T00:00:00.000Z"),
    qbPaymentId: null as string | null,
    // Round 35 gate: the TAX ALLOCATION is part of the payload, not just the
    // grand total, so it is part of the issuance fingerprint too.
    pretaxAmount: 1000,
    taxAmount: 89,
};
/** The QuickBooks customer both rails' fixtures bill (Client.qbCustomerId). */
const CUSTOMER_ID = "42";
const MILESTONE_TAX = { preTaxAmount: 1000, taxAmount: 89 };
const MILESTONE_IDENTITY = {
    docNumber: MILESTONE_DOC,
    privateNote: MILESTONE_NOTE,
    issuanceHash: milestoneIssuanceHash({ ...MILESTONE_STATE, tax: MILESTONE_TAX, customerId: CUSTOMER_ID }),
    // The invoice() fixture below defaults total=1089 to match — a mismatch
    // test overrides one side or the other, never both.
    expectedTotal: MILESTONE_STATE.amount,
    // Round 35 gate: WHICH BOOKS and WHICH CUSTOMER the create POST went to.
    // A marker without them is refused outright ("realm-unknown"), so every
    // fixture that expects to reach the lookup has to carry them.
    realmId: TOKENS.realmId,
    customerId: CUSTOMER_ID,
};

const BILLING_STATE = {
    status: "Draft",
    subtotal: 1000,
    total: 1089,
    taxAmount: 89,
    description: "Rough-in complete",
};
const BILLING_IDENTITY = {
    docNumber: "INV-00171-P1",
    privateNote: progressBillingPrivateNote("INV-00171", "INV-00171-P1"),
    issuanceHash: progressBillingIssuanceHash({ ...BILLING_STATE, customerId: CUSTOMER_ID }),
    expectedTotal: BILLING_STATE.total,
    realmId: TOKENS.realmId,
    customerId: CUSTOMER_ID,
};

function milestoneRow(overrides: Record<string, any> = {}): any {
    return {
        id: "ps-1",
        ...MILESTONE_STATE,
        qbInvoiceId: null,
        // The marker as the create path writes it: kind + the identity it used.
        qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, MILESTONE_IDENTITY, AMBIGUOUS_MARKER_AT),
        invoiceId: "inv-1",
        invoice: {
            code: "INV-00171",
            projectId: "proj-1",
            estimateId: "est-1",
            taxRate: 8.9,
            client: { qbCustomerId: CUSTOMER_ID },
            project: { name: "Mesplay Kitchen" },
            payments: [{ id: "ps-0" }, { id: "ps-1" }],
        },
        ...overrides,
    };
}

function billingRow(overrides: Record<string, any> = {}): any {
    return {
        id: "pb-1",
        code: "INV-00171-P1",
        ...BILLING_STATE,
        qbInvoiceId: null,
        qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, BILLING_IDENTITY, AMBIGUOUS_MARKER_AT),
        invoiceId: "inv-1",
        invoice: { code: "INV-00171", projectId: "proj-1", estimateId: "est-1", client: { qbCustomerId: CUSTOMER_ID } },
        ...overrides,
    };
}

/**
 * The fake database.
 *
 * `$transaction` is REQUIRED by the resolver's seam, not optional, and this
 * fake supplies a real one: every write goes through `writeUnderParentLocks`,
 * which takes the Estimate -> Invoice locks (via `$queryRaw`) and RE-READS the
 * parent invoice + client inside them. An optional transaction would have let
 * these tests skip that path entirely and prove nothing about what production
 * runs.
 *
 * The fake ENFORCES the lock discipline rather than merely allowing it:
 *  - the parent invoice cannot be read before the Estimate and Invoice locks,
 *  - `Client.qbCustomerId` cannot be read before the CLIENT row lock, and
 *  - the `seams` fire AT the moment each lock is granted and BEFORE the row
 *    behind it is read, so a test's concurrent edit lands in the only window
 *    that is actually reachable: after the pre-flight read that made the
 *    decision, before the guarded re-read that has to catch it.
 *
 * That last point is the round-37 correction. `onLocked` used to run before
 * `fn(tx)` was even called, which meant a test could "prove" the guard by
 * mutating the fixture before anything had read it — it would have passed
 * against a resolver that took no locks at all and read the customer through
 * `Invoice.client`. Firing at the lock, with the client read refused until the
 * lock is held, is what makes these tests discriminate.
 */
function makeDb(
    milestone: any | null,
    billing: any | null,
    parentInvoice: any = { estimateId: "est-1", taxRate: 8.9, clientId: "cli-1" },
    seams: {
        onInvoiceLocked?: () => void;
        onClientLocked?: () => void;
        /**
         * Fires AFTER the customer mapping has been read under the lock — a
         * writer that ignored the lock order entirely. Only the compare-and-set
         * before the child write can catch this one.
         */
        onClientRead?: () => void;
    } = {},
    clientRow: any = { qbCustomerId: CUSTOMER_ID },
) {
    const delegate = (row: any) => ({
        async findUnique() {
            return row ? { ...row } : null;
        },
        async updateMany(args: any) {
            if (!row) return { count: 0 };
            const matches = Object.entries(args.where).every(([k, v]) => row[k] === v);
            if (!matches) return { count: 0 };
            Object.assign(row, args.data);
            return { count: 1 };
        },
    });
    const paymentSchedule = delegate(milestone);
    const progressBilling = delegate(billing);
    const locks: string[] = [];
    const held = { estimate: false, invoice: false, client: false };
    const tx = {
        paymentSchedule,
        progressBilling,
        invoice: {
            async findUnique() {
                if (!held.estimate || !held.invoice) {
                    throw new Error("parent invoice read before the Estimate -> Invoice locks were taken");
                }
                return parentInvoice ? { ...parentInvoice } : null;
            },
        },
        client: {
            async findUnique() {
                // The assertion this fake exists for: locking the Invoice does
                // NOT lock its Client, so reading the customer mapping without
                // the Client row lock is the bug, not a shortcut.
                if (!held.client) throw new Error("Client.qbCustomerId read before the Client row was locked");
                const seen = clientRow ? { ...clientRow } : null;
                seams.onClientRead?.();
                return seen;
            },
        },
        // lockMoneyParents / lockClientRow issue one tagged-template
        // SELECT ... FOR UPDATE|SHARE per parent; recording them lets a test
        // assert the canonical order.
        async $queryRaw(strings: TemplateStringsArray, ...values: any[]) {
            const sql = strings.join("?");
            locks.push(`${sql}|${values.join(",")}`);
            // The belt-and-braces compare-and-set: one statement that both
            // locks and pins the value, so the fake has to honour the pin.
            if (/"Client"/.test(sql) && /qbCustomerId/.test(sql)) {
                const expected = values[1] ?? null;
                return clientRow && (clientRow.qbCustomerId ?? null) === expected ? [{ id: "cli-1" }] : [];
            }
            if (/"Estimate"/.test(sql)) held.estimate = true;
            if (/"Invoice"/.test(sql) && !held.invoice) {
                held.invoice = true;
                // An invoice edit that committed before this lock was granted.
                seams.onInvoiceLocked?.();
            }
            if (/"Client"/.test(sql) && !held.client) {
                held.client = true;
                // A customer remap that committed before this lock was granted.
                seams.onClientLocked?.();
            }
            return [];
        },
    };
    return {
        paymentSchedule,
        progressBilling,
        locks,
        parent: parentInvoice,
        client: clientRow,
        async $transaction<T>(fn: (t: any) => Promise<T>): Promise<T> {
            return fn(tx);
        },
    };
}

/** The parent invoice as the resolver reads it under the locks. */
function parentFixture(overrides: Record<string, unknown> = {}) {
    return { estimateId: "est-1", taxRate: 8.9, clientId: "cli-1", ...overrides };
}

/** The Client row the resolver reads AFTER locking it. */
function clientFixture(qbCustomerId: string | null = CUSTOMER_ID) {
    return { qbCustomerId };
}

const events: any[] = [];
const logEvent = (async (e: any) => {
    events.push(e);
}) as any;

/**
 * A candidate as `findQBInvoicesByDocNumber` returns it.
 *
 * `customerId` and `totalTax` default to what the fixture create actually sent,
 * so the happy path matches and a test that wants a QuickBooks-side divergence
 * overrides exactly one of them.
 */
const invoice = (
    id: string,
    privateNote: string | null,
    total = 1089,
    overrides: Partial<QBInvoiceMatch> = {},
): QBInvoiceMatch => ({
    id,
    docNumber: MILESTONE_DOC,
    privateNote,
    total,
    balance: total,
    customerId: CUSTOMER_ID,
    totalTax: MILESTONE_TAX.taxAmount,
    ...overrides,
});

function deps(found: QBInvoiceMatch[] | (() => Promise<QBInvoiceMatch[]>), db: any) {
    return {
        db,
        logEvent,
        getTokens: async () => TOKENS,
        findInvoices: async () => (typeof found === "function" ? found() : found),
    };
}

const base = {
    kind: "milestone" as const,
    id: "ps-1",
    decision: "link-existing" as const,
    reason: "Checked QuickBooks",
    actor: ADMIN,
};

test("exactly one matching invoice is adopted, and the marker becomes paylink-pending", async () => {
    events.length = 0;
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );

    assert.equal(res.ok, true);
    assert.equal(res.ok && res.outcome, "linked");
    assert.equal(row.qbInvoiceId, "qb-9");
    // We have the id but not the pay link — the maintenance sweep fetches it.
    assert.equal(row.qbSyncError, "paylink-pending");
    // The audit record carries the actor and their stated reason.
    assert.equal(events.at(-1)?.detail.actorEmail, "admin@example.com");
    assert.equal(events.at(-1)?.detail.operatorReason, "Checked QuickBooks");
    assert.equal(events.at(-1)?.detail.decision, "link-existing");
});

test("round 33 gate: DocNumber and PrivateNote match but the total differs — refused, not linked", async () => {
    // The issuance-hash check only proves our OWN row hasn't moved since the
    // create; it says nothing about what QuickBooks actually holds. A matching
    // identity with the wrong total must not be adopted blind.
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE, 5000)], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked for manual review");
});

test("round 31 gate: a candidate whose QuickBooks total is unreadable (non-finite) is refused, not linked", async () => {
    // matches[0].total comes from Number(TotalAmt) in findQBInvoicesByDocNumber
    // — an unparseable TotalAmt reads as NaN, and Math.abs(NaN - x) > 0.005 is
    // FALSE, which used to let a candidate whose amount could not even be read
    // slip past the mismatch guard as though it matched.
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE, NaN)], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written — an unreadable total must never be adopted blind");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked for manual review");
});

test("an invoice sharing the DocNumber but not our PrivateNote is NOT ours", async () => {
    // DocNumber is not unique in QuickBooks. Matching on it alone would adopt
    // somebody else's invoice as this milestone's bill.
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-other", "Some other system")], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "none-found");
    assert.equal(row.qbInvoiceId, null, "nothing written");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked");
});

test("zero matches refuses until the operator confirms none exists", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    const refused = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(!refused.ok && refused.refusal, "none-found");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER);

    const confirmed = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.ok && confirmed.outcome, "cleared");
    assert.equal(row.qbSyncError, null, "freely re-sendable again");
    assert.equal(row.qbInvoiceId, null);
});

test("round 29 gate: a young create-in-flight marker refuses confirmed-none — the POST may still be running", async () => {
    // A create-in-flight marker means the POST may not have returned yet.
    // Clearing it on a zero-match answer would let a second operator start
    // another create while the first is still landing.
    const row = milestoneRow({ qbSyncError: composeCreateMarker(CREATE_IN_FLIGHT_MARKER, MILESTONE_IDENTITY, new Date()) });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(!res.ok && res.refusal, "create-still-active");
    assert.equal(row.qbInvoiceId, null);
    assert.equal(markerKind(row.qbSyncError), CREATE_IN_FLIGHT_MARKER, "still parked — nothing was cleared");
});

test("round 29 gate: a create-in-flight marker with NO readable timestamp (legacy shape) also refuses confirmed-none", async () => {
    // Neither table carries updatedAt, so a marker written before this claim
    // timestamp existed has no age at all — unreadable age must fail closed,
    // exactly like a young one, not like a stale one.
    const legacyMarker = `${CREATE_IN_FLIGHT_MARKER}:${MILESTONE_IDENTITY.docNumber}|${MILESTONE_IDENTITY.privateNote}`;
    const row = milestoneRow({ qbSyncError: legacyMarker });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(!res.ok && res.refusal, "create-still-active");
    assert.equal(row.qbSyncError, legacyMarker, "still parked — nothing was cleared");
});

test("round 29 gate: a create-in-flight marker past the staleness window CAN be cleared by confirmed-none", async () => {
    const oldAt = new Date(Date.now() - CREATE_IN_FLIGHT_STALE_MS - 60_000);
    const row = milestoneRow({ qbSyncError: composeCreateMarker(CREATE_IN_FLIGHT_MARKER, MILESTONE_IDENTITY, oldAt) });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.outcome, "cleared");
    assert.equal(row.qbSyncError, null);
});

test("round 30 gate: a young ambiguous-create marker ALSO refuses confirmed-none — promotion preserves the original claim time", async () => {
    // Our own deadline firing (the timeout that promotes create-in-flight to
    // ambiguous-create) only means WE gave up waiting — the original request
    // can still be landing at QuickBooks' end. A promoted marker carries the
    // ORIGINAL claim time now, so it must be judged by the same cooldown as a
    // still-fresh create-in-flight marker, not treated as if the wait had
    // just reset.
    const row = milestoneRow({ qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, MILESTONE_IDENTITY, new Date()) });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(!res.ok && res.refusal, "create-still-active");
    assert.equal(row.qbInvoiceId, null);
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked — nothing was cleared");
});

test("round 30 gate: an ambiguous-create marker with NO readable timestamp (legacy shape) also refuses confirmed-none", async () => {
    const legacyMarker = `${AMBIGUOUS_CREATE_MARKER}:${MILESTONE_IDENTITY.docNumber}|${MILESTONE_IDENTITY.privateNote}`;
    const row = milestoneRow({ qbSyncError: legacyMarker });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(!res.ok && res.refusal, "create-still-active");
    assert.equal(row.qbSyncError, legacyMarker, "still parked — nothing was cleared");
});

test("round 31 gate: a young create-in-flight marker with an EXACT match is refused, not linked — the original sender may still be running", async () => {
    // If the original sender's own POST is still in flight, its post-create
    // link write can lose the CAS to this one (quickbooks-payments.ts), which
    // makes IT compensate — compensateAndUnlink then deletes the very invoice
    // this resolver just adopted. Linking on age alone (round 29) was unsafe;
    // an exact match on a fresh marker must refuse exactly like a clear does.
    const row = milestoneRow({ qbSyncError: composeCreateMarker(CREATE_IN_FLIGHT_MARKER, MILESTONE_IDENTITY, new Date()) });
    const db = makeDb(row, null);
    let asked = 0;
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "link-existing", expectedState: ambiguousCreateFingerprint(row) },
        {
            db, logEvent,
            getTokens: async () => TOKENS,
            findInvoices: async () => { asked++; return [invoice("qb-9", MILESTONE_NOTE)]; },
        },
    );
    assert.equal(!res.ok && res.refusal, "create-still-active");
    assert.equal(row.qbInvoiceId, null, "nothing written — the interleaving exact match must not be adopted");
    assert.equal(asked, 0, "refused before ever asking QuickBooks");
});

test("round 31 gate: a create-in-flight marker past the staleness window CAN be linked on an exact match", async () => {
    const oldAt = new Date(Date.now() - CREATE_IN_FLIGHT_STALE_MS - 60_000);
    const row = milestoneRow({ qbSyncError: composeCreateMarker(CREATE_IN_FLIGHT_MARKER, MILESTONE_IDENTITY, oldAt) });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "link-existing", expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );
    assert.equal(res.ok, true);
    assert.equal(row.qbInvoiceId, "qb-9");
});

test("more than one match refuses and writes NOTHING", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-1", MILESTONE_NOTE), invoice("qb-2", MILESTONE_NOTE)], db),
    );

    assert.equal(!res.ok && res.refusal, "multiple-matches");
    assert.deepEqual(!res.ok && res.candidates?.map((c) => c.qbInvoiceId), ["qb-1", "qb-2"]);
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "parked is the only state that stops a third invoice");
    assert.equal(row.qbInvoiceId, null);
});

test("round 29 gate: a truncated QuickBooks result set refuses as ambiguous, not as unreachable", async () => {
    const { QBResultSetTruncatedError } = await import("../src/lib/quickbooks");
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps(async () => {
            throw new QBResultSetTruncatedError(MILESTONE_DOC, 20);
        }, db),
    );
    assert.equal(!res.ok && res.refusal, "result-set-truncated");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked — nothing was written");
    assert.equal(row.qbInvoiceId, null);
});

test("an unreachable QuickBooks refuses — 'I could not ask' is not 'there is none'", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps(async () => {
            throw new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/query");
        }, db),
    );

    assert.equal(!res.ok && res.refusal, "quickbooks-unreachable");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER);
    assert.equal(row.qbInvoiceId, null);
});

test("the role rule is narrower than the invoices permission", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    for (const role of ["MANAGER", "EMPLOYEE", "FIELD_CREW"]) {
        const res = await resolveAmbiguousInvoiceCreateCore(
            { ...base, expectedState: ambiguousCreateFingerprint(row), actor: { id: "u2", email: "m@x", role } },
            deps([invoice("qb-9", MILESTONE_NOTE)], db),
        );
        assert.equal(!res.ok && res.refusal, "forbidden", role);
        assert.equal(row.qbInvoiceId, null, `${role} must not be able to link`);
    }
    const finance = await resolveAmbiguousInvoiceCreateCore(
        {
            ...base, expectedState: ambiguousCreateFingerprint(row),
            actor: { id: "u3", email: "f@x", role: "FINANCE", projectAccess: [{ projectId: "proj-1" }] },
        },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );
    assert.equal(finance.ok, true);
});

test("round 31 gate: a FINANCE user restricted to a different project is refused — no QuickBooks call, nothing written", async () => {
    // canResolveAmbiguousCreate only proves FINANCE may resolve ambiguous
    // creates somewhere — it says nothing about THIS row's project. The row
    // belongs to "proj-1"; an actor scoped only to "proj-other" must be
    // refused before QuickBooks is ever asked.
    const row = milestoneRow();
    const db = makeDb(row, null);
    let asked = 0;
    const res = await resolveAmbiguousInvoiceCreateCore(
        {
            ...base, expectedState: ambiguousCreateFingerprint(row),
            actor: { id: "u4", email: "f2@x", role: "FINANCE", projectAccess: [{ projectId: "proj-other" }] },
        },
        {
            db, logEvent,
            getTokens: async () => TOKENS,
            findInvoices: async () => { asked++; return [invoice("qb-9", MILESTONE_NOTE)]; },
        },
    );
    assert.equal(!res.ok && res.refusal, "forbidden");
    assert.equal(asked, 0, "refused before ever asking QuickBooks");
    assert.equal(row.qbInvoiceId, null, "nothing written");
});

test("a row that moved since the page was rendered is refused as stale", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    // Someone else resolved it first: the state the operator was shown is gone.
    const staleToken = ambiguousCreateFingerprint(row);
    row.qbSyncError = composeCreateMarker(CREATE_IN_FLIGHT_MARKER, MILESTONE_IDENTITY);

    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: staleToken },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );
    assert.equal(!res.ok && res.refusal, "stale");
    assert.equal(row.qbInvoiceId, null);
});

test("a row that is not parked has nothing to resolve", async () => {
    const row = milestoneRow({ qbSyncError: null });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(!res.ok && res.refusal, "not-ambiguous");
});

test("a progress billing resolves the same way, and comes back Staged", async () => {
    const row = billingRow();
    const db = makeDb(null, row);
    const res = await resolveAmbiguousInvoiceCreateCore(
        {
            kind: "progressBilling",
            id: "pb-1",
            decision: "link-existing",
            reason: "Found INV-00171-P1 in QuickBooks",
            actor: ADMIN,
            expectedState: ambiguousCreateFingerprint(row),
        },
        deps([{
            id: "qb-7", docNumber: "INV-00171-P1", privateNote: BILLING_NOTE, total: 1089, balance: 1089,
            customerId: CUSTOMER_ID, totalTax: BILLING_STATE.taxAmount,
        }], db),
    );

    assert.equal(res.ok, true);
    assert.equal(row.qbInvoiceId, "qb-7");
    assert.equal(row.status, "Staged");
    assert.equal(row.qbSyncError, "paylink-pending");
});

test("an in-flight marker is resolvable too — a crash leaves exactly that", async () => {
    // Past the staleness window: a genuinely crashed process, not one that
    // might still be running (see the round 31 gate tests above for that case).
    const row = milestoneRow({ qbSyncError: composeCreateMarker(CREATE_IN_FLIGHT_MARKER, MILESTONE_IDENTITY, AMBIGUOUS_MARKER_AT) });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );
    assert.equal(res.ok, true);
    assert.equal(row.qbInvoiceId, "qb-9");
});

test("deleting a parked progress-billing draft is refused with a typed error", async () => {
    // It looks deletable — Draft, no qbInvoiceId — but a real collectible
    // invoice may exist for it, and deleting would abandon it.
    //
    // src/lib/prisma.ts reads globalThis.prisma before building a client, which
    // is the seam this uses: no database, and the REAL core runs.
    const parked = {
        id: "pb-1", code: "INV-00171-P1", status: "Draft", qbInvoiceId: null,
        qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, { docNumber: "INV-00171-P1", privateNote: BILLING_NOTE }),
    };
    let deleted = false;
    const tx = {
        progressBilling: {
            async findUnique(args: any) {
                if (args.select?.invoiceId) return { invoiceId: "inv-1", invoice: { projectId: "proj-1" } };
                return { ...parked };
            },
            async delete() {
                deleted = true;
                return parked;
            },
        },
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
    };
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = { $transaction: async (fn: any) => fn(tx) };
    try {
        await assert.rejects(
            () => deleteProgressBillingCore("pb-1"),
            (e: unknown) => e instanceof QBResolveRequiredError,
        );
        assert.equal(deleted, false, "the draft must survive until it is resolved");
    } finally {
        (globalThis as any).prisma = previous;
    }
});

// ─── The recovery identity rides in the marker ─────────────────────────────

test("compose/parse round-trips, and a legacy or corrupt marker yields NO identity", () => {
    const identity = { docNumber: "INV-00171-2", privateNote: "ProBuild INV-00171 · Rough-in · Mesplay Kitchen" };
    // create-in-flight carries a claim timestamp (round 29: marker liveness) —
    // pin it so the composed string is deterministic.
    const at = new Date(1_700_000_000_000);
    const marker = composeCreateMarker(CREATE_IN_FLIGHT_MARKER, identity, at);
    assert.equal(marker, "create-in-flight:@1700000000000|INV-00171-2|ProBuild INV-00171 · Rough-in · Mesplay Kitchen");
    assert.deepEqual(parseCreateMarker(marker), { kind: CREATE_IN_FLIGHT_MARKER, identity, atMs: 1_700_000_000_000 });

    // A note containing the field separator survives: the FIRST one splits.
    // AMBIGUOUS_CREATE_MARKER carries a timestamp too — a promotion from
    // create-in-flight must preserve that marker's ORIGINAL claim time (round
    // 30: cooldown gap), not reset it, so the resolver's liveness cooldown
    // still protects the request the promoted marker actually describes.
    const pipedAt = new Date(1_700_000_001_000);
    const piped = { docNumber: "INV-9-1", privateNote: "ProBuild INV-9 · A|B · Job" };
    assert.deepEqual(parseCreateMarker(composeCreateMarker(AMBIGUOUS_CREATE_MARKER, piped, pipedAt)), {
        kind: AMBIGUOUS_CREATE_MARKER,
        identity: piped,
        atMs: 1_700_000_001_000,
    });

    // Legacy bare markers: recognised as parked, but with nothing to look up
    // (and no age, since they predate the claim timestamp too).
    for (const bare of [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER]) {
        assert.deepEqual(parseCreateMarker(bare), { kind: bare, identity: null, atMs: null });
    }
    // Corrupt payloads are treated the same way — never guessed at.
    for (const corrupt of ["ambiguous-create:", "ambiguous-create:|note", "ambiguous-create:doc|", "ambiguous-create:doconly"]) {
        assert.equal(parseCreateMarker(corrupt)?.identity, null, corrupt);
    }
    // And unrelated values are not markers at all.
    for (const other of [null, undefined, "", "voided", "notFound", "paylink-pending"]) {
        assert.equal(parseCreateMarker(other as any), null, String(other));
        assert.equal(markerKind(other as any), null, String(other));
    }
});

test("the queried identity does not move when a sibling is deleted or the project renamed", async () => {
    // The regression this exists for: docNumber is the milestone's POSITION and
    // the note carries the project name. Recomputing either at recovery time
    // would look for a document we never created — find nothing — and offer to
    // release a row whose invoice is sitting in QuickBooks, collectible.
    const row = milestoneRow();
    const markerAtCreate = row.qbSyncError;

    // An earlier milestone is deleted (this one is now position 1, not 2) and
    // the project is renamed. The marker is untouched by both.
    row.invoice.payments = [{ id: "ps-1" }];
    row.invoice.project.name = "Mesplay Kitchen (Phase 2)";
    row.name = "Rough-in plumbing";

    const asked: string[] = [];
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        {
            db,
            logEvent,
            getTokens: async () => TOKENS,
            findInvoices: async (_t, docNumber) => {
                asked.push(docNumber);
                return [invoice("qb-9", MILESTONE_NOTE)];
            },
        },
    );

    assert.deepEqual(asked, [MILESTONE_DOC], "asked for the ORIGINAL doc number");
    assert.equal(res.ok, true, "and matched the ORIGINAL private note");
    assert.equal(row.qbInvoiceId, "qb-9");
    assert.equal(markerAtCreate, composeCreateMarker(AMBIGUOUS_CREATE_MARKER, MILESTONE_IDENTITY, AMBIGUOUS_MARKER_AT));
});

test("a marker with no identity refuses, and confirmed-none cannot clear it", async () => {
    // Parked by an older release. We cannot know which document to ask about,
    // so the one thing we must never do is conclude "there is none".
    for (const bare of [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER, "ambiguous-create:doconly"]) {
        const row = milestoneRow({ qbSyncError: bare });
        const db = makeDb(row, null);
        let asked = 0;
        for (const decision of ["link-existing", "confirmed-none"] as const) {
            const res = await resolveAmbiguousInvoiceCreateCore(
                { ...base, decision, expectedState: ambiguousCreateFingerprint(row) },
                {
                    db, logEvent,
                    getTokens: async () => TOKENS,
                    findInvoices: async () => { asked++; return []; },
                },
            );
            assert.equal(res.ok, false, `${bare} / ${decision}`);
            assert.equal(!res.ok && res.refusal, "identity-unknown", `${bare} / ${decision}`);
        }
        assert.equal(asked, 0, "never guesses at a document to query");
        assert.equal(row.qbSyncError, bare, "still parked, whatever the operator confirmed");
        assert.equal(row.qbInvoiceId, null);
    }
});


// --- Round 35 gate: a recovery must know WHICH BOOKS it is looking in --------

test("round 35 gate: a marker from another QuickBooks realm is refused, never queried", async () => {
    // The failure: ProBuild reconnects to a second company (or a sandbox, or
    // another client file). The resolver queries with the credentials it has
    // NOW, the DocNumber is not in those books, the answer comes back empty,
    // the operator is offered "confirm none exists" — and clearing releases a
    // row whose real, collectible invoice is sitting in the ORIGINAL company.
    const row = milestoneRow();
    const db = makeDb(row, null);
    let asked = 0;
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        {
            db, logEvent,
            getTokens: async () => ({ ...TOKENS, realmId: "realm-OTHER" }),
            findInvoices: async () => { asked++; return []; },
        },
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "realm-mismatch");
    assert.equal(asked, 0, "the wrong books are never even queried");
    assert.equal(row.qbInvoiceId, null, "nothing written");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked — a confirmed-none must NOT clear it");
});

test("round 35 gate: a row re-pointed at a different QuickBooks customer is refused before any call", async () => {
    // A merge in QuickBooks, or a re-ensureQBCustomer after a rename, moves
    // Client.qbCustomerId. Document identity alone would still match, and the
    // resolver would attach an invoice billed to somebody else.
    const row = milestoneRow();
    row.invoice = { ...row.invoice, client: { qbCustomerId: "99" } };
    const db = makeDb(row, null);
    let asked = 0;
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        {
            db, logEvent,
            getTokens: async () => TOKENS,
            findInvoices: async () => { asked++; return [invoice("qb-9", MILESTONE_NOTE)]; },
        },
    );

    assert.equal(!res.ok && res.refusal, "customer-mismatch");
    assert.equal(asked, 0, "refused before spending a QuickBooks call");
    assert.equal(row.qbInvoiceId, null, "nothing written");
});

test("round 35 gate: a client with NO QuickBooks customer id at all is a mismatch, not a pass", async () => {
    // `null !== "42"` has to fail closed: an unverifiable customer is exactly
    // the state that must never be linked or cleared.
    const row = milestoneRow();
    row.invoice = { ...row.invoice, client: { qbCustomerId: null } };
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );
    assert.equal(!res.ok && res.refusal, "customer-mismatch");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked");
});

test("round 35 gate: a marker predating the realm field is refused outright and cannot be cleared", async () => {
    // Backward compatibility is NOT "any realm will do". A marker with no realm
    // means the books are unknown, and an unknown realm is the same class of
    // answer as an unknown identity: refuse, never auto-clear.
    const { realmId: _realm, customerId: _customer, ...legacyIdentity } = MILESTONE_IDENTITY;
    const row = milestoneRow({
        qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, legacyIdentity, AMBIGUOUS_MARKER_AT),
    });
    const db = makeDb(row, null);
    let asked = 0;
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        {
            db, logEvent,
            getTokens: async () => TOKENS,
            findInvoices: async () => { asked++; return []; },
        },
    );

    assert.equal(!res.ok && res.refusal, "realm-unknown");
    assert.equal(asked, 0, "no QuickBooks call — we do not know which company to ask");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked");
});

test("round 35 gate: the marker's realm and customer ride through compose/parse", async () => {
    const parsed = parseCreateMarker(composeCreateMarker(AMBIGUOUS_CREATE_MARKER, MILESTONE_IDENTITY, AMBIGUOUS_MARKER_AT));
    assert.deepEqual(parsed?.identity, MILESTONE_IDENTITY);
    // And they are part of the marker STRING, which the link CAS pins — so
    // extending the identity extends the CAS with no extra where clause.
    const marker = composeCreateMarker(AMBIGUOUS_CREATE_MARKER, MILESTONE_IDENTITY, AMBIGUOUS_MARKER_AT);
    assert.ok(marker.includes(`~${TOKENS.realmId}|`), marker);
    assert.ok(marker.includes("%42|"), marker);
});

// --- Round 35 gate: the issuance hash covers the whole billing payload ------

test("round 35 gate: a tax-allocation change makes the issuance hash differ, so the invoice is not adopted", async () => {
    // The amount is UNCHANGED — only the split between pre-tax and tax moved.
    // The old hash covered the grand total alone, so a QuickBooks invoice
    // carrying the OLD liability split was linked as though it still described
    // the row, quietly misreporting sales tax.
    const row = milestoneRow({ pretaxAmount: 900, taxAmount: 189 });
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );

    assert.equal(!res.ok && res.refusal, "issuance-changed");
    assert.equal(row.qbInvoiceId, null, "nothing written");
});

test("round 35 gate: the tax split the hash uses is the one the PUSH sends, derived the same way", async () => {
    const { milestoneTaxSplit } = await import("../src/lib/qbo-issuance");
    // Both columns present: used verbatim.
    assert.deepEqual(
        milestoneTaxSplit({ pretaxAmount: 1000, taxAmount: 89, amount: 1089, invoiceTaxRate: 0 }),
        { preTaxAmount: 1000, taxAmount: 89 },
    );
    // Neither: derived from the invoice rate off the tax-INCLUSIVE amount.
    assert.deepEqual(
        milestoneTaxSplit({ pretaxAmount: null, taxAmount: null, amount: 1089, invoiceTaxRate: 8.9 }),
        { preTaxAmount: 1000, taxAmount: 89 },
    );
    // No rate: no tax line at all. An ABSENT tax line is a different answer
    // from a $0 one, and the hash must not read them alike.
    assert.equal(milestoneTaxSplit({ pretaxAmount: null, taxAmount: null, amount: 1089, invoiceTaxRate: 0 }), null);
});

// --- Round 35 gate: PrivateNote comparison must be symmetric ---------------

test("round 35 gate: a PrivateNote with stray whitespace still matches its own invoice", async () => {
    // The old code trimmed the value QuickBooks returned and compared it to the
    // UNTRIMMED marker value. A project or milestone name carrying trailing
    // whitespace therefore compared unequal to itself: the real invoice was
    // invisible, the resolver reported "none found", the operator confirmed
    // none, the marker was cleared, and the next send billed the client twice.
    for (const variant of [
        ` ${MILESTONE_NOTE}`,
        `${MILESTONE_NOTE} `,
        `\n${MILESTONE_NOTE}\t`,
        MILESTONE_NOTE.replace(" · ", "  ·   "),
    ]) {
        const row = milestoneRow();
        const db = makeDb(row, null);
        const res = await resolveAmbiguousInvoiceCreateCore(
            { ...base, expectedState: ambiguousCreateFingerprint(row) },
            deps([invoice("qb-9", variant)], db),
        );
        assert.equal(res.ok, true, `variant did not match: ${JSON.stringify(variant)}`);
        assert.equal(row.qbInvoiceId, "qb-9");
    }
});

test("round 35 gate: canonicalPrivateNote truncates LAST, so the >4000-char case still matches", async () => {
    const { canonicalPrivateNote, QB_PRIVATE_NOTE_MAX_LEN } = await import("../src/lib/quickbooks");
    // Canonicalizing first is what keeps the two sides agreeing past the cap:
    // both were cut at the same index of the same normalized text.
    const long = `  ProBuild  ${"x".repeat(QB_PRIVATE_NOTE_MAX_LEN)}  `;
    const ours = canonicalPrivateNote(long);
    assert.equal(ours.length, QB_PRIVATE_NOTE_MAX_LEN);
    // What QuickBooks hands back is the stored (already canonical) string,
    // possibly re-whitespaced at the edges — it must still canonicalize equal.
    assert.equal(canonicalPrivateNote(` ${ours}\n`), ours);
    assert.equal(canonicalPrivateNote(null), "");
});

// ─── Round 36 gate: the CANDIDATE INVOICE itself is verified ───────────────
//
// Everything the resolver checked before this looked at ProBuild's own state:
// the marker, the row's issuance hash, `Client.qbCustomerId`. All of that
// proves LOCAL state has not moved. It says nothing about the QuickBooks
// document about to be adopted — whose CustomerRef can be edited in QuickBooks
// after our create, and whose tax QuickBooks can recompute on its own.

test("round 36 gate: an invoice QuickBooks bills to a DIFFERENT customer is refused, not linked", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE, 1089, { customerId: "99" })], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written — this bill is addressed to someone else");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked for manual review");
});

test("round 36 gate: an invoice whose CustomerRef cannot be read is refused, not linked", async () => {
    // Same rule as the unreadable total: "cannot confirm" is not "matches".
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE, 1089, { customerId: null })], db),
    );

    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written");
});

test("round 36 gate: a matching total split into DIFFERENT tax is refused", async () => {
    // QuickBooks Automated Sales Tax can re-split the same grand total, and the
    // split is the number the sales-tax return reads. $1089 as 1089/0 is not
    // the invoice we sent as 1000/89.
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE, 1089, { totalTax: 0 })], db),
    );

    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written");
});

test("round 36 gate: a taxed invoice whose TotalTax is absent is refused, not read as $0", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE, 1089, { totalTax: null })], db),
    );

    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written");
});

test("round 36 gate: customer AND tax matching links, under the canonical money locks", async () => {
    const row = milestoneRow();
    const db = makeDb(row, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );

    assert.equal(res.ok, true);
    assert.equal(row.qbInvoiceId, "qb-9");
    // Estimate -> Invoice -> Client — the one global order every money-path
    // transaction takes, so this resolve cannot deadlock against a settle or
    // against the customer remap in resolveCustomerAndItem.
    assert.equal(db.locks.length, 4);
    assert.match(db.locks[0], /"Estimate"[\s\S]*FOR UPDATE[\s\S]*est-1/);
    assert.match(db.locks[1], /"Invoice"[\s\S]*FOR UPDATE[\s\S]*inv-1/);
    // FOR SHARE: this transaction only reads the mapping. The remap takes
    // FOR UPDATE, and the two conflict, which is the whole serialization.
    assert.match(db.locks[2], /"Client"[\s\S]*FOR SHARE[\s\S]*cli-1/);
    // ...and the value is re-pinned in a compare-and-set immediately before the
    // child write, so a writer that skipped the lock is caught by comparison.
    assert.match(db.locks[3], /"Client"[\s\S]*qbCustomerId[\s\S]*IS NOT DISTINCT FROM/);
});

// ─── Round 36 gate: PARENT-row state is re-read under the locks ────────────
//
// The link CAS pins the parked row's own columns. It cannot pin
// `Client.qbCustomerId` or `Invoice.taxRate` — those live on other tables — and
// the marker does not cover them either: it records what they were AT CREATE
// TIME and is never rewritten when they move. A comment used to claim
// otherwise. These drive the interleaving that comment made look impossible.

test("round 36 gate: a client re-pointed at another QuickBooks customer DURING the resolve is refused", async () => {
    const row = milestoneRow();
    const client = clientFixture();
    // Fires at the moment the CLIENT row lock is granted, before the mapping
    // has been read: exactly the window between the decision and the write.
    const db = makeDb(row, null, parentFixture(), { onClientLocked: () => { client.qbCustomerId = "99"; } }, client);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written — the row now bills a different customer");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked");
});

test("round 37 gate: a remap that IGNORES the lock is still caught, by the value pin on the write", async () => {
    // Belt and braces. The FOR SHARE lock makes the mapping stable against
    // every writer that takes the canonical lock; this one does not take it at
    // all, and commits after the under-lock read. The compare-and-set on the
    // Client row, immediately before the child write, is the only thing left
    // between that and a link committed against a customer we no longer bill.
    const row = milestoneRow();
    const client = clientFixture();
    const db = makeDb(row, null, parentFixture(), { onClientRead: () => { client.qbCustomerId = "99"; } }, client);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked");
});

test("round 36 gate: an invoice tax-rate edit DURING the resolve is refused", async () => {
    // The rate only reaches the issuance hash when the milestone carries no
    // explicit split of its own, so this fixture leaves both columns null and
    // derives the same 1000/89 from the invoice's 8.9%.
    const derivedTax = milestoneTaxSplit({
        pretaxAmount: null, taxAmount: null, amount: MILESTONE_STATE.amount, invoiceTaxRate: 8.9,
    });
    const derivedState = { ...MILESTONE_STATE, pretaxAmount: null, taxAmount: null };
    const identity = {
        ...MILESTONE_IDENTITY,
        issuanceHash: milestoneIssuanceHash({ ...derivedState, tax: derivedTax, customerId: CUSTOMER_ID }),
    };
    const row = milestoneRow({
        pretaxAmount: null,
        taxAmount: null,
        qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, identity, AMBIGUOUS_MARKER_AT),
    });
    const parent = parentFixture();
    const db = makeDb(row, null, parent, { onInvoiceLocked: () => { parent.taxRate = 10; } });
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE, 1089, { totalTax: derivedTax!.taxAmount })], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written — the tax allocation is no longer the one that was sent");
});

test("round 36 gate: the CLEAR is guarded the same way — a customer remap mid-resolve refuses", async () => {
    // Clearing releases the row to be sent again. The "QuickBooks has nothing"
    // answer was reached against one customer mapping; if that moved while we
    // looked, the answer is meaningless and the marker must stay.
    const row = milestoneRow();
    const client = clientFixture();
    const db = makeDb(row, null, parentFixture(), { onClientLocked: () => { client.qbCustomerId = "99"; } }, client);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked — not released");
});

test("round 36 gate: a parked row whose parent invoice has vanished is refused, not linked", async () => {
    // The customer and the tax rate both hang off the invoice. Nothing to read
    // is "cannot verify", never "nothing changed".
    const row = milestoneRow();
    const db = makeDb(row, null, null);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, expectedState: ambiguousCreateFingerprint(row) },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );

    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written");
});

test("round 36 gate: the progress-billing rail is guarded too", async () => {
    const row = billingRow();
    const client = clientFixture();
    const db = makeDb(null, row, parentFixture(), { onClientLocked: () => { client.qbCustomerId = "99"; } }, client);
    const res = await resolveAmbiguousInvoiceCreateCore(
        {
            kind: "progressBilling",
            id: "pb-1",
            decision: "link-existing",
            reason: "Found INV-00171-P1 in QuickBooks",
            actor: ADMIN,
            expectedState: ambiguousCreateFingerprint(row),
        },
        deps([{
            id: "qb-7", docNumber: "INV-00171-P1", privateNote: BILLING_NOTE, total: 1089, balance: 1089,
            customerId: CUSTOMER_ID, totalTax: BILLING_STATE.taxAmount,
        }], db),
    );

    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(row.qbInvoiceId, null, "nothing written");
    assert.notEqual(row.status, "Staged");
});

test("round 36 gate: the under-lock CUSTOMER check stands alone when the marker carries no issuance hash", async () => {
    // A marker written between releases can carry realm + customer but no
    // issuance hash. The link path refuses those outright
    // ("issuance-unverifiable"), but a `confirmed-none` CLEAR does not need a
    // hash — so on that path the re-read customer is the ONLY thing standing
    // between a mid-resolve client remap and a released row.
    const { issuanceHash: _dropped, ...noHash } = MILESTONE_IDENTITY;
    const row = milestoneRow({ qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, noHash, AMBIGUOUS_MARKER_AT) });
    const client = clientFixture();
    const db = makeDb(row, null, parentFixture(), { onClientLocked: () => { client.qbCustomerId = "99"; } }, client);
    const res = await resolveAmbiguousInvoiceCreateCore(
        { ...base, decision: "confirmed-none", expectedState: ambiguousCreateFingerprint(row) },
        deps([], db),
    );

    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.refusal, "mismatch");
    assert.equal(markerKind(row.qbSyncError), AMBIGUOUS_CREATE_MARKER, "still parked — not released");
});
