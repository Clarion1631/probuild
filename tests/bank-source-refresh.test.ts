import assert from "node:assert/strict";
import test from "node:test";
import {
    HISTORY_MISSING_WARNING,
    RETIRED_EXPENSE_DESCRIPTION,
    RETIRED_EXPENSE_WARNING,
    RETIREMENT_RACE_REASON,
    SOURCE_REFRESH_AUDIT_ACTION,
    SOURCE_REFRESH_BASIS,
    SourceRefreshRollback,
    createBankSourceRefreshHandlers,
    createRefreshApplier,
    planSourceRefresh,
    isCalendarDay,
    parseDecimalCents,
    type BankSourceRefreshDependencies,
    type ExpenseEvidence,
    type ExpenseRetirementEvidence,
    type ObservationSnapshot,
    type RefreshEvidence,
    type RefreshItemResult,
} from "../src/lib/bank-source-refresh";
import { registerRowToIngestLine } from "../src/lib/bank-register-pull";
import { BANK_LEDGER_EPOCH_KEY } from "../src/lib/bank-ledger-epoch";
import { RECEIPT_EVIDENCE_LOCK } from "../src/lib/receipt-evidence-lock";
import { BANK_LINE_IDENTITY_LOCK } from "../src/lib/bank-reconcile-guard";
import type { BankRegisterResult, BankRegisterRow } from "../src/lib/qbo-bank-register";

const ID = "6456";
const URL = "http://localhost/api/integrations/bank-ledger/source-refresh";

function registerRow(overrides: Partial<BankRegisterRow> = {}): BankRegisterRow {
    return { date: "2026-09-02", qbType: "Expense", qbTxnId: ID, docNum: null, name: "Home Depot", memo: null, amountCents: -12345, clearedStatus: "Cleared", ...overrides } as BankRegisterRow;
}

function register(rows: BankRegisterRow[] = [registerRow()], overrides: Partial<BankRegisterResult> = {}): BankRegisterResult {
    return { stale: false, clearedProbeOk: true, fetchedAt: "2026-09-09T01:00:00.000Z", accountId: "35", startDate: "2026-07-12", endDate: "2026-09-09", rows, ...overrides } as BankRegisterResult;
}

function oldObservation(overrides: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
    return { id: "obs-1", postedDate: "2026-08-30", rawDescriptor: "Home Depot Expense", amountCents: -12345, checkNumber: null, createdAt: "2026-08-31T04:00:00.000Z", clearedStatus: "Cleared", bankLineId: null, ...overrides };
}

function purchase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        Id: ID, TxnDate: "2026-09-02", TotalAmt: 123.45, SyncToken: "2",
        EntityRef: { name: "Home Depot", value: "55" }, AccountRef: { name: "WTB Checking", value: "35" },
        PrivateNote: null, DocNumber: null,
        MetaData: { CreateTime: "2026-08-30T10:00:00-07:00", LastUpdatedTime: "2026-09-03T08:00:00-07:00" },
        ...overrides,
    };
}

/** An Expense that IS the current authenticated Purchase 6456. */
function matchingExpense(overrides: Partial<ExpenseEvidence> = {}): ExpenseEvidence {
    return { id: "exp-1", qbPurchaseId: ID, date: "2026-09-02", amount: "123.45", qbSyncToken: "2", vendor: "Home Depot", ...overrides };
}

function evidence(overrides: Partial<RefreshEvidence> = {}): RefreshEvidence {
    return { observations: [oldObservation()], bankLines: [], expenses: [], intakes: [], ...overrides };
}

function plan(overrides: { evidence?: RefreshEvidence; register?: BankRegisterResult; purchaseRaw?: unknown } = {}) {
    return planSourceRefresh({ qbTxnId: ID, evidence: overrides.evidence ?? evidence(), register: overrides.register ?? register(), purchaseRaw: "purchaseRaw" in overrides ? overrides.purchaseRaw : purchase() });
}

/** In-memory world with a staged-commit apply, so a rollback really discards writes. */
function makeWorld(overrides: Partial<BankSourceRefreshDependencies> = {}) {
    const world = { obs: oldObservation(), audit: [] as Record<string, unknown>[], order: [] as string[], registerReads: 0, evidenceReads: 0, purchaseReads: 0, applyCalls: 0, concurrentClearance: false };
    const currentEvidence = (): RefreshEvidence => evidence({ observations: [{ ...world.obs }] });
    const deps: BankSourceRefreshDependencies = {
        authorize: request => request.headers.get("authorization") === "Bearer good",
        readRegister: async () => { world.registerReads++; return register(); },
        readPurchase: async () => { world.purchaseReads++; return purchase(); },
        readEvidence: async () => { world.evidenceReads++; return currentEvidence(); },
        apply: async (_id, body) => {
            world.applyCalls++;
            const staged = { next: null as null | { postedDate: string; rawDescriptor: string }, audit: [] as Record<string, unknown>[] };
            try {
                const result = await body({
                    readEvidence: async () => currentEvidence(),
                    bumpEpoch: async () => { world.order.push("epoch"); },
                    updateObservation: async (old, next) => {
                        world.order.push("cas");
                        if (world.concurrentClearance) world.obs.clearedStatus = "Uncleared";
                        const same = (Object.keys(old) as (keyof ObservationSnapshot)[]).every(key => old[key] === world.obs[key]);
                        if (!same) return 0;
                        staged.next = next;
                        return 1;
                    },
                    appendAudit: async (_entityId, snapshot) => { world.order.push("audit"); staged.audit.push(snapshot); },
                });
                if (staged.next) world.obs = { ...world.obs, ...staged.next };
                world.audit.push(...staged.audit);
                return result;
            } catch (error) {
                if (error instanceof SourceRefreshRollback) return error.result;
                throw error;
            }
        },
        ...overrides,
    };
    return { world, handlers: createBankSourceRefreshHandlers(deps) };
}

function request(body: unknown, init: { auth?: string; raw?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: init.auth ?? "Bearer good", ...(init.headers ?? {}) };
    return new Request(URL, { method: "POST", headers, body: init.raw ?? JSON.stringify(body) });
}

async function results(res: Response): Promise<RefreshItemResult[]> {
    return (await res.json()).results as RefreshItemResult[];
}

test("source refresh: auth fails before any read", async () => {
    const { world, handlers } = makeWorld();
    const res = await handlers.POST(request({ items: [{ qbTxnId: ID }] }, { auth: "Bearer bad" }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(world.registerReads + world.evidenceReads + world.purchaseReads + world.applyCalls, 0);
});

test("source refresh: strict, bounded body", async t => {
    const cases: [string, unknown, string][] = [
        ["empty items", { items: [] }, "invalid-items"],
        ["four items", { items: [1, 2, 3, 4].map(n => ({ qbTxnId: String(n) })) }, "invalid-items"],
        ["duplicate ids", { items: [{ qbTxnId: ID }, { qbTxnId: ID }] }, "duplicate-qb-txn-id"],
        ["non-numeric id", { items: [{ qbTxnId: "64a56" }] }, "invalid-qb-txn-id"],
        ["21 digits", { items: [{ qbTxnId: "1".repeat(21) }] }, "invalid-qb-txn-id"],
        ["force override", { items: [{ qbTxnId: ID }], force: true }, "unknown-field"],
        ["body-supplied date", { items: [{ qbTxnId: ID, postedDate: "2026-09-02" }] }, "unknown-field"],
        ["bad mode", { mode: "yolo", items: [{ qbTxnId: ID }] }, "invalid-mode"],
        ["apply without digest", { mode: "apply", items: [{ qbTxnId: ID }] }, "missing-digest"],
        ["bad digest", { mode: "apply", items: [{ qbTxnId: ID, expectedDigest: "nope" }] }, "invalid-digest"],
        ["array body", [], "invalid-body"],
    ];
    for (const [name, body, reason] of cases) {
        await t.test(name, async () => {
            const { world, handlers } = makeWorld();
            const res = await handlers.POST(request(body));
            assert.equal(res.status, 400, name);
            assert.equal((await res.json()).reason, reason);
            assert.equal(world.registerReads, 0);
        });
    }

    await t.test("413 on Content-Length over 8KB without reading", async () => {
        const { world, handlers } = makeWorld();
        const res = await handlers.POST(request(null, { raw: JSON.stringify({ items: [{ qbTxnId: ID }] }), headers: { "content-length": "9000" } }));
        assert.equal(res.status, 413);
        assert.equal(world.registerReads, 0);
    });

    await t.test("413 on a streamed body over 8KB with no Content-Length", async () => {
        const { world, handlers } = makeWorld();
        const big = new TextEncoder().encode("{\"items\":[{\"qbTxnId\":\"" + "1".repeat(9000) + "\"}]}");
        const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < big.length; i += 1024) c.enqueue(big.slice(i, i + 1024)); c.close(); } });
        const req = new Request(URL, { method: "POST", headers: { authorization: "Bearer good" }, body: stream, duplex: "half" } as RequestInit);
        const res = await handlers.POST(req);
        assert.equal(res.status, 413);
        assert.equal(world.registerReads, 0);
    });
});

test("source refresh: realistic 6456 legacy descriptor + moved date is eligible on dry-run, with no writes", async () => {
    const { world, handlers } = makeWorld();
    const res = await handlers.POST(request({ items: [{ qbTxnId: ID }] }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const [item] = await results(res);
    assert.equal(item.status, "eligible");
    if (item.status !== "eligible") return;
    assert.equal(item.plan.basis, SOURCE_REFRESH_BASIS);
    assert.deepEqual(item.plan.warnings, [HISTORY_MISSING_WARNING]);
    assert.match(item.plan.digest, /^[0-9a-f]{64}$/);
    // Shared converter is the target, not a second implementation.
    const converted = registerRowToIngestLine(registerRow())!;
    assert.deepEqual(item.plan.next, { postedDate: converted.postedDate, rawDescriptor: converted.rawDescriptor });
    assert.equal(item.plan.next.postedDate, "2026-09-02");
    assert.equal(item.plan.next.rawDescriptor, "Home Depot");
    assert.equal(world.applyCalls, 0);
    assert.equal(world.audit.length, 0);
    assert.equal(world.obs.postedDate, "2026-08-30");
    assert.deepEqual(item.evidence.observations, [oldObservation()], "dry-run shows the full old snapshot");
    assert.deepEqual(item.plan.localEvidence, item.evidence);
    assert.equal(item.plan.purchase.CreateTime, "2026-08-30T10:00:00-07:00");
    assert.equal(item.plan.purchase.LastUpdatedTime, "2026-09-03T08:00:00-07:00");
    assert.ok(!JSON.stringify(item).includes("must not leak"), "PrivateNote never surfaces");
});

test("source refresh: a matching Expense is shown on dry-run, applied around, and left untouched", async () => {
    const expense = matchingExpense();
    const { world, handlers } = makeWorld({ readEvidence: async () => evidence({ observations: [{ ...oldObservation() }], expenses: [{ ...expense }] }) });
    const { handlers: applyHandlers } = { handlers: createBankSourceRefreshHandlers({
        authorize: () => true,
        readRegister: async () => register(),
        readPurchase: async () => purchase(),
        readEvidence: async () => evidence({ observations: [{ ...world.obs }], expenses: [{ ...expense }] }),
        apply: async (_id, body) => body({
            readEvidence: async () => evidence({ observations: [{ ...world.obs }], expenses: [{ ...expense }] }),
            bumpEpoch: async () => { world.order.push("epoch"); },
            updateObservation: async (_old, next) => { world.order.push("cas"); world.obs = { ...world.obs, ...next }; return 1; },
            appendAudit: async (_entityId, snapshot) => { world.order.push("audit"); world.audit.push(snapshot); },
        }),
    }) };
    void handlers;
    const [dry] = await results(await applyHandlers.POST(request({ items: [{ qbTxnId: ID }] })));
    assert.equal(dry.status, "eligible");
    if (dry.status !== "eligible") return;
    assert.deepEqual(dry.evidence.expenses, [expense]);
    const [applied] = await results(await applyHandlers.POST(request({ mode: "apply", items: [{ qbTxnId: ID, expectedDigest: dry.plan.digest }] })));
    assert.equal(applied.status, "applied");
    assert.deepEqual(world.order, ["epoch", "cas", "audit"]);
    assert.deepEqual(expense, matchingExpense(), "Expense never mutated");
    const snapshot = world.audit[0] as Record<string, unknown>;
    assert.deepEqual((snapshot.localEvidence as RefreshEvidence).expenses, [expense]);
    const sourcePurchase = snapshot.sourcePurchase as Record<string, unknown>;
    assert.equal(sourcePurchase.CreateTime, "2026-08-30T10:00:00-07:00");
    assert.equal(sourcePurchase.LastUpdatedTime, "2026-09-03T08:00:00-07:00");
});

test("source refresh: digest excludes only fetchedAt; includes SyncToken, MetaData timestamps, old snapshot and Expense evidence", () => {
    const base = plan();
    assert.equal(base.status, "eligible");
    if (base.status !== "eligible") return;
    const laterFetch = plan({ register: register([registerRow()], { fetchedAt: "2026-09-09T02:00:00.000Z" }) });
    const laterMeta = plan({ purchaseRaw: purchase({ MetaData: { CreateTime: "2026-08-30T10:00:00-07:00", LastUpdatedTime: "2026-09-04T00:00:00-07:00" } }) });
    assert.equal(laterFetch.status === "eligible" && laterFetch.plan.digest, base.plan.digest);
    assert.notEqual(laterMeta.status === "eligible" && laterMeta.plan.digest, base.plan.digest, "LastUpdatedTime is a source version field");
    const withExpense = plan({ evidence: evidence({ expenses: [matchingExpense()] }) });
    assert.equal(withExpense.status, "eligible");
    assert.notEqual(withExpense.status === "eligible" && withExpense.plan.digest, base.plan.digest, "Expense evidence is covered by the digest");
    const newSync = plan({ purchaseRaw: purchase({ SyncToken: "3" }) });
    assert.notEqual(newSync.status === "eligible" && newSync.plan.digest, base.plan.digest);
    const olderCreated = plan({ evidence: evidence({ observations: [oldObservation({ createdAt: "2026-08-29T00:00:00.000Z" })] }) });
    assert.notEqual(olderCreated.status === "eligible" && olderCreated.plan.digest, base.plan.digest);
});

test("source refresh: independent linkage and duplicates block with bounded evidence", async t => {
    const cases: [string, RefreshEvidence, string][] = [
        ["linked observation", evidence({ observations: [oldObservation({ bankLineId: "bl-1" })] }), "observation-linked"],
        ["two observations", evidence({ observations: [oldObservation(), oldObservation({ id: "obs-2" })] }), "observation-duplicate"],
        ["canonical line by qbTxnId", evidence({ bankLines: [{ id: "bl-9", account: "WTB-0723", postedDate: "2026-08-30", amountCents: -12345, state: "CANONICAL", sourceOfRecord: "QBO", probuildExpenseId: null }] }), "canonical-line-exists"],
        ["two expenses by qbPurchaseId", evidence({ expenses: [matchingExpense(), matchingExpense({ id: "exp-2" })] }), "expense-multiple"],
        ["expense with a different purchase id", evidence({ expenses: [matchingExpense({ qbPurchaseId: "6457" })] }), "expense-purchase-id-mismatch"],
        ["expense with null purchase id", evidence({ expenses: [matchingExpense({ qbPurchaseId: null })] }), "expense-purchase-id-mismatch"],
        ["expense date missing", evidence({ expenses: [matchingExpense({ date: null })] }), "expense-date-missing"],
        ["expense date stale", evidence({ expenses: [matchingExpense({ date: "2026-08-30" })] }), "expense-date-mismatch"],
        ["expense amount differs", evidence({ expenses: [matchingExpense({ amount: "123.46" })] }), "expense-amount-mismatch"],
        ["expense amount blank", evidence({ expenses: [matchingExpense({ amount: "" })] }), "expense-amount-malformed"],
        ["expense amount exponent", evidence({ expenses: [matchingExpense({ amount: "1.2345e2" })] }), "expense-amount-malformed"],
        ["expense amount sub-cent", evidence({ expenses: [matchingExpense({ amount: "123.450" })] }), "expense-amount-malformed"],
        ["expense amount garbage", evidence({ expenses: [matchingExpense({ amount: "123.45 USD" })] }), "expense-amount-malformed"],
        ["expense sync token missing", evidence({ expenses: [matchingExpense({ qbSyncToken: null })] }), "expense-sync-token-missing"],
        ["expense sync token stale", evidence({ expenses: [matchingExpense({ qbSyncToken: "1" })] }), "expense-sync-token-stale"],
        ["expense vendor missing", evidence({ expenses: [matchingExpense({ vendor: null })] }), "expense-vendor-missing"],
        ["expense vendor differs", evidence({ expenses: [matchingExpense({ vendor: "Lowes" })] }), "expense-vendor-mismatch"],
        ["receipt intake", evidence({ intakes: [{ id: "ri-1", state: "BOOKED", expenseId: null }] }), "receipt-intake-linked"],
    ];
    for (const [name, ev, reason] of cases) {
        await t.test(name, () => {
            const outcome = plan({ evidence: ev });
            assert.equal(outcome.status, "blocked");
            if (outcome.status !== "blocked") return;
            assert.equal(outcome.reason, reason);
            const { sourcePurchase: _purchase, sourceRegister: _register, ...local } = outcome.evidence;
            assert.deepEqual(local, ev, "all local evidence is retained alongside optional source proof");
        });
    }

    await t.test("strict decimal parse", () => {
        assert.equal(parseDecimalCents("123.45"), 12345);
        assert.equal(parseDecimalCents("7"), 700);
        assert.equal(parseDecimalCents("0.5"), 50);
        for (const bad of ["", " 1", "-1", "+1", "1e2", "1.234", "0", "0.00", "abc", "1,000", ".5", "5."]) assert.equal(parseDecimalCents(bad), null, JSON.stringify(bad));
    });

    await t.test("exactly one matching Expense is eligible, its evidence is shown, and it is preserved in the plan", () => {
        const ev = evidence({ expenses: [matchingExpense()] });
        const outcome = plan({ evidence: ev });
        assert.equal(outcome.status, "eligible");
        if (outcome.status !== "eligible") return;
        assert.deepEqual(outcome.evidence.expenses, [matchingExpense()]);
        assert.deepEqual(outcome.plan.localEvidence.expenses, ev.expenses);
        assert.deepEqual(outcome.plan.localEvidence.observations, ev.observations);
        assert.equal(outcome.plan.localEvidence.sourcePurchase?.SyncToken, "2");
    });
});

test("source refresh: money, identity, vendor and source-health rules", async t => {
    const cases: [string, Parameters<typeof plan>[0], string][] = [
        ["stored amount differs from GL", { evidence: evidence({ observations: [oldObservation({ amountCents: -12346 })] }) }, "amount-changed"],
        ["GL amount not the negative of TotalAmt", { register: register([registerRow({ amountCents: 12345 })]) }, "purchase-amount-mismatch"],
        ["TotalAmt not positive", { purchaseRaw: purchase({ TotalAmt: -123.45 }) }, "purchase-amount-invalid"],
        ["TotalAmt fractional cents", { purchaseRaw: purchase({ TotalAmt: 123.456 }) }, "purchase-amount-invalid"],
        ["Purchase on another bank account", { purchaseRaw: purchase({ AccountRef: { name: "Other", value: "36" } }) }, "purchase-identity-mismatch"],
        ["Purchase id differs", { purchaseRaw: purchase({ Id: "6457" }) }, "purchase-identity-mismatch"],
        ["old row carries a check number", { evidence: evidence({ observations: [oldObservation({ checkNumber: "1027" })] }) }, "check-number-unsupported"],
        ["vendor renamed in Purchase", { purchaseRaw: purchase({ EntityRef: { name: "Lowes", value: "55" } }) }, "gl-entity-mismatch"],
        ["descriptor unrelated to vendor", { evidence: evidence({ observations: [oldObservation({ rawDescriptor: "Chevron Expense" })] }) }, "descriptor-unsupported"],
        ["Purchase TxnDate disagrees with GL", { purchaseRaw: purchase({ TxnDate: "2026-09-01" }) }, "purchase-date-mismatch"],
        ["missing SyncToken", { purchaseRaw: purchase({ SyncToken: null }) }, "purchase-metadata-missing"],
        ["Purchase 404", { purchaseRaw: null }, "purchase-unavailable"],
        ["Purchase is a credit (refused before projection)", { purchaseRaw: purchase({ Credit: true }) }, "purchase-is-credit"],
        ["Purchase deleted (refused before projection)", { purchaseRaw: purchase({ status: "Deleted" }) }, "purchase-deleted"],
        ["Purchase carries a DocNumber", { purchaseRaw: purchase({ DocNumber: "1027" }) }, "purchase-doc-number-mismatch"],
        ["GL date is not a calendar day", { register: register([registerRow({ date: "2026-02-30" })]), purchaseRaw: purchase({ TxnDate: "2026-02-30" }) }, "register-date-invalid"],
        ["LastUpdatedTime not a calendar timestamp", { purchaseRaw: purchase({ MetaData: { CreateTime: "2026-08-30T10:00:00-07:00", LastUpdatedTime: "2026-02-30T08:00:00-07:00" } }) }, "timestamp-invalid"],
        ["CreateTime garbage", { purchaseRaw: purchase({ MetaData: { CreateTime: "yesterday", LastUpdatedTime: "2026-09-03T08:00:00-07:00" } }) }, "timestamp-invalid"],
        ["meta timestamps validated even when the date is unchanged", { evidence: evidence({ observations: [oldObservation({ postedDate: "2026-09-02" })] }), purchaseRaw: purchase({ MetaData: { CreateTime: "2026-08-30T10:00:00-07:00", LastUpdatedTime: "not-a-time" } }) }, "timestamp-invalid"],
        ["Check type unsupported", { register: register([registerRow({ qbType: "Check", docNum: "1027" })]) }, "unsupported-type"],
        ["split id", { register: register([registerRow(), registerRow({ amountCents: -1 })]) }, "register-row-split"],
        ["stale register", { register: register([registerRow()], { stale: true }) }, "register-stale"],
        ["probe failed", { register: register([registerRow()], { clearedProbeOk: false }) }, "register-probe-failed"],
        ["row missing", { register: register([]) }, "register-row-missing"],
        ["source update older than observation", { purchaseRaw: purchase({ MetaData: { CreateTime: "2026-08-01T00:00:00Z", LastUpdatedTime: "2026-08-02T00:00:00Z" } }) }, "source-update-precedes-observation"],
    ];
    for (const [name, input, reason] of cases) {
        await t.test(name, () => {
            const outcome = plan(input);
            assert.equal(outcome.status, "blocked", name);
            assert.equal(outcome.status === "blocked" && outcome.reason, reason);
        });
    }

    await t.test("same canonical payee with a different date is eligible without the legacy warning", () => {
        const outcome = plan({ evidence: evidence({ observations: [oldObservation({ rawDescriptor: "HOME DEPOT" })] }) });
        assert.equal(outcome.status, "eligible");
        assert.deepEqual(outcome.status === "eligible" && outcome.plan.warnings, []);
    });

    await t.test("unchanged date and descriptor is a noop", () => {
        const outcome = plan({ evidence: evidence({ observations: [oldObservation({ postedDate: "2026-09-02", rawDescriptor: "Home Depot" })] }) });
        assert.equal(outcome.status, "noop");
    });

    await t.test("calendar round-trip rejects Feb 30 that Date.parse accepts", () => {
        assert.ok(isCalendarDay("2026-02-28"));
        assert.ok(!isCalendarDay("2026-02-30"));
        assert.ok(!isCalendarDay("2026-13-01"));
        assert.ok(!isCalendarDay("2026-9-2"));
    });
});

test("source refresh: apply", async t => {
    async function dryRunDigest(handlers: ReturnType<typeof makeWorld>["handlers"]) {
        const [item] = await results(await handlers.POST(request({ items: [{ qbTxnId: ID }] })));
        assert.equal(item.status, "eligible");
        return item.status === "eligible" ? item.plan.digest : "";
    }

    await t.test("changed token blocks apply and writes nothing", async () => {
        const { world, handlers } = makeWorld();
        const res = await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: ID, expectedDigest: "a".repeat(64) }] }));
        const [item] = await results(res);
        assert.equal(item.status, "blocked");
        assert.equal(item.status === "blocked" && item.reason, "digest-mismatch");
        assert.equal(world.applyCalls, 1);
        assert.deepEqual(world.order, []);
        assert.equal(world.audit.length, 0);
    });

    await t.test("valid token applies: epoch before CAS before audit, audit carries old+new+source, retry is a noop with no extra audit", async () => {
        const { world, handlers } = makeWorld();
        const digest = await dryRunDigest(handlers);
        const [item] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: ID, expectedDigest: digest }] })));
        assert.equal(item.status, "applied");
        assert.equal(item.status === "applied" && item.auditAction, SOURCE_REFRESH_AUDIT_ACTION);
        assert.deepEqual(world.order, ["epoch", "cas", "audit"]);
        assert.equal(world.obs.postedDate, "2026-09-02");
        assert.equal(world.obs.rawDescriptor, "Home Depot");
        assert.equal(world.obs.clearedStatus, "Cleared", "clearance untouched");
        assert.equal(world.audit.length, 1);
        const snapshot = world.audit[0] as Record<string, unknown>;
        assert.deepEqual(snapshot.new, { postedDate: "2026-09-02", rawDescriptor: "Home Depot" });
        assert.equal((snapshot.old as ObservationSnapshot).postedDate, "2026-08-30");
        assert.equal(snapshot.digest, digest);
        assert.equal(snapshot.basis, SOURCE_REFRESH_BASIS);
        assert.equal((snapshot.sourcePurchase as Record<string, unknown>).SyncToken, "2");
        assert.equal((snapshot.sourcePurchase as Record<string, unknown>).LastUpdatedTime, "2026-09-03T08:00:00-07:00");
        assert.deepEqual((snapshot.localEvidence as RefreshEvidence).observations[0], oldObservation(), "before-proof preserved in audit");
        assert.ok(!JSON.stringify(snapshot).includes("must not leak"));

        const [retry] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: ID, expectedDigest: digest }] })));
        assert.equal(retry.status, "noop");
        assert.equal(world.audit.length, 1);
        assert.equal(world.order.length, 3, "no second epoch bump or CAS");
    });

    await t.test("concurrent clearance change makes the CAS match 0 rows and rolls back without an audit row", async () => {
        const { world, handlers } = makeWorld();
        const digest = await dryRunDigest(handlers);
        world.concurrentClearance = true;
        const [item] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: ID, expectedDigest: digest }] })));
        assert.equal(item.status, "blocked");
        assert.equal(item.status === "blocked" && item.reason, "cas-conflict");
        assert.equal(world.audit.length, 0);
        assert.equal(world.obs.postedDate, "2026-08-30");
        assert.deepEqual(world.order, ["epoch", "cas"]);
    });

    await t.test("partial apply is reported honestly per item; the deadline is checked after the Purchase read, before apply", async () => {
        let clock = 0;
        // All three ids exist in the GL, so every item reaches its Purchase read and the clock advances 30s each time.
        const { world, handlers } = makeWorld({
            now: () => clock,
            readRegister: async () => register([registerRow(), registerRow({ qbTxnId: "7" }), registerRow({ qbTxnId: "8" })]),
            readPurchase: async id => { world.purchaseReads++; clock += 30_000; return id === ID ? purchase() : null; },
        });
        const digest = await dryRunDigest(handlers);
        clock = 0;
        world.applyCalls = 0;
        const res = await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: ID, expectedDigest: digest }, { qbTxnId: "7", expectedDigest: digest }, { qbTxnId: "8", expectedDigest: digest }] }));
        const items = await results(res);
        assert.equal(items[0].status, "applied");
        assert.equal(items[1].status, "blocked");
        assert.equal(items[1].status === "blocked" && items[1].reason, "purchase-unavailable");
        assert.equal(items[2].status, "not-attempted", "Purchase read pushed the clock to the deadline; apply not attempted");
        assert.equal(world.applyCalls, 2);
        assert.equal(world.audit.length, 1);
        assert.equal(world.purchaseReads, 4, "one dry-run read plus one per apply item");
    });

    await t.test("direct processItem defaults to no deadline", async () => {
        const { handlers } = makeWorld();
        const item = await handlers.processItem({ qbTxnId: ID, expectedDigest: null }, "dry-run", register());
        assert.equal(item.status, "eligible");
    });
});

test("source refresh: real Prisma applier takes locks in order, CAS on full old content, audit in the same transaction, never writes freshness", async () => {
    const calls: { kind: string; sql?: string; args?: unknown }[] = [];
    const old = oldObservation();
    const tx = {
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ kind: "exec", sql: strings.join("?"), args: values }); },
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ kind: "query", sql: strings.join("?"), args: values }); return [{ value: "1" }]; },
        $queryRawUnsafe: async (sql: string, ...values: unknown[]) => { calls.push({ kind: "unsafe", sql, args: values }); return []; },
        bankLineObservation: {
            findMany: async () => { calls.push({ kind: "obs.findMany" }); return [{ ...old, postedDate: new Date("2026-08-30T00:00:00Z"), createdAt: new Date(old.createdAt) }]; },
            updateMany: async (args: unknown) => { calls.push({ kind: "obs.updateMany", args }); return { count: 1 }; },
        },
        bankLine: { findMany: async () => [] },
        expense: { findMany: async (args: { select?: Record<string, boolean> }) => { calls.push({ kind: "expense.findMany", args }); return [{ id: "exp-2", qbPurchaseId: ID, date: new Date("2026-09-02T00:00:00Z"), amount: "123.45", qbSyncToken: "2", vendor: "Home Depot" }, { id: "exp-1", qbPurchaseId: ID, date: new Date("2026-09-02T00:00:00Z"), amount: "123.45", qbSyncToken: "2", vendor: "Home Depot" }]; } },
        receiptIntake: { findMany: async () => [] },
        auditLog: { create: async (args: unknown) => { calls.push({ kind: "audit.create", args }); } },
    };
    const client = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    const applier = createRefreshApplier(client as never);

    const result = await applier(ID, async ctx => {
        const ev = await ctx.readEvidence();
        assert.equal(ev.observations[0].postedDate, "2026-08-30");
        assert.deepEqual(ev.expenses.map(e => [e.qbPurchaseId, e.vendor, e.amount, e.date]), [[ID, "Home Depot", "123.45", "2026-09-02"], [ID, "Home Depot", "123.45", "2026-09-02"]]);
        await ctx.bumpEpoch();
        assert.equal(await ctx.updateObservation(ev.observations[0], { postedDate: "2026-09-02", rawDescriptor: "Home Depot" }), 1);
        await ctx.appendAudit(old.id, { old, new: { postedDate: "2026-09-02" } });
        return { qbTxnId: ID, status: "noop", reason: "test" };
    });
    assert.equal(result.status, "noop");

    const idx = (pred: (c: (typeof calls)[number]) => boolean) => calls.findIndex(pred);
    const evidenceLock = idx(c => c.kind === "exec" && (c.args as unknown[]).includes(RECEIPT_EVIDENCE_LOCK));
    const expenseLock = idx(c => c.kind === "unsafe");
    const identityLock = idx(c => c.kind === "exec" && (c.args as unknown[]).includes(BANK_LINE_IDENTITY_LOCK));
    const parentPeek = idx(c => c.kind === "expense.findMany");
    const expenseIdRead = calls.findIndex((c, i) => c.kind === "expense.findMany" && i > identityLock);
    const expenseLocks = calls.map((c, i) => ({ c, i })).filter(({ c }) => (c.kind === "exec" || c.kind === "query" || c.kind === "unsafe") && JSON.stringify(c.args).includes("exp-")).map(({ i }) => i);
    const firstRead = idx(c => c.kind === "obs.findMany");
    const epoch = idx(c => c.kind === "query" && (c.args as unknown[]).includes(BANK_LEDGER_EPOCH_KEY));
    const cas = idx(c => c.kind === "obs.updateMany");
    const audit = idx(c => c.kind === "audit.create");
    assert.ok(evidenceLock === 0 && evidenceLock < expenseLock && expenseLock < parentPeek && parentPeek < identityLock && identityLock < expenseIdRead, `lock order ${JSON.stringify(calls.map(c => c.kind))}`);
    assert.equal(expenseLocks.length, 2, "one advisory lock per existing Expense");
    assert.ok(expenseIdRead < expenseLocks[0] && expenseLocks[1] < firstRead, "Expense locks taken after the identity lock and before evidence is read");
    assert.ok(JSON.stringify(calls[expenseLocks[0]].args).includes("exp-1") && JSON.stringify(calls[expenseLocks[1]].args).includes("exp-2"), "Expense locks taken in sorted id order");
    assert.ok(firstRead < epoch && epoch < cas && cas < audit, "epoch bumped before the write, audit after it, all in one tx");

    const where = (calls[cas].args as { where: Record<string, unknown> }).where;
    assert.equal(where.bankLineId, null);
    assert.equal(where.rawDescriptor, old.rawDescriptor);
    assert.equal(where.clearedStatus, "Cleared");
    assert.equal(where.amountCents, -12345);
    assert.equal((where.postedDate as Date).toISOString(), "2026-08-30T00:00:00.000Z");
    const auditData = (calls[audit].args as { data: Record<string, unknown> }).data;
    assert.equal(auditData.entity, "BankLineObservation");
    assert.equal(auditData.action, SOURCE_REFRESH_AUDIT_ACTION);
    assert.equal(auditData.actorId, null);

    // The only AutomationSetting touch is the epoch bump: no freshness or success marker.
    const settingWrites = calls.filter(c => c.sql?.includes("AutomationSetting"));
    assert.equal(settingWrites.length, 1);
    assert.ok((settingWrites[0].args as unknown[]).includes(BANK_LEDGER_EPOCH_KEY));

    // A rollback signal surfaces as the item result; nothing else is swallowed.
    const rolled = await applier(ID, async () => { throw new SourceRefreshRollback({ qbTxnId: ID, status: "blocked", reason: "cas-conflict" }); });
    assert.equal(rolled.status, "blocked");
    await assert.rejects(applier(ID, async () => { throw new Error("boom"); }), /boom/);
});


test("source refresh does not mutate when locks consume the remaining deadline", async () => {
    let clock = 0;
    let writes = 0;
    const { handlers } = makeWorld({ now: () => clock, apply: async (_id, body) => {
        clock = 90_001;
        return body({ readEvidence: async () => evidence(), bumpEpoch: async () => { writes++; }, updateObservation: async () => { writes++; return 1; }, appendAudit: async () => { writes++; } });
    }});
    const dry = (await results(await handlers.POST(request({ items: [{ qbTxnId: ID }] }))))[0];
    assert.equal(dry.status, "eligible");
    const digest = dry.status === "eligible" ? dry.plan.digest : "";
    const [item] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: ID, expectedDigest: digest }] })));
    assert.equal(item.status, "not-attempted");
    assert.equal(writes, 0);
});


test("source refresh refuses a GL memo from a different Purchase version and exposes both sources", () => {
    const outcome = plan({ register: register([registerRow({ memo: "old C#8516" })]), purchaseRaw: purchase({ PrivateNote: "new C#6098" }) });
    assert.equal(outcome.status, "blocked");
    if (outcome.status === "blocked") {
        assert.equal(outcome.reason, "purchase-memo-mismatch");
        assert.equal(outcome.evidence.sourcePurchase?.PrivateNote, "new C#6098");
        assert.equal(outcome.evidence.sourceRegister?.memo, "old C#8516");
    }
});

test("source refresh preserves agreed memo and opaque Expense document number in reviewed evidence", () => {
    const outcome = plan({ register: register([registerRow({ memo: "Home Depot C#8516", docNum: "drive-file-reference" })]), purchaseRaw: purchase({ PrivateNote: "Home Depot C#8516", DocNumber: "drive-file-reference" }) });
    assert.equal(outcome.status, "eligible");
    if (outcome.status === "eligible") {
        assert.equal(outcome.plan.next.rawDescriptor, "Home Depot C#8516");
        assert.equal(outcome.plan.purchase.PrivateNote, "Home Depot C#8516");
        assert.equal(outcome.plan.purchase.DocNumber, "drive-file-reference");
    }
});


test("6456 observed date and legacy adapter transition is eligible with current matching Expense", () => {
    const outcome = plan({
        evidence: evidence({ observations: [oldObservation({ postedDate: "2026-08-05", createdAt: "2026-08-19T07:57:49.077Z", amountCents: -2195, rawDescriptor: "Uber Expense", clearedStatus: null })], expenses: [matchingExpense({ date: "2026-07-30", amount: "21.95", qbSyncToken: "1", vendor: "Uber" })] }),
        register: register([registerRow({ date: "2026-07-30", name: "Uber", memo: "Shop", amountCents: -2195, clearedStatus: "Reconciled" })], { accountId: "154" }),
        purchaseRaw: purchase({ TxnDate: "2026-07-30", TotalAmt: 21.95, SyncToken: "1", EntityRef: { name: "Uber", value: "111" }, AccountRef: { name: "Washington Trust Bank", value: "154" }, PrivateNote: "Shop", MetaData: { CreateTime: "2026-08-05T14:25:57-07:00", LastUpdatedTime: "2026-09-02T08:50:29-07:00" } }),
    });
    assert.equal(outcome.status, "eligible");
    if (outcome.status === "eligible") {
        assert.deepEqual(outcome.plan.next, { postedDate: "2026-07-30", rawDescriptor: "Shop" });
        assert.equal(outcome.plan.old.amountCents, -2195);
        assert.equal(outcome.plan.old.clearedStatus, null);
        assert.equal(outcome.plan.localEvidence.expenses[0].amount, "21.95");
    }
});


test("source refresh digest includes the exact GL row, excluding only fetch timing", () => {
    const before = plan();
    const changed = plan({ register: register([registerRow({ clearedStatus: "Reconciled" })]) });
    const laterFetch = plan({ register: register(undefined, { fetchedAt: "2026-09-10T02:00:00Z" }) });
    assert.equal(before.status, "eligible");
    assert.equal(changed.status, "eligible");
    assert.equal(laterFetch.status, "eligible");
    if (before.status === "eligible" && changed.status === "eligible" && laterFetch.status === "eligible") {
        assert.notEqual(before.plan.digest, changed.plan.digest);
        assert.equal(before.plan.digest, laterFetch.plan.digest);
    }
});

// ---------------------------------------------------------------------------
// Retired-Expense exception: literal-zero retired Expense on a Closed Complete job
// ---------------------------------------------------------------------------

const RETIRED_ID = "6597";

function retirement(overrides: Partial<ExpenseRetirementEvidence> = {}): ExpenseRetirementEvidence {
    return {
        description: RETIRED_EXPENSE_DESCRIPTION, status: "Reviewed",
        taxAmount: null, taxSource: null, installedAtCustomer: null, taxDeductibleBase: null, taxDeductibleBaseSource: null, taxAtSource: false, needsTaxReview: false,
        projectId: "proj-1", estimateId: "est-1", itemId: "item-1",
        project: { id: "proj-1", status: "Closed Complete" },
        estimate: { id: "est-1", projectId: "proj-1" },
        item: { id: "item-1", estimateId: "est-1" },
        ...overrides,
    };
}

/** Observed QXO identity/date/amount with synthetic valid retirement tax/item metadata; live metadata is not asserted by this fixture. */
function retiredExpense(overrides: Partial<ExpenseEvidence> = {}): ExpenseEvidence {
    return { id: "exp-r", qbPurchaseId: RETIRED_ID, date: "2026-08-13", amount: "0.00", qbSyncToken: "1", vendor: "QXO", retirement: retirement(), ...overrides };
}

function retiredObservation(overrides: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
    return oldObservation({ id: "obs-r", postedDate: "2026-08-13", rawDescriptor: "QXO Expense", amountCents: -8548, createdAt: "2026-08-14T04:00:00.000Z", ...overrides });
}

function retiredRegister(overrides: Partial<BankRegisterRow> = {}): BankRegisterResult {
    return register([registerRow({ qbTxnId: RETIRED_ID, date: "2026-08-13", name: "QXO", memo: "Howard/Salzer exterior - QXO ($85.48) � Invoice VD76026 [gtr-file:1QrLK_EXfr5rgKsyVQzGWbYY98hKqyw3X]", amountCents: -8548, ...overrides })]);
}

function retiredPurchase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return purchase({ Id: RETIRED_ID, TxnDate: "2026-08-13", TotalAmt: 85.48, SyncToken: "1", EntityRef: { name: "QXO", value: "77" }, PrivateNote: "Howard/Salzer exterior - QXO ($85.48) � Invoice VD76026 [gtr-file:1QrLK_EXfr5rgKsyVQzGWbYY98hKqyw3X]", MetaData: { CreateTime: "2026-08-13T10:00:00-07:00", LastUpdatedTime: "2026-09-05T08:00:00-07:00" }, ...overrides });
}

function retiredEvidence(expenseOverrides: Partial<ExpenseEvidence> = {}, observationOverrides: Partial<ObservationSnapshot> = {}): RefreshEvidence {
    return evidence({ observations: [retiredObservation(observationOverrides)], expenses: [retiredExpense(expenseOverrides)] });
}

function retiredPlan(overrides: { qbTxnId?: string; evidence?: RefreshEvidence; register?: BankRegisterResult; purchaseRaw?: unknown } = {}) {
    return planSourceRefresh({
        qbTxnId: overrides.qbTxnId ?? RETIRED_ID,
        evidence: overrides.evidence ?? retiredEvidence(),
        register: overrides.register ?? retiredRegister(),
        purchaseRaw: "purchaseRaw" in overrides ? overrides.purchaseRaw : retiredPurchase(),
    });
}

test("retired Expense: 6597 and 6547 zero retired QXO Expenses allow a descriptor-only refresh to the current memo", () => {
    const first = retiredPlan();
    assert.equal(first.status, "eligible");
    if (first.status === "eligible") {
        assert.equal(first.plan.basis, SOURCE_REFRESH_BASIS);
        assert.deepEqual(first.plan.warnings, [HISTORY_MISSING_WARNING, RETIRED_EXPENSE_WARNING]);
        assert.deepEqual(first.plan.next, { postedDate: "2026-08-13", rawDescriptor: "Howard/Salzer exterior - QXO ($85.48) � Invoice VD76026 [gtr-file:1QrLK_EXfr5rgKsyVQzGWbYY98hKqyw3X]" });
        assert.equal(first.plan.old.postedDate, "2026-08-13", "descriptor-only: the date does not move");
        assert.deepEqual(first.plan.localEvidence.expenses, [retiredExpense()], "retirement, project, estimate and item facts are in the reviewed evidence");
        assert.deepEqual(first.evidence.expenses[0].retirement, retirement());
        assert.equal(first.plan.purchase.SyncToken, "1");
    }

    const second = retiredPlan({
        qbTxnId: "6547",
        evidence: evidence({
            observations: [retiredObservation({ id: "obs-s", postedDate: "2026-08-12", amountCents: -133029, createdAt: "2026-08-13T04:00:00.000Z" })],
            expenses: [retiredExpense({ id: "exp-s", qbPurchaseId: "6547", date: "2026-08-12" })],
        }),
        register: register([registerRow({ qbTxnId: "6547", date: "2026-08-12", name: "QXO", memo: "Howard/Salzer exterior - QXO ($1330.29) � Invoice 2411269 [gtr-file:1tTzgTonAOapWdYVPoDQIXkbBrAk1GA0y]", amountCents: -133029 })]),
        purchaseRaw: retiredPurchase({ Id: "6547", TxnDate: "2026-08-12", TotalAmt: 1330.29, PrivateNote: "Howard/Salzer exterior - QXO ($1330.29) � Invoice 2411269 [gtr-file:1tTzgTonAOapWdYVPoDQIXkbBrAk1GA0y]", MetaData: { CreateTime: "2026-08-12T10:00:00-07:00", LastUpdatedTime: "2026-09-05T08:00:00-07:00" } }),
    });
    assert.equal(second.status, "eligible");
    if (second.status === "eligible") {
        assert.deepEqual(second.plan.next, { postedDate: "2026-08-12", rawDescriptor: "Howard/Salzer exterior - QXO ($1330.29) � Invoice 2411269 [gtr-file:1tTzgTonAOapWdYVPoDQIXkbBrAk1GA0y]" });
        assert.deepEqual(second.plan.warnings, [HISTORY_MISSING_WARNING, RETIRED_EXPENSE_WARNING]);
        assert.equal(second.plan.localEvidence.expenses[0].amount, "0.00");
    }

    const literalZero = retiredPlan({ evidence: retiredEvidence({ amount: "0" }) });
    assert.equal(literalZero.status, "eligible", "\"0\" is the literal zero too");

    const projectOnly = retiredPlan({ evidence: retiredEvidence({ retirement: retirement({ estimateId: null, itemId: null, estimate: null, item: null }) }) });
    assert.equal(projectOnly.status, "eligible", "no estimate/item named is fine when the project is Closed Complete");

    const positiveWithMetadata = retiredPlan({ evidence: retiredEvidence({ amount: "85.48" }) });
    assert.equal(positiveWithMetadata.status, "eligible");
    assert.deepEqual(positiveWithMetadata.status === "eligible" && positiveWithMetadata.plan.warnings, [HISTORY_MISSING_WARNING], "a positive Expense is never flagged retired");

    const positiveWithoutMetadata = retiredPlan({ evidence: retiredEvidence({ amount: "85.48", retirement: undefined }) });
    assert.equal(positiveWithoutMetadata.status, "eligible", "old fixtures without retirement metadata still work for positive Expenses");

    const unchanged = retiredPlan({ evidence: retiredEvidence({}, { rawDescriptor: "Howard/Salzer exterior - QXO ($85.48) � Invoice VD76026 [gtr-file:1QrLK_EXfr5rgKsyVQzGWbYY98hKqyw3X]" }) });
    assert.equal(unchanged.status, "noop");
});

test("retired Expense: every retirement, attribution, token and date rule is required", async t => {
    const withRetirement = (overrides: Partial<ExpenseRetirementEvidence>): RefreshEvidence => retiredEvidence({ retirement: retirement(overrides) });
    const cases: [string, Parameters<typeof retiredPlan>[0], string][] = [
        ["metadata missing", { evidence: retiredEvidence({ retirement: undefined }) }, "expense-retirement-metadata-missing"],
        ["marker reason differs", { evidence: withRetirement({ description: "[QuickBooks import] Removed in QBO (deleted)" }) }, "expense-retirement-marker-mismatch"],
        ["marker case differs", { evidence: withRetirement({ description: "[quickbooks import] removed in qbo (no-active-project)" }) }, "expense-retirement-marker-mismatch"],
        ["marker null", { evidence: withRetirement({ description: null }) }, "expense-retirement-marker-mismatch"],
        ["status not Reviewed", { evidence: withRetirement({ status: "Pending" }) }, "expense-retirement-status-mismatch"],
        ["tax amount retained", { evidence: withRetirement({ taxAmount: "5.00" }) }, "expense-retirement-tax-not-retired"],
        ["tax source retained", { evidence: withRetirement({ taxSource: "manual" }) }, "expense-retirement-tax-not-retired"],
        ["installedAtCustomer retained", { evidence: withRetirement({ installedAtCustomer: false }) }, "expense-retirement-tax-not-retired"],
        ["deductible base retained", { evidence: withRetirement({ taxDeductibleBase: "0.00" }) }, "expense-retirement-tax-not-retired"],
        ["deductible base source retained", { evidence: withRetirement({ taxDeductibleBaseSource: "manual" }) }, "expense-retirement-tax-not-retired"],
        ["taxAtSource true", { evidence: withRetirement({ taxAtSource: true }) }, "expense-retirement-tax-not-retired"],
        ["needsTaxReview true", { evidence: withRetirement({ needsTaxReview: true }) }, "expense-retirement-tax-not-retired"],
        ["project In Progress", { evidence: withRetirement({ project: { id: "proj-1", status: "In Progress" } }) }, "expense-retirement-project-active"],
        ["project merely Closed", { evidence: withRetirement({ project: { id: "proj-1", status: "Closed" } }) }, "expense-retirement-project-active"],
        ["project status case differs", { evidence: withRetirement({ project: { id: "proj-1", status: "closed complete" } }) }, "expense-retirement-project-active"],
        ["project status null", { evidence: withRetirement({ project: { id: "proj-1", status: null } }) }, "expense-retirement-project-active"],
        ["no explicit projectId", { evidence: withRetirement({ projectId: null }) }, "expense-retirement-project-missing"],
        ["project row missing", { evidence: withRetirement({ project: null }) }, "expense-retirement-project-missing"],
        ["project row is another job", { evidence: withRetirement({ project: { id: "proj-2", status: "Closed Complete" } }) }, "expense-retirement-project-missing"],
        ["estimate row missing", { evidence: withRetirement({ estimate: null }) }, "expense-retirement-estimate-missing"],
        ["estimate row is another estimate", { evidence: withRetirement({ estimate: { id: "est-2", projectId: "proj-1" } }) }, "expense-retirement-estimate-missing"],
        ["estimate on another project", { evidence: withRetirement({ estimate: { id: "est-1", projectId: "proj-2" } }) }, "expense-retirement-estimate-project-mismatch"],
        ["estimate present without estimateId", { evidence: withRetirement({ estimateId: null, itemId: null, item: null }) }, "expense-retirement-estimate-inconsistent"],
        ["item row missing", { evidence: withRetirement({ item: null }) }, "expense-retirement-item-missing"],
        ["item row is another item", { evidence: withRetirement({ item: { id: "item-2", estimateId: "est-1" } }) }, "expense-retirement-item-missing"],
        ["item on another estimate", { evidence: withRetirement({ item: { id: "item-1", estimateId: "est-2" } }) }, "expense-retirement-item-estimate-mismatch"],
        ["item present without itemId", { evidence: withRetirement({ itemId: null }) }, "expense-retirement-item-inconsistent"],
        ["stale sync token", { evidence: retiredEvidence({ qbSyncToken: "0" }) }, "expense-sync-token-stale"],
        ["missing sync token", { evidence: retiredEvidence({ qbSyncToken: null }) }, "expense-sync-token-missing"],
        ["expense vendor differs", { evidence: retiredEvidence({ vendor: "Lowes" }) }, "expense-vendor-mismatch"],
        ["expense date differs from Purchase", { evidence: retiredEvidence({ date: "2026-08-12" }) }, "expense-date-mismatch"],
        ["stored date differs from Purchase TxnDate (descriptor-only exception)", { evidence: retiredEvidence({}, { postedDate: "2026-08-12" }) }, "retired-expense-date-change"],
        ["sub-cent zero is not literal zero", { evidence: retiredEvidence({ amount: "0.000" }) }, "expense-amount-malformed"],
        ["double zero is not literal zero", { evidence: retiredEvidence({ amount: "00" }) }, "expense-amount-malformed"],
        ["small positive is a mismatch, not retired", { evidence: retiredEvidence({ amount: "0.50" }) }, "expense-amount-mismatch"],
        ["stored cents changed", { evidence: retiredEvidence({}, { amountCents: -8549 }) }, "amount-changed"],
        ["canonical line still blocks", { evidence: evidence({ observations: [retiredObservation()], expenses: [retiredExpense()], bankLines: [{ id: "bl-9", account: "WTB-0723", postedDate: "2026-08-13", amountCents: -8548, state: "CANONICAL", sourceOfRecord: "QBO", probuildExpenseId: null }] }) }, "canonical-line-exists"],
        ["receipt intake still blocks", { evidence: evidence({ observations: [retiredObservation()], expenses: [retiredExpense()], intakes: [{ id: "ri-1", state: "BOOKED", expenseId: null }] }) }, "receipt-intake-linked"],
    ];
    for (const [name, input, reason] of cases) {
        await t.test(name, () => {
            const outcome = retiredPlan(input);
            assert.equal(outcome.status, "blocked", name);
            assert.equal(outcome.status === "blocked" && outcome.reason, reason);
            if (outcome.status === "blocked" && input?.evidence) {
                const { sourcePurchase: _purchase, sourceRegister: _register, ...local } = outcome.evidence;
                assert.deepEqual(local, JSON.parse(JSON.stringify(input.evidence)), "retirement evidence is retained verbatim (absent optional fields omitted)");
            }
        });
    }
});

test("retired Expense: digest covers retirement, project, estimate and item evidence", () => {
    const base = retiredPlan();
    const otherItem = retiredPlan({ evidence: retiredEvidence({ retirement: retirement({ itemId: "item-2", item: { id: "item-2", estimateId: "est-1" } }) }) });
    const otherEstimate = retiredPlan({ evidence: retiredEvidence({ retirement: retirement({ estimateId: "est-2", estimate: { id: "est-2", projectId: "proj-1" }, item: { id: "item-1", estimateId: "est-2" } }) }) });
    const otherProject = retiredPlan({ evidence: retiredEvidence({ retirement: retirement({ projectId: "proj-2", project: { id: "proj-2", status: "Closed Complete" }, estimate: { id: "est-1", projectId: "proj-2" } }) }) });
    const digests = [base, otherItem, otherEstimate, otherProject].map(outcome => {
        assert.equal(outcome.status, "eligible");
        return outcome.status === "eligible" ? outcome.plan.digest : "";
    });
    assert.equal(new Set(digests).size, 4, "each attribution change yields a different digest");
    const positive = retiredPlan({ evidence: retiredEvidence({ amount: "85.48" }) });
    assert.equal(positive.status, "eligible");
    assert.notEqual(positive.status === "eligible" && positive.plan.digest, digests[0]);
});

test("retired Expense: apply rereads retirement metadata under the locks and refuses a reopened project or moved attribution", async () => {
    const world = { obs: retiredObservation(), expense: retiredExpense(), audit: [] as Record<string, unknown>[], order: [] as string[] };
    const current = (): RefreshEvidence => evidence({ observations: [{ ...world.obs }], expenses: [JSON.parse(JSON.stringify(world.expense)) as ExpenseEvidence] });
    const handlers = createBankSourceRefreshHandlers({
        authorize: () => true,
        readRegister: async () => retiredRegister(),
        readPurchase: async () => retiredPurchase(),
        readEvidence: async () => current(),
        apply: async (_id, body) => body({
            readEvidence: async () => current(),
            bumpEpoch: async () => { world.order.push("epoch"); },
            updateObservation: async (_old, next) => { world.order.push("cas"); world.obs = { ...world.obs, ...next }; return 1; },
            appendAudit: async (_entityId, snapshot) => { world.order.push("audit"); world.audit.push(snapshot); },
        }),
    });
    const [dry] = await results(await handlers.POST(request({ items: [{ qbTxnId: RETIRED_ID }] })));
    assert.equal(dry.status, "eligible");
    if (dry.status !== "eligible") return;
    assert.deepEqual(dry.plan.warnings, [HISTORY_MISSING_WARNING, RETIRED_EXPENSE_WARNING]);
    const digest = dry.plan.digest;

    // The job was reopened between the dry-run and the apply: rejected on the reread, nothing written.
    world.expense = retiredExpense({ retirement: retirement({ project: { id: "proj-1", status: "In Progress" } }) });
    const [reopened] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: RETIRED_ID, expectedDigest: digest }] })));
    assert.equal(reopened.status, "blocked");
    assert.equal(reopened.status === "blocked" && reopened.reason, "expense-retirement-project-active");
    assert.deepEqual(world.order, []);
    assert.equal(world.audit.length, 0);

    // Attribution moved consistently to another estimate: still a different digest, so the reviewed version no longer applies.
    world.expense = retiredExpense({ retirement: retirement({ estimateId: "est-2", estimate: { id: "est-2", projectId: "proj-1" }, item: { id: "item-1", estimateId: "est-2" } }) });
    const [moved] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: RETIRED_ID, expectedDigest: digest }] })));
    assert.equal(moved.status, "blocked");
    assert.equal(moved.status === "blocked" && moved.reason, "digest-mismatch");
    assert.deepEqual(world.order, []);

    // Retirement metadata missing at apply time (a narrower reader) always rejects the zero Expense.
    world.expense = retiredExpense({ retirement: undefined });
    const [missing] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: RETIRED_ID, expectedDigest: digest }] })));
    assert.equal(missing.status === "blocked" && missing.reason, "expense-retirement-metadata-missing");

    world.expense = retiredExpense();
    const [applied] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: RETIRED_ID, expectedDigest: digest }] })));
    assert.equal(applied.status, "applied");
    assert.deepEqual(world.order, ["epoch", "cas", "audit"]);
    assert.equal(world.obs.postedDate, "2026-08-13", "date untouched");
    assert.equal(world.obs.rawDescriptor, "Howard/Salzer exterior - QXO ($85.48) � Invoice VD76026 [gtr-file:1QrLK_EXfr5rgKsyVQzGWbYY98hKqyw3X]");
    assert.equal(world.obs.amountCents, -8548);
    assert.deepEqual(world.expense, retiredExpense(), "Expense never mutated");
    const snapshot = world.audit[0] as Record<string, unknown>;
    assert.deepEqual(snapshot.warnings, [HISTORY_MISSING_WARNING, RETIRED_EXPENSE_WARNING]);
    assert.deepEqual((snapshot.localEvidence as RefreshEvidence).expenses[0].retirement, retirement(), "audit carries every retirement and attribution fact");
    assert.equal(snapshot.digest, digest);

    const [retry] = await results(await handlers.POST(request({ mode: "apply", items: [{ qbTxnId: RETIRED_ID, expectedDigest: digest }] })));
    assert.equal(retry.status, "noop");
    assert.equal(world.audit.length, 1);
});

test("retired Expense: Prisma applier share-locks Project, Estimate and EstimateItem after the Purchase lock and before the identity lock, and refuses a parent race", async () => {
    type Call = { kind: string; sql?: string; args?: unknown };
    async function run(raceOnReread: boolean) {
        const calls: Call[] = [];
        let expenseReads = 0;
        let bodyCalls = 0;
        const old = retiredObservation();
        const tx = {
            $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ kind: "exec", sql: strings.join("?"), args: values }); },
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ kind: "query", sql: strings.join("?"), args: values }); return [{ value: "1" }]; },
            $queryRawUnsafe: async (sql: string, ...values: unknown[]) => { calls.push({ kind: "unsafe", sql, args: values }); return []; },
            bankLineObservation: {
                findMany: async () => { calls.push({ kind: "obs.findMany" }); return [{ ...old, postedDate: new Date("2026-08-13T00:00:00Z"), createdAt: new Date(old.createdAt) }]; },
                updateMany: async (args: unknown) => { calls.push({ kind: "obs.updateMany", args }); return { count: 1 }; },
            },
            bankLine: { findMany: async () => [] },
            expense: {
                findMany: async (args: { select?: Record<string, unknown> }) => {
                    calls.push({ kind: "expense.findMany", args });
                    expenseReads++;
                    // Reads: 1 = parent peek, 2 = Expense id read, 3 = post-lock identity reread, 4 = evidence.
                    const projectId = raceOnReread && expenseReads === 3 ? "proj-2" : "proj-1";
                    return [{
                        id: "exp-r", qbPurchaseId: RETIRED_ID, date: new Date("2026-08-13T00:00:00Z"), amount: "0.00", qbSyncToken: "1", vendor: "QXO",
                        description: RETIRED_EXPENSE_DESCRIPTION, status: "Reviewed",
                        taxAmount: null, taxSource: null, installedAtCustomer: null, taxDeductibleBase: null, taxDeductibleBaseSource: null, taxAtSource: false, needsTaxReview: false,
                        projectId, estimateId: "est-1", itemId: "item-1",
                        project: { id: projectId, status: "Closed Complete" }, estimate: { id: "est-1", projectId: "proj-9" }, item: { id: "item-1", estimateId: "est-1" },
                    }];
                },
            },
            receiptIntake: { findMany: async () => [] },
            auditLog: { create: async (args: unknown) => { calls.push({ kind: "audit.create", args }); } },
        };
        const applier = createRefreshApplier({ $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as never);
        const result = await applier(RETIRED_ID, async ctx => {
            bodyCalls++;
            const ev = await ctx.readEvidence();
            assert.equal(ev.expenses[0].amount, "0.00");
            assert.equal(ev.expenses[0].retirement?.description, RETIRED_EXPENSE_DESCRIPTION);
            assert.equal(ev.expenses[0].retirement?.taxAtSource, false);
            assert.deepEqual(ev.expenses[0].retirement?.project, { id: "proj-1", status: "Closed Complete" });
            assert.deepEqual(ev.expenses[0].retirement?.estimate, { id: "est-1", projectId: "proj-9" });
            assert.deepEqual(ev.expenses[0].retirement?.item, { id: "item-1", estimateId: "est-1" });
            return { qbTxnId: RETIRED_ID, status: "noop", reason: "test" };
        });
        return { calls, result, bodyCalls };
    }

    const ok = await run(false);
    assert.equal(ok.result.status, "noop");
    assert.equal(ok.bodyCalls, 1);
    const idx = (pred: (c: Call) => boolean) => ok.calls.findIndex(pred);
    const purchaseLock = idx(c => c.kind === "unsafe");
    const projectLock = idx(c => c.kind === "unsafe" && (c.sql ?? "").includes('FROM "Project"'));
    const estimateLock = idx(c => c.kind === "unsafe" && (c.sql ?? "").includes('FROM "Estimate"'));
    const itemLock = idx(c => c.kind === "unsafe" && (c.sql ?? "").includes('"EstimateItem"'));
    const identityLock = idx(c => c.kind === "exec" && (c.args as unknown[]).includes(BANK_LINE_IDENTITY_LOCK));
    const expenseLocks = ok.calls.map((c, i) => ({ c, i })).filter(({ c }) => (c.kind === "exec" || c.kind === "query" || c.kind === "unsafe") && JSON.stringify(c.args).includes("exp-")).map(({ i }) => i);
    const reads = ok.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.kind === "expense.findMany").map(({ i }) => i);
    const firstRead = idx(c => c.kind === "obs.findMany");
    const kinds = JSON.stringify(ok.calls.map(c => c.kind));
    assert.ok(purchaseLock >= 0 && purchaseLock < reads[0] && reads[0] < projectLock && projectLock < estimateLock && estimateLock < itemLock && itemLock < identityLock, `lock order ${kinds}`);
    assert.deepEqual(ok.calls[projectLock].args, [["proj-1", "proj-9"]], "explicit and estimate project ids, sorted, in one statement");
    assert.deepEqual(ok.calls[estimateLock].args, [["proj-1", "proj-9"], ["est-1"]]);
    assert.deepEqual(ok.calls[itemLock].args, [["proj-1", "proj-9"], ["item-1"]]);
    assert.equal(expenseLocks.length, 1, "one advisory lock for the single Expense");
    assert.equal(reads.length, 4, `peek, id read, reread, evidence: ${kinds}`);
    assert.ok(identityLock < reads[1] && reads[1] < expenseLocks[0] && expenseLocks[0] < reads[2] && reads[2] < firstRead, `identity tuple reread after the Expense lock and before evidence: ${kinds}`);

    const raced = await run(true);
    assert.equal(raced.result.status, "blocked");
    assert.equal(raced.result.status === "blocked" && raced.result.reason, RETIREMENT_RACE_REASON);
    assert.equal(raced.bodyCalls, 0, "the body never runs against an unlocked new parent");
    assert.equal(raced.calls.filter(c => c.kind === "obs.findMany" || c.kind === "obs.updateMany" || c.kind === "audit.create").length, 0, "no evidence read and no writes");
    assert.ok(raced.calls.some(c => c.kind === "unsafe" && (c.sql ?? "").includes('FROM "Project"') && JSON.stringify(c.args) === JSON.stringify([["proj-1", "proj-9"]])), "locks were taken from the peek, not the raced reread");
});
