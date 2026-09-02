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
} from "../src/lib/qbo-create-markers";

const TOKENS: QBTokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };
const ADMIN = { id: "u1", email: "admin@example.com", role: "ADMIN" };

/** The milestone's real DocNumber and PrivateNote, from the shared helpers. */
const MILESTONE_DOC = milestoneDocNumber("INV-00171", 2);
const MILESTONE_NOTE = milestonePrivateNote("INV-00171", "Rough-in", "Mesplay Kitchen");
const BILLING_NOTE = progressBillingPrivateNote("INV-00171", "INV-00171-P1");
const MILESTONE_IDENTITY = { docNumber: MILESTONE_DOC, privateNote: MILESTONE_NOTE };

function milestoneRow(overrides: Record<string, any> = {}): any {
    return {
        id: "ps-1",
        name: "Rough-in",
        qbInvoiceId: null,
        // The marker as the create path writes it: kind + the identity it used.
        qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, MILESTONE_IDENTITY),
        invoiceId: "inv-1",
        invoice: {
            code: "INV-00171",
            projectId: "proj-1",
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
        qbInvoiceId: null,
        qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, {
            docNumber: "INV-00171-P1",
            privateNote: progressBillingPrivateNote("INV-00171", "INV-00171-P1"),
        }),
        invoiceId: "inv-1",
        invoice: { code: "INV-00171", projectId: "proj-1" },
        ...overrides,
    };
}

function makeDb(milestone: any | null, billing: any | null) {
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
    return { paymentSchedule: delegate(milestone), progressBilling: delegate(billing) };
}

const events: any[] = [];
const logEvent = (async (e: any) => {
    events.push(e);
}) as any;

const invoice = (id: string, privateNote: string | null, total = 1089): QBInvoiceMatch => ({
    id,
    docNumber: MILESTONE_DOC,
    privateNote,
    total,
    balance: total,
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
        { ...base, expectedState: ambiguousCreateFingerprint(row), actor: { id: "u3", email: "f@x", role: "FINANCE" } },
        deps([invoice("qb-9", MILESTONE_NOTE)], db),
    );
    assert.equal(finance.ok, true);
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
        deps([{ id: "qb-7", docNumber: "INV-00171-P1", privateNote: BILLING_NOTE, total: 1089, balance: 1089 }], db),
    );

    assert.equal(res.ok, true);
    assert.equal(row.qbInvoiceId, "qb-7");
    assert.equal(row.status, "Staged");
    assert.equal(row.qbSyncError, "paylink-pending");
});

test("an in-flight marker is resolvable too — a crash leaves exactly that", async () => {
    const row = milestoneRow({ qbSyncError: composeCreateMarker(CREATE_IN_FLIGHT_MARKER, MILESTONE_IDENTITY) });
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
    const marker = composeCreateMarker(CREATE_IN_FLIGHT_MARKER, identity);
    assert.equal(marker, "create-in-flight:INV-00171-2|ProBuild INV-00171 · Rough-in · Mesplay Kitchen");
    assert.deepEqual(parseCreateMarker(marker), { kind: CREATE_IN_FLIGHT_MARKER, identity });

    // A note containing the field separator survives: the FIRST one splits.
    const piped = { docNumber: "INV-9-1", privateNote: "ProBuild INV-9 · A|B · Job" };
    assert.deepEqual(parseCreateMarker(composeCreateMarker(AMBIGUOUS_CREATE_MARKER, piped)), {
        kind: AMBIGUOUS_CREATE_MARKER,
        identity: piped,
    });

    // Legacy bare markers: recognised as parked, but with nothing to look up.
    for (const bare of [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER]) {
        assert.deepEqual(parseCreateMarker(bare), { kind: bare, identity: null });
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
    assert.equal(markerAtCreate, composeCreateMarker(AMBIGUOUS_CREATE_MARKER, MILESTONE_IDENTITY));
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
