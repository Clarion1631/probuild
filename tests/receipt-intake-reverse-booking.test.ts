/**
 * Reverse booking: an admin takes a receipt-booked Expense out of the books
 * and the receipt row closes as REVERSED, still holding its dedup keys.
 *
 * `reverseReceiptBookingCore` runs against an in-memory fake that models the
 * tables it touches, so job cost is a real sum over the fake Expense table.
 * The dedup claim is simulated with the REAL partial-unique-index predicate,
 * parsed out of the migration SQL, and the REAL routeState. No database.
 *
 * The admin gate lives in `reverseReceiptBookingForUser`, which the server
 * action `reverseReceiptBooking` (actions.ts) calls; it is tested directly.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    REVERSE_MESSAGES,
    REVERSED_STATE,
    isReverseBookingRefusedError,
    reverseReceiptBookingCore,
    reverseReceiptBookingForUser,
    type ReverseBookingDbClient,
} from "../src/lib/receipt-intake/reverse-booking";
import { RECEIPT_INTAKE_STATES, routeState } from "../src/lib/receipt-intake/route-state";
import { receiptUrlRef, resolveReceiptUrl } from "../src/lib/receipt-intake/receipt-url";

// ── in-memory database ─────────────────────────────────────────────────────
type Row = Record<string, any>;
let expenses: Row[];
let intakes: Row[];
let events: Row[];
let costCodes: Row[];

const actor = { id: "u-admin", email: "admin@example.test" };

function seed() {
    costCodes = [{ id: "cc-1", code: "03-PLUMB", name: "Plumbing" }];
    expenses = [
        // The receipt-intake copy (to be reversed), phase set.
        { id: "exp-intake", projectId: "job-1", estimateId: "est-1", costCodeId: "cc-1", costCodeSource: "capture", costCodeConfidence: null, amount: "2008.60", vendor: "Lowe's", date: new Date("2026-09-15T00:00:00Z"), qbPurchaseId: null, invoiceId: null, invoicedAt: null, receiptUrl: "receipt-intake://receipt-intake/receipts/intake/ri-1.jpg" },
        // The QuickBooks-import twin: QB-linked, no phase.
        { id: "exp-qbo", projectId: "job-1", estimateId: "est-1", costCodeId: null, amount: "2008.60", vendor: "Lowe's", date: new Date("2026-09-11T00:00:00Z"), qbPurchaseId: "6879", invoiceId: null, invoicedAt: null, receiptUrl: null, costCodeSource: null, costCodeConfidence: null },
        // Unrelated cost on the same job.
        { id: "exp-other", projectId: "job-1", estimateId: "est-1", costCodeId: null, amount: "100.00", vendor: "Other", date: null, qbPurchaseId: null, invoiceId: null, invoicedAt: null, receiptUrl: null },
        // QB-linked expense that (wrongly) also has a receipt row.
        { id: "exp-qb-receipt", projectId: "job-1", estimateId: "est-1", costCodeId: null, amount: "50.00", vendor: "X", date: null, qbPurchaseId: "7000", invoiceId: null, invoicedAt: null, receiptUrl: null },
        { id: "exp-other-job", projectId: "job-2", estimateId: "est-2", costCodeId: null, amount: "2008.60", vendor: "Lowe's", date: null, qbPurchaseId: "6880", invoiceId: null, invoicedAt: null, receiptUrl: null },
    ];
    intakes = [
        { id: "ri-1", storagePath: "receipts/intake/sealed-ri-1.jpg", state: "BOOKED", expenseId: "exp-intake", qbPurchaseId: null, postVoidQbPurchaseId: null, sendAttempted: false, claimToken: null, claimedAt: null, refNumber: "12584", dedupStrongKey: "S1", dedupWeakKey: "W1", fileSha256: "sha-1", vendor: "Lowe's", totalCents: 200860, bookedAt: new Date("2026-09-21T00:00:00Z"), stateReason: null },
        { id: "ri-qb", state: "BOOKED", expenseId: "exp-qb-receipt", qbPurchaseId: null, postVoidQbPurchaseId: null, sendAttempted: false, claimToken: null, claimedAt: null, refNumber: null, dedupStrongKey: "S2", dedupWeakKey: "W2", fileSha256: "sha-2", vendor: "X", totalCents: 5000, bookedAt: null, stateReason: null },
        { id: "ri-read", state: "READ", expenseId: null, qbPurchaseId: null, postVoidQbPurchaseId: null, sendAttempted: false, claimToken: null, claimedAt: null, refNumber: null, dedupStrongKey: null, dedupWeakKey: null, fileSha256: "sha-3", vendor: null, totalCents: null, bookedAt: null, stateReason: null },
    ];
    events = [];
}

const jobCost = (projectId: string) =>
    expenses.filter(e => e.projectId === projectId).reduce((sum, e) => sum + Math.round(Number(e.amount) * 100), 0) / 100;

const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
        if (k === "OR") return (v as Row[]).some(branch => matches(row, branch));
        if (v !== null && typeof v === "object" && !(v instanceof Date) && "not" in (v as Row)) return row[k] !== (v as Row).not;
        return row[k] === v;
    });

let afterReadHook: (() => void) | null = null;
/** Does the proof query say the removed copy's phase is still a phase of the job? */
let phaseIsOnJob = true;
let expenseUpdates: Row[] = [];

const tx: any = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ value: "1" }],
    $queryRawUnsafe: async (query: string) => {
        // assertPhaseOfProjectTx: project, cost code, and the membership proof.
        if (/^SELECT id, status FROM "Project"/.test(query)) return [{ id: "job-1", status: "In Progress" }];
        if (/^SELECT id, code, "isActive" FROM "CostCode"/.test(query)) return [{ id: "cc-1", code: "03-PLUMB", isActive: true }];
        if (/FOR SHARE OF ei, e/.test(query)) return phaseIsOnJob ? [{ ok: 1 }] : [];
        return [{}];
    },
    receiptIntake: {
        findUnique: async ({ where }: any) => {
            const row = intakes.find(i => i.id === where.id);
            if (!row) return null;
            const expense = row.expenseId ? expenses.find(e => e.id === row.expenseId) ?? null : null;
            const out = { ...row, expense: expense && { ...expense, costCode: costCodes.find(c => c.id === expense.costCodeId) ?? null } };
            if (afterReadHook) { const hook = afterReadHook; afterReadHook = null; hook(); }
            return out;
        },
        updateMany: async ({ where, data }: any) => {
            const hits = intakes.filter(i => matches(i, where));
            hits.forEach(i => Object.assign(i, data));
            return { count: hits.length };
        },
    },
    expense: {
        findUnique: async ({ where }: any) => {
            const e = expenses.find(x => x.id === where.id);
            return e ? { ...e, costCode: costCodes.find(c => c.id === e.costCodeId) ?? null } : null;
        },
        updateMany: async ({ where, data }: any) => {
            const hits = expenses.filter(e => matches(e, where));
            hits.forEach(e => Object.assign(e, data));
            expenseUpdates.push({ where, data });
            return { count: hits.length };
        },
        deleteMany: async ({ where }: any) => {
            const before = expenses.length;
            expenses = expenses.filter(e => !matches(e, where));
            return { count: before - expenses.length };
        },
    },
    automationEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
};

// A failing transaction must roll back, like Postgres does.
const db: ReverseBookingDbClient = {
    $transaction: async fn => {
        const snap = { e: structuredClone(expenses), i: structuredClone(intakes), ev: structuredClone(events) };
        try {
            return await fn(tx);
        } catch (error) {
            expenses = snap.e; intakes = snap.i; events = snap.ev;
            throw error;
        }
    },
};

const reverse = (over: Partial<Parameters<typeof reverseReceiptBookingCore>[1]> = {}) =>
    reverseReceiptBookingCore(db, { receiptIntakeId: "ri-1", expectedExpenseId: "exp-intake", expectedProjectId: "job-1", reasonKind: "customer-payment", actor, ...over });

const refusal = async (promise: Promise<unknown>, message: string) => {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(isReverseBookingRefusedError(error), String(error));
        assert.equal((error as Error).message, message);
        return true;
    });
};

beforeEach(() => { seed(); phaseIsOnJob = true; expenseUpdates = []; afterReadHook = null; });

// ── core ───────────────────────────────────────────────────────────────────
test("removes exactly the expense, job cost drops by that amount, row ends REVERSED with expenseId null", async () => {
    const before = jobCost("job-1");
    const otherJobBefore = jobCost("job-2");
    const result = await reverse();
    assert.equal(result.removedExpenseId, "exp-intake");
    assert.equal(result.amount, 2008.6);
    assert.equal(jobCost("job-1"), Math.round((before - 2008.6) * 100) / 100);
    assert.equal(jobCost("job-2"), otherJobBefore);
    assert.deepEqual(expenses.map(e => e.id).sort(), ["exp-other", "exp-other-job", "exp-qb-receipt", "exp-qbo"]);
    const row = intakes.find(i => i.id === "ri-1")!;
    assert.equal(row.state, REVERSED_STATE);
    assert.equal(row.expenseId, null);
    assert.equal(row.stateReason, "reversed: customer payment");
    // The dedup identity is untouched.
    assert.equal(row.dedupStrongKey, "S1");
    assert.equal(row.dedupWeakKey, "W1");
    assert.equal(row.fileSha256, "sha-1");
});

test("the kept QuickBooks import keeps its amount, vendor, date and QuickBooks link", async () => {
    const before = structuredClone(expenses.find(e => e.id === "exp-qbo")!);
    await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    const after = expenses.find(e => e.id === "exp-qbo")!;
    for (const field of ["id", "projectId", "estimateId", "amount", "vendor", "date", "qbPurchaseId", "invoiceId", "invoicedAt"]) {
        assert.deepEqual(after[field], before[field], field);
    }
});

test("refuses any row that is not BOOKED", async () => {
    await refusal(reverse({ receiptIntakeId: "ri-read", expectedExpenseId: "x" }), REVERSE_MESSAGES.notBooked);
    intakes.find(i => i.id === "ri-1")!.state = "ARCHIVED";
    await refusal(reverse(), REVERSE_MESSAGES.notBooked);
    await refusal(reverse({ receiptIntakeId: "nope" }), REVERSE_MESSAGES.gone);
    assert.equal(expenses.length, 5);
});

test("refuses a BOOKED row with no expense", async () => {
    intakes.find(i => i.id === "ri-1")!.expenseId = null;
    await refusal(reverse(), REVERSE_MESSAGES.noExpense);
});

test("refuses an expense linked to a QuickBooks purchase and changes nothing", async () => {
    await refusal(reverse({ receiptIntakeId: "ri-qb", expectedExpenseId: "exp-qb-receipt" }), REVERSE_MESSAGES.qboLinked);
    assert.equal(expenses.length, 5);
    assert.equal(intakes.find(i => i.id === "ri-qb")!.state, "BOOKED");
    assert.equal(events.length, 0);
});

test("refuses a billed expense", async () => {
    expenses.find(e => e.id === "exp-intake")!.invoiceId = "inv-1";
    await refusal(reverse(), REVERSE_MESSAGES.billed);
});

test("a second reversal of the same row is refused", async () => {
    await reverse();
    await refusal(reverse(), REVERSE_MESSAGES.notBooked);
    assert.equal(events.length, 1);
});

test("a concurrent change between the read and the write is refused and rolls back", async () => {
    afterReadHook = () => { intakes.find(i => i.id === "ri-1")!.state = "NEEDS_REVIEW"; };
    await refusal(reverse(), REVERSE_MESSAGES.notBooked);
    assert.ok(expenses.some(e => e.id === "exp-intake"));
    assert.equal(events.length, 0);
});

test("duplicate-of-qbo requires a valid kept expense", async () => {
    await refusal(reverse({ reasonKind: "duplicate-of-qbo" }), REVERSE_MESSAGES.needsKept);
    // not QuickBooks-linked
    await refusal(reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-other" }), REVERSE_MESSAGES.keptInvalid);
    // other job
    await refusal(reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-other-job" }), REVERSE_MESSAGES.keptInvalid);
    // itself / missing
    await refusal(reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-intake" }), REVERSE_MESSAGES.keptInvalid);
    await refusal(reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "missing" }), REVERSE_MESSAGES.keptInvalid);
    // different amount
    expenses.find(e => e.id === "exp-qbo")!.amount = "2008.61";
    await refusal(reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" }), REVERSE_MESSAGES.keptInvalid);
    assert.equal(expenses.length, 5);
});

test("an unknown reason is refused", async () => {
    await refusal(reverse({ reasonKind: "because" as any }), REVERSE_MESSAGES.badInput);
});

test("writes an audit event with the old values", async () => {
    await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.kind, "receipt-reversed");
    assert.equal(event.amountCents, 200860);
    assert.equal(event.vendor, "Lowe's");
    const detail = JSON.parse(event.detail);
    assert.equal(detail.expenseId, "exp-intake");
    assert.equal(detail.intakeId, "ri-1");
    assert.equal(detail.amount, "2008.60");
    assert.equal(detail.projectId, "job-1");
    assert.equal(detail.costCodeId, "cc-1");
    assert.equal(detail.date, "2026-09-15");
    assert.equal(detail.vendor, "Lowe's");
    assert.equal(detail.actor, actor.email);
    assert.equal(detail.keptExpenseId, "exp-qbo");
    assert.ok(detail.at);
    assert.equal(intakes.find(i => i.id === "ri-1")!.stateReason, "reversed: duplicate of QuickBooks import exp-qbo");
});

test("carry-over: the phase moves onto the kept QuickBooks import through costCodeId only", async () => {
    const result = await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.equal(result.phaseCarried, true);
    assert.equal(result.phaseToSet, null);
    const kept = expenses.find(e => e.id === "exp-qbo")!;
    assert.equal(kept.costCodeId, "cc-1");
    assert.equal(kept.costCodeSource, "manual");
    // Nothing else on the QuickBooks-linked row changed: amount, vendor, date, link.
    assert.equal(kept.amount, "2008.60");
    assert.equal(kept.qbPurchaseId, "6879");
    assert.equal(kept.vendor, "Lowe's");
    // The only writes to it were the phase and the receipt file, each pinned to the QuickBooks link.
    for (const update of expenseUpdates) {
        assert.equal(update.where.id, "exp-qbo");
        assert.equal(update.where.qbPurchaseId, "6879");
        assert.ok(Object.keys(update.data).every(k => ["costCodeId", "costCodeSource", "costCodeConfidence", "receiptUrl"].includes(k)), JSON.stringify(update.data));
    }
    // The receipt file follows, so the kept copy still counts as evidence for its bank line.
    assert.equal(kept.receiptUrl, "receipt-intake://receipt-intake/receipts/intake/sealed-ri-1.jpg");
    assert.equal(JSON.parse(events[0].detail).phaseCarried, true);
});

test("the carried receipt resolves after reversal even though the copied reference was stale", async () => {
    // The booked reference points at the upload path; the object was later sealed to
    // the intake row's current storagePath. Only the current path signs.
    const signed = (p: string) => (p === "receipts/intake/sealed-ri-1.jpg" ? `https://signed.example/${p}` : null);
    // The default fallback finds the intake THROUGH its linked Expense receiptUrl.
    const deps = {
        sign: async (p: string) => signed(p),
        currentPath: async (p: string) => {
            const row = intakes.find(i => {
                const linked = i.expenseId ? expenses.find(e => e.id === i.expenseId) : null;
                return linked?.receiptUrl === receiptUrlRef(p);
            });
            return row?.storagePath ?? null;
        },
    };
    const staleRef = expenses.find(e => e.id === "exp-intake")!.receiptUrl as string;
    // Control: before reversal the stale reference resolves only via the fallback.
    assert.equal(await resolveReceiptUrl(staleRef, 600, deps), "https://signed.example/receipts/intake/sealed-ri-1.jpg");
    await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    // Control: a plain copy of the stale reference has lost its fallback (the link is cut).
    assert.equal(await resolveReceiptUrl(staleRef, 600, deps), null);
    const kept = expenses.find(e => e.id === "exp-qbo")!;
    assert.equal(await resolveReceiptUrl(kept.receiptUrl, 600, deps), "https://signed.example/receipts/intake/sealed-ri-1.jpg");
});

test("an empty-string receiptUrl on the kept copy is treated as empty: carried, and receiptCarried reflects the write", async () => {
    expenses.find(e => e.id === "exp-qbo")!.receiptUrl = "";
    await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.ok(expenses.find(e => e.id === "exp-qbo")!.receiptUrl);
    assert.equal(JSON.parse(events[0].detail).receiptCarried, true);
});

test("phase carry-over: a human's pick is stamped manual; a machine's keeps its source and confidence", async () => {
    await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.equal(expenses.find(e => e.id === "exp-qbo")!.costCodeSource, "manual"); // "capture" is human
    for (const [source, confidence] of [["machine", null], ["ai", 0.73]] as const) {
        seed();
        Object.assign(expenses.find(e => e.id === "exp-intake")!, { costCodeSource: source, costCodeConfidence: confidence });
        const result = await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
        assert.equal(result.phaseCarried, true, source);
        const kept = expenses.find(e => e.id === "exp-qbo")!;
        assert.equal(kept.costCodeId, "cc-1");
        assert.equal(kept.costCodeSource, source);
        assert.equal(kept.costCodeConfidence, confidence);
    }
});

test("phase carry-over: never onto a kept import where a person chose NO phase (manual-none)", async () => {
    expenses.find(e => e.id === "exp-qbo")!.costCodeSource = "manual-none";
    const result = await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.equal(result.phaseCarried, false);
    assert.deepEqual(result.phaseToSet, { keptExpenseId: "exp-qbo", costCodeId: "cc-1", code: "03-PLUMB", name: "Plumbing" });
    const kept = expenses.find(e => e.id === "exp-qbo")!;
    assert.equal(kept.costCodeId, null);
    assert.equal(kept.costCodeSource, "manual-none");
});

test("phase carry-over: a person choosing manual-none in the gap wins (the predicate carries costCodeSource)", async () => {
    const original = tx.expense.updateMany;
    tx.expense.updateMany = async (args: any) => {
        if ("costCodeId" in (args.data ?? {})) expenses.find(e => e.id === "exp-qbo")!.costCodeSource = "manual-none";
        return original(args);
    };
    let result;
    try {
        result = await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    } finally {
        tx.expense.updateMany = original;
    }
    assert.equal(result.phaseCarried, false);
    assert.ok(result.phaseToSet);
    assert.equal(expenses.find(e => e.id === "exp-qbo")!.costCodeId, null);
});

test("phase carry-over: never onto a kept import that is already invoiced", async () => {
    for (const field of ["invoiceId", "invoicedAt"] as const) {
        seed();
        expenses.find(e => e.id === "exp-qbo")![field] = field === "invoiceId" ? "inv-1" : new Date();
        const result = await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
        assert.equal(result.phaseCarried, false, field);
        assert.ok(result.phaseToSet, field);
        assert.equal(expenses.find(e => e.id === "exp-qbo")!.costCodeId, null, field);
    }
});

test("receiptCarried is false when the kept copy already has a receipt (nothing written)", async () => {
    expenses.find(e => e.id === "exp-qbo")!.receiptUrl = "https://drive.google.com/file/d/abc/view";
    await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.equal(expenses.find(e => e.id === "exp-qbo")!.receiptUrl, "https://drive.google.com/file/d/abc/view");
    assert.equal(JSON.parse(events[0].detail).receiptCarried, false);
});

test("receiptCarried comes from the update count: a lost race reports false", async () => {
    // The kept copy gains a receipt between the locked read and the write.
    const original = tx.expense.updateMany;
    tx.expense.updateMany = async (args: any) => {
        if ("receiptUrl" in (args.data ?? {})) { expenses.find(e => e.id === "exp-qbo")!.receiptUrl = "https://x.example/r"; }
        return original(args);
    };
    try {
        await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    } finally {
        tx.expense.updateMany = original;
    }
    assert.equal(expenses.find(e => e.id === "exp-qbo")!.receiptUrl, "https://x.example/r");
    assert.equal(JSON.parse(events[0].detail).receiptCarried, false);
});

test("carry-over: not done when the kept copy already has a phase, or for a customer payment", async () => {
    expenses.find(e => e.id === "exp-qbo")!.costCodeId = "cc-9";
    const result = await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.equal(result.phaseCarried, false);
    assert.equal(result.phaseToSet, null);
    assert.equal(expenses.find(e => e.id === "exp-qbo")!.costCodeId, "cc-9");
    seed();
    expenseUpdates = [];
    const customer = await reverse();
    assert.equal(customer.phaseCarried, false);
    assert.equal(customer.phaseToSet, null);
    assert.equal(expenseUpdates.length, 0);
});

test("carry-over: when the phase is no longer a phase of the job it is returned for a person, never forced", async () => {
    phaseIsOnJob = false;
    const result = await reverse({ reasonKind: "duplicate-of-qbo", keptExpenseId: "exp-qbo" });
    assert.equal(result.phaseCarried, false);
    assert.deepEqual(result.phaseToSet, { keptExpenseId: "exp-qbo", costCodeId: "cc-1", code: "03-PLUMB", name: "Plumbing" });
    assert.equal(expenses.find(e => e.id === "exp-qbo")!.costCodeId, null);
});

test("server pins what the dialog showed: a different expense or job than expected is refused", async () => {
    await refusal(reverse({ expectedExpenseId: "exp-other" }), REVERSE_MESSAGES.changed);
    await refusal(reverse({ expectedProjectId: "job-2" }), REVERSE_MESSAGES.changed);
    // Move to job after the page loaded: the expense is on another job now.
    expenses.find(e => e.id === "exp-intake")!.projectId = "job-2";
    await refusal(reverse(), REVERSE_MESSAGES.changed);
    assert.ok(expenses.some(e => e.id === "exp-intake"));
});

test("the audit row uses the values re-read UNDER the locks, not the first unlocked read", async () => {
    // Between the unlocked read and the locked re-read the vendor is corrected.
    afterReadHook = () => { expenses.find(e => e.id === "exp-intake")!.vendor = "Lowe's Home Centers"; };
    await reverse();
    assert.equal(events[0].vendor, "Lowe's Home Centers");
    assert.equal(JSON.parse(events[0].detail).vendor, "Lowe's Home Centers");
});

test("refuses a row QuickBooks may hold, a send that started, or a live worker claim", async () => {
    for (const [field, value] of [["sendAttempted", true], ["qbPurchaseId", "99"], ["postVoidQbPurchaseId", "98"]] as const) {
        seed();
        intakes.find(i => i.id === "ri-1")![field] = value;
        await refusal(reverse(), REVERSE_MESSAGES.askJustin);
        assert.ok(expenses.some(e => e.id === "exp-intake"), field);
    }
    // ANY claim blocks, exactly as Move to job does: a booked row carries no claim.
    for (const claimedAt of [new Date("2026-10-28T11:59:00Z"), new Date("2026-10-28T08:00:00Z"), null]) {
        seed();
        Object.assign(intakes.find(i => i.id === "ri-1")!, { claimToken: "tok", claimedAt });
        await refusal(reverse({ now: new Date("2026-10-28T12:00:00Z") }), REVERSE_MESSAGES.askJustin);
        assert.ok(expenses.some(e => e.id === "exp-intake"));
    }
});

// ── re-sent file is stopped ────────────────────────────────────────────────
/** The state list of the real partial unique index, read from its migration. */
function indexExcludedStates(): string[] {
    const sql = readFileSync(path.join(__dirname, "../prisma/migrations/20260901000000_receipt_intake/migration.sql"), "utf8");
    const match = sql.match(/ReceiptIntake_dedupStrongKey_active_key"[\s\S]*?"state" NOT IN \(([^)]*)\)/);
    assert.ok(match, "index definition not found");
    return [...match![1].matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
}

test("REVERSED is a known state and is NOT among the states the dedup index lets go of", () => {
    assert.ok((RECEIPT_INTAKE_STATES as readonly string[]).includes(REVERSED_STATE));
    const released = indexExcludedStates();
    assert.deepEqual(released.sort(), ["DUPLICATE", "VOID"]);
    assert.ok(!released.includes(REVERSED_STATE));
});

test("a re-sent identical file collides with the reversed row's key and routes to DUPLICATE, never to booking", async () => {
    await reverse();
    const released = indexExcludedStates();
    // The unique index: another row cannot claim a key an indexed row holds.
    const claim = (key: string) => intakes.find(i => i.dedupStrongKey === key && !released.includes(i.state));
    const owner = claim("S1");
    assert.ok(owner, "the reversed row must still own the strong key");
    assert.equal(owner!.id, "ri-1");
    // The worker's owner lookup (route.ts strongOwnerOrRethrow) excludes only DUPLICATE/VOID too.
    const route = readFileSync(path.join(__dirname, "../src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    assert.match(route, /state: \{ notIn: \["DUPLICATE", "VOID"\] \}/);
    assert.ok(!/notIn: \[[^\]]*REVERSED/.test(route));
    // Routing with that owner as the strong hit: same total + vendor => DUPLICATE.
    const decision = routeState(
        { docType: "receipt", amount: "2008.60", totalCents: 200860, canonicalVendor: "lowes", dateStr: "2026-09-15", referenceDay: "2026-10-01" },
        { strong: { id: owner!.id, totalCents: owner!.totalCents, canonicalVendor: "lowes" }, weak: null },
        true,
    );
    assert.equal(decision.state, "DUPLICATE");
    assert.equal(decision.duplicateOfId, "ri-1");
    // Contrast: a VOID row would have handed the key back.
    intakes.find(i => i.id === "ri-1")!.state = "VOID";
    assert.equal(claim("S1"), undefined);
});

// ── admin gate ─────────────────────────────────────────────────────────────
test("gate: only ADMIN may reverse (MANAGER, FINANCE, FIELD_CREW are refused before any database work)", async () => {
    let opened = 0;
    const counting: ReverseBookingDbClient = { $transaction: fn => { opened++; return db.$transaction(fn); } };
    for (const role of ["MANAGER", "FINANCE", "FIELD_CREW", ""]) {
        const res = await reverseReceiptBookingForUser(counting, { id: "u", role, email: "x@example.test" }, { receiptIntakeId: "ri-1", expectedExpenseId: "exp-intake", expectedProjectId: "job-1", reasonKind: "customer-payment" });
        assert.deepEqual(res, { ok: false, message: REVERSE_MESSAGES.notAllowed });
    }
    assert.equal(opened, 0);
    assert.equal(intakes.find(i => i.id === "ri-1")!.state, "BOOKED");
    const ok = await reverseReceiptBookingForUser(counting, { id: "u-admin", role: "ADMIN", email: "admin@example.test" }, { receiptIntakeId: "ri-1", expectedExpenseId: "exp-intake", expectedProjectId: "job-1", reasonKind: "customer-payment" });
    assert.equal(ok.ok, true);
    assert.equal(opened, 1);
    assert.equal(intakes.find(i => i.id === "ri-1")!.state, REVERSED_STATE);
});

test("gate: a refusal comes back as a value, and the audit row records the admin", async () => {
    const admin = { id: "u-admin", role: "ADMIN", email: "admin@example.test" };
    const first = await reverseReceiptBookingForUser(db, admin, { receiptIntakeId: "ri-1", expectedExpenseId: "exp-intake", expectedProjectId: "job-1", reasonKind: "customer-payment" });
    assert.equal(first.ok, true);
    assert.equal(JSON.parse(events[0].detail).actorId, "u-admin");
    const second = await reverseReceiptBookingForUser(db, admin, { receiptIntakeId: "ri-1", expectedExpenseId: "exp-intake", expectedProjectId: "job-1", reasonKind: "customer-payment" });
    assert.deepEqual(second, { ok: false, message: REVERSE_MESSAGES.notBooked });
});

test("the server action delegates to the ADMIN-gated entry point", () => {
    const src = readFileSync(path.join(__dirname, "../src/lib/actions.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function reverseReceiptBooking"));
    assert.ok(body.slice(0, 900).includes("reverseReceiptBookingForUser("));
    const lib = readFileSync(path.join(__dirname, "../src/lib/receipt-intake/reverse-booking.ts"), "utf8");
    assert.ok(lib.indexOf('user.role !== "ADMIN"') > 0 && lib.indexOf('user.role !== "ADMIN"') < lib.indexOf("reverseReceiptBookingCore(db"));
});
