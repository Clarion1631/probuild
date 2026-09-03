/**
 * Deposit sweep — the daily bank-credit auto-apply
 * (docs/plans/DEPOSIT-SWEEP-PLAN.md, acceptance list "Unit tests").
 *
 * Two layers:
 *
 *  1. PURE RULES (src/lib/deposit-sweep.ts): the batch/control-total gate, the
 *     in-batch collision rule, the 2-day wait, the image-cardinality rule and
 *     the human-facing messages. No database.
 *
 *  2. THE ROUTE ITSELF (src/app/api/payments/deposit-ingest/route.ts) against a
 *     fake Prisma, because the rules that actually decide whether real money
 *     moves live in its queries: the REQUESTED-only candidate filter
 *     (qbInvoiceSentAt), the 14-day Paid union, the cross-source claim check
 *     inside the reservation transaction, and the qbInvoiceId gate. Asserting
 *     those against fixtures — rather than against a hand-copied predicate —
 *     is the whole point; a JS twin of a SQL filter is exactly the thing this
 *     repo has been bitten by before.
 *
 * Prisma (and the three money-write modules) are faked with the scoped CJS
 * require() patch used across this repo — `mock.module()` is unusable here
 * (CI pins Node 20). The fake evaluates the `where` shapes this route actually
 * uses, and enforces BOTH DepositIngest uniqueness rules (fileId, and the
 * partial reservation index) so the P2002 branches are real.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import {
    BANK_APPLY_MIN_AGE_DAYS,
    BANK_DEPOSIT_SOURCE,
    BANK_DEPOSIT_TO_ACCOUNT_ID,
    appliedTwinNote,
    bankCreditIsOldEnough,
    bankFileId,
    bankImageKeyPrefix,
    crossSourceClaimNote,
    findBatchCollisions,
    parseBankBatch,
    reservationLostNote,
    selectPayerBearingImage,
} from "../src/lib/deposit-sweep";

// ── Fake Prisma ──────────────────────────────────────────────────────────────

type Row = Record<string, any>;

const isPlainObject = (v: unknown): v is Row =>
    typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** An absent key on a fixture row IS a SQL NULL — a real Prisma row always
 *  carries every nullable column, so `undefined` and `null` must compare equal
 *  or `{ officeTaskId: null }` would match nothing. */
const nullish = (v: unknown) => v === null || v === undefined;

const same = (a: unknown, b: unknown): boolean => {
    if (nullish(a) || nullish(b)) return nullish(a) && nullish(b);
    if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() === new Date(b as Date).getTime();
    return a === b;
};

/** Evaluates the `where` shapes this route uses: scalar equality (null
 *  included, which is how `source: null` means IS NULL), the not/in/notIn/
 *  gte/lte/startsWith operators, and nested relation objects. */
function matchWhere(row: Row | null | undefined, where: Row): boolean {
    if (!row) return false;
    for (const [key, cond] of Object.entries(where)) {
        const value = row[key];
        if (cond === undefined) continue;
        if (isPlainObject(cond)) {
            const ops = Object.keys(cond);
            const isOperator = ops.some(o => ["not", "in", "notIn", "gte", "lte", "lt", "gt", "startsWith", "contains", "equals"].includes(o));
            if (!isOperator) {
                if (!matchWhere(value, cond)) return false;
                continue;
            }
            for (const [op, operand] of Object.entries(cond)) {
                switch (op) {
                    case "equals": if (!same(value, operand)) return false; break;
                    case "not": if (same(value, operand)) return false; break;
                    case "in": if (!(operand as unknown[]).some(o => same(value, o))) return false; break;
                    case "notIn": if ((operand as unknown[]).some(o => same(value, o))) return false; break;
                    case "gte": if (!(value != null && new Date(value).getTime() >= new Date(operand as Date).getTime())) return false; break;
                    case "lte": if (!(value != null && new Date(value).getTime() <= new Date(operand as Date).getTime())) return false; break;
                    case "lt": if (!(value != null && new Date(value).getTime() < new Date(operand as Date).getTime())) return false; break;
                    case "gt": if (!(value != null && new Date(value).getTime() > new Date(operand as Date).getTime())) return false; break;
                    case "startsWith": if (typeof value !== "string" || !value.startsWith(operand as string)) return false; break;
                    case "contains": if (typeof value !== "string" || !value.includes(operand as string)) return false; break;
                    default: throw new Error(`fake prisma: unsupported operator ${op}`);
                }
            }
            continue;
        }
        if (!same(value, cond)) return false;
    }
    return true;
}

function applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
        if (isPlainObject(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else row[key] = value;
    }
    row.updatedAt = new Date();
}

class P2002 extends Error {
    code = "P2002";
    constructor(target: string) {
        super(`Unique constraint failed on ${target}`);
    }
}

/** The two DepositIngest uniqueness rules, both enforced so the route's P2002
 *  branches are exercised for real: fileId, and the partial reservation index
 *  (scripts/apply-deposit-ingest-schema.mjs) whose predicate deliberately
 *  EXCLUDES `unmatched` and `proposed`. */
const RESERVATION_STATUSES = ["processing", "qbo_unknown", "qbo_created", "applied", "reconcile", "failed"];

class Table {
    rows: Row[] = [];
    constructor(private name: string) {}

    private guard(candidate: Row): void {
        if (this.name !== "depositIngest") return;
        if (this.rows.some(r => r.id !== candidate.id && r.fileId === candidate.fileId)) throw new P2002("DepositIngest.fileId");
        if (
            candidate.paymentScheduleId &&
            RESERVATION_STATUSES.includes(candidate.status) &&
            this.rows.some(r => r.id !== candidate.id && r.paymentScheduleId === candidate.paymentScheduleId && RESERVATION_STATUSES.includes(r.status))
        ) {
            throw new P2002("DepositIngest.paymentScheduleId (reservation)");
        }
    }

    async findUnique({ where }: { where: Row }) { return this.rows.find(r => matchWhere(r, where)) ?? null; }
    async findFirst({ where }: { where?: Row } = {}) { return this.rows.find(r => matchWhere(r, where ?? {})) ?? null; }
    async findMany({ where, take }: { where?: Row; take?: number } = {}) {
        const hits = this.rows.filter(r => matchWhere(r, where ?? {}));
        return take ? hits.slice(0, take) : hits;
    }
    async create({ data }: { data: Row }) {
        const row: Row = { id: `${this.name}-${this.rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        this.guard(row);
        this.rows.push(row);
        return { ...row };
    }
    async update({ where, data }: { where: Row; data: Row }) {
        const row = this.rows.find(r => matchWhere(r, where));
        if (!row) throw new Error(`fake prisma: ${this.name}.update matched nothing`);
        const next = { ...row };
        applyData(next, data);
        this.guard(next);
        Object.assign(row, next);
        return { ...row };
    }
    async updateMany({ where, data }: { where: Row; data: Row }) {
        const hits = this.rows.filter(r => matchWhere(r, where));
        for (const row of hits) {
            const next = { ...row };
            applyData(next, data);
            this.guard(next);
            Object.assign(row, next);
        }
        return { count: hits.length };
    }
    async delete({ where }: { where: Row }) {
        const i = this.rows.findIndex(r => matchWhere(r, where));
        if (i >= 0) this.rows.splice(i, 1);
        return {};
    }
}

const tables = {
    depositIngest: new Table("depositIngest"),
    paymentSchedule: new Table("paymentSchedule"),
    bankImage: new Table("bankImage"),
    officeTask: new Table("officeTask"),
    officeBoardColumn: new Table("officeBoardColumn"),
    project: new Table("project"),
};

const queries: { paymentSchedule: Row[]; bankImage: Row[] } = { paymentSchedule: [], bankImage: [] };

const fakePrisma: Row = {
    depositIngest: tables.depositIngest,
    bankImage: {
        findMany: async (args: Row) => {
            queries.bankImage.push(args);
            return tables.bankImage.findMany(args);
        },
    },
    paymentSchedule: {
        findMany: async (args: Row) => {
            queries.paymentSchedule.push(args);
            return tables.paymentSchedule.findMany(args);
        },
        findUnique: (args: Row) => tables.paymentSchedule.findUnique(args),
    },
    officeTask: tables.officeTask,
    officeBoardColumn: tables.officeBoardColumn,
    project: tables.project,
    $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(fakePrisma),
};

// ── Fake money-write modules ─────────────────────────────────────────────────

const calls = {
    buildQBPaymentRequest: [] as Row[],
    sendQBPaymentCreateRequest: [] as Row[],
    settleMilestoneFromQBPayment: [] as Row[],
    recordPaymentCore: [] as Row[],
};

let qboBalanceByInvoice = new Map<string, number>();

const fakeQuickbooks = {
    buildQBPaymentRequest: async (_tokens: unknown, qbInvoiceId: string, opts: Row) => {
        calls.buildQBPaymentRequest.push({ qbInvoiceId, ...opts });
        const balance = qboBalanceByInvoice.get(qbInvoiceId);
        if (balance != null && Math.round(balance * 100) !== Math.round(opts.amount * 100)) {
            return { ok: false, reason: "balance-mismatch", qbBalance: balance, expected: opts.amount };
        }
        return { ok: true, requestBody: JSON.stringify({ TotalAmt: opts.amount, ...opts }) };
    },
    sendQBPaymentCreateRequest: async (_tokens: unknown, requestBody: string, requestId: string) => {
        calls.sendQBPaymentCreateRequest.push({ requestBody, requestId });
        return { paymentId: `qb-payment-${calls.sendQBPaymentCreateRequest.length}`, amount: 0 };
    },
};

const fakeQuickbooksPayments = {
    getFreshQBTokens: async () => ({ accessToken: "t", refreshToken: "r", realmId: "realm" }),
    settleMilestoneFromQBPayment: async (input: Row) => {
        calls.settleMilestoneFromQBPayment.push(input);
        const schedule = tables.paymentSchedule.rows.find(r => r.id === input.paymentScheduleId);
        if (schedule) {
            schedule.status = "Paid";
            schedule.qbPaymentId = input.qbPaymentId;
            schedule.paymentDate = input.paidAt;
            schedule.referenceNumber = input.referenceNumber;
        }
        return true;
    },
};

const fakePaymentRecordCore = {
    recordPaymentCore: async (paymentId: string, invoiceId: string, input: Row) => {
        calls.recordPaymentCore.push({ paymentId, invoiceId, ...input });
        const schedule = tables.paymentSchedule.rows.find(r => r.id === paymentId);
        if (schedule) schedule.status = "Paid";
        return { success: true, projectId: "project-1" };
    },
};

// ── Load the route under the patch ───────────────────────────────────────────

let POST: (req: Request) => Promise<Response>;
const SECRET = "deposit-sweep-test-secret";

before(async () => {
    const originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") { patched.add(id); return { prisma: fakePrisma }; }
        if (id === "@/lib/quickbooks") { patched.add(id); return fakeQuickbooks; }
        if (id === "@/lib/quickbooks-payments") { patched.add(id); return fakeQuickbooksPayments; }
        if (id === "@/lib/payment-record-core") { patched.add(id); return fakePaymentRecordCore; }
        if (id === "next/cache") { patched.add(id); return { revalidatePath: () => {} }; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: Row;
    try {
        mod = await import("../src/app/api/payments/deposit-ingest/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["@/lib/prisma", "@/lib/quickbooks", "@/lib/quickbooks-payments", "@/lib/payment-record-core", "next/cache"]) {
        if (!patched.has(id)) throw new Error(`deposit-sweep.test.ts: the mock of "${id}" never applied — the route would hit the real module`);
    }
    POST = mod.POST;
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TODAY = new Date();
const isoDaysAgo = (days: number) => new Date(TODAY.getTime() - days * 86_400_000).toISOString().slice(0, 10);
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Old enough to clear the 2-day wait rule in every test that wants a real apply. */
const SETTLED_DAY = isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 1);

let scheduleSeq = 0;

function seedMilestone(opts: {
    amount: number;
    status?: string;
    requested?: boolean;
    qbInvoiceId?: string | null;
    projectName?: string;
    clientName?: string;
    invoiceCode?: string;
    invoiceStatus?: string;
    name?: string;
    paymentDate?: Date | null;
}) {
    scheduleSeq += 1;
    const id = `sched-${scheduleSeq}`;
    tables.paymentSchedule.rows.push({
        id,
        name: opts.name ?? `Milestone ${scheduleSeq}`,
        status: opts.status ?? "Pending",
        amount: opts.amount,
        invoiceId: `inv-${scheduleSeq}`,
        qbInvoiceId: opts.qbInvoiceId === undefined ? `qb-inv-${scheduleSeq}` : opts.qbInvoiceId,
        qbInvoiceSentAt: opts.requested === false ? null : new Date(),
        paymentDate: opts.paymentDate ?? null,
        invoice: {
            id: `inv-${scheduleSeq}`,
            projectId: "project-1",
            code: opts.invoiceCode ?? `INV-${scheduleSeq}`,
            status: opts.invoiceStatus ?? "Issued",
            project: { id: "project-1", name: opts.projectName ?? "Hoppe Hall Bath" },
            client: { name: opts.clientName ?? "Hoppe" },
        },
    });
    return id;
}

function bankBatch(credits: Array<{ ref: string; amount: number; detail?: string }>, overrides: Row = {}) {
    return {
        source: "bank",
        postDate: SETTLED_DAY,
        credits: credits.map(c => ({
            bankReference: c.ref,
            amount: c.amount,
            transactionDetail: c.detail ?? "DEPOSIT - DDA/MMKT",
            customerReference: null,
        })),
        creditCount: credits.length,
        creditSum: credits.reduce((sum, c) => sum + Math.round(c.amount * 100), 0) / 100,
        ...overrides,
    };
}

async function post(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth !== null) headers.authorization = auth;
    const res = await POST(new Request("http://localhost/api/payments/deposit-ingest", {
        method: "POST", headers, body: JSON.stringify(body),
    }));
    return { res, body: await res.json().catch(() => null) as Row };
}

const creditResult = (body: Row, ref: string): Row => body.credits.find((c: Row) => c.bankReference === ref);
const depositRow = (ref: string) => tables.depositIngest.rows.find(r => r.fileId === bankFileId(ref));
const taskNotes = () => tables.officeTask.rows.map(t => String(t.notes));

beforeEach(() => {
    for (const table of Object.values(tables)) table.rows = [];
    queries.paymentSchedule = [];
    queries.bankImage = [];
    for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = [];
    qboBalanceByInvoice = new Map();
    scheduleSeq = 0;
    tables.officeBoardColumn.rows.push({ id: "col-1", name: "To Do", position: 0, createdAt: new Date() });
    process.env.DEPOSIT_INGEST_SECRET = SECRET;
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Pure rules
// ═════════════════════════════════════════════════════════════════════════════

test("batch gate: a control-total mismatch refuses the WHOLE batch", async t => {
    await t.test("creditSum that does not tie", () => {
        const parsed = parseBankBatch(bankBatch([{ ref: "A1", amount: 100 }], { creditSum: 200 }));
        assert.equal(parsed.ok, false);
        assert.match((parsed as { reason: string }).reason, /creditSum/);
    });

    await t.test("creditCount that does not tie", () => {
        const parsed = parseBankBatch(bankBatch([{ ref: "A1", amount: 100 }], { creditCount: 2 }));
        assert.equal(parsed.ok, false);
        assert.match((parsed as { reason: string }).reason, /creditCount/);
    });

    await t.test("a correct batch parses to exact cents", () => {
        const parsed = parseBankBatch(bankBatch([{ ref: "A1", amount: 13447.68 }]));
        assert.equal(parsed.ok, true);
        assert.equal((parsed as { batch: { credits: Array<{ amountCents: number }> } }).batch.credits[0].amountCents, 1_344_768);
    });
});

test("batch gate: a credit without a bankReference is rejected — it has no identity", () => {
    const parsed = parseBankBatch({
        source: "bank", postDate: SETTLED_DAY, creditCount: 1, creditSum: 100,
        credits: [{ amount: 100, transactionDetail: "DEPOSIT" }],
    });
    assert.equal(parsed.ok, false);
    assert.match((parsed as { reason: string }).reason, /missing bankReference/);
});

test("batch gate: the same reference twice in one batch is malformed, not two deposits", () => {
    const parsed = parseBankBatch(bankBatch([{ ref: "A1", amount: 10 }, { ref: "A1", amount: 10 }]));
    assert.equal(parsed.ok, false);
    assert.match((parsed as { reason: string }).reason, /appears twice/);
});

test("batch gate: sub-cent and non-positive amounts are refused", () => {
    for (const amount of [100.005, 0, -5]) {
        const parsed = parseBankBatch(bankBatch([{ ref: "A1", amount }], { creditSum: amount, creditCount: 1 }));
        assert.equal(parsed.ok, false, `amount ${amount} must be refused`);
    }
});

test("collisions: two DIFFERENT references at the same amount flag each other", () => {
    const credits = [
        { bankReference: "A1", amount: 500, amountCents: 50_000, transactionDetail: null, customerReference: null },
        { bankReference: "B2", amount: 500, amountCents: 50_000, transactionDetail: null, customerReference: null },
        { bankReference: "C3", amount: 900, amountCents: 90_000, transactionDetail: null, customerReference: null },
    ];
    const collisions = findBatchCollisions(credits);
    assert.deepEqual(collisions.get("A1"), ["B2"]);
    assert.deepEqual(collisions.get("B2"), ["A1"]);
    assert.equal(collisions.get("C3"), undefined);
});

test("wait rule: a credit posted yesterday is too young; two days old is eligible", () => {
    const now = new Date("2026-08-26T10:00:00Z");
    assert.equal(bankCreditIsOldEnough("2026-08-25", now), false);
    assert.equal(bankCreditIsOldEnough("2026-08-24", now), true);
    assert.equal(bankCreditIsOldEnough("2026-08-26", now), false);
});

test("image lookup: the key carries a :front / :back side suffix, so the match is a PREFIX", () => {
    assert.equal(bankImageKeyPrefix("26236015002406"), "26236015002406:");
    assert.ok("26236015002406:front".startsWith(bankImageKeyPrefix("26236015002406")));
    // A bare-reference equality lookup — the round-1 bug — finds nothing.
    assert.notEqual("26236015002406:front", "26236015002406");
    // And a longer reference that merely starts the same is NOT this deposit.
    assert.equal("262360150024061:front".startsWith(bankImageKeyPrefix("26236015002406")), false);
});

test("image evidence: zero payer-bearing images is normal, two is a conflict", () => {
    assert.deepEqual(selectPayerBearingImage([]), { kind: "none" });
    assert.deepEqual(selectPayerBearingImage([{ payerName: null }, { payerName: "  " }]), { kind: "none" });
    assert.equal(selectPayerBearingImage([{ payerName: "Sandi Hoppe" }]).kind, "one");
    assert.deepEqual(selectPayerBearingImage([{ payerName: "A" }, { payerName: "B" }]), { kind: "conflict", count: 2 });
});

test("messages name the row on the other side of the collision", () => {
    assert.match(
        appliedTwinNote({ source: null, fileId: "drive-file-1", bankReference: null, postDate: "2026-08-24" }),
        /already applied from a deposit photo \(file drive-file-1\) on 2026-08-24/,
    );
    assert.match(
        appliedTwinNote({ source: BANK_DEPOSIT_SOURCE, fileId: "bank:262", bankReference: "262", postDate: "2026-08-24" }),
        /already applied by the deposit sweep from bank ref 262 on 2026-08-24/,
    );
    assert.match(
        crossSourceClaimNote({ fileId: "drive-1", source: null, bankReference: null, status: "processing", paymentScheduleId: "sched-9", postDate: "2026-08-24" }),
        /deposit photo \(file drive-1\).*working \(processing\).*sched-9/s,
    );
    assert.match(
        reservationLostNote({ fileId: "bank:262", source: BANK_DEPOSIT_SOURCE, bankReference: "262", status: "applied", paymentScheduleId: "s1", postDate: null }),
        /already being applied by the deposit sweep \(bank ref 262/,
    );
    assert.equal(reservationLostNote(null), "milestone already being applied by another deposit");
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The route
// ═════════════════════════════════════════════════════════════════════════════

test("auth: the bank variant is behind the same fail-closed bearer gate", async t => {
    await t.test("no Authorization header → 401", async () => {
        const { res } = await post(bankBatch([{ ref: "A1", amount: 10 }]), null);
        assert.equal(res.status, 401);
        assert.equal(tables.depositIngest.rows.length, 0);
    });

    await t.test("wrong bearer → 401", async () => {
        const { res } = await post(bankBatch([{ ref: "A1", amount: 10 }]), "Bearer nope");
        assert.equal(res.status, 401);
    });

    await t.test("no configured secret → 401, never open", async () => {
        delete process.env.DEPOSIT_INGEST_SECRET;
        const { res } = await post(bankBatch([{ ref: "A1", amount: 10 }]), "Bearer anything");
        assert.equal(res.status, 401);
    });
});

test("control-total mismatch → 400 and NOTHING is written", async () => {
    seedMilestone({ amount: 500 });
    const { res, body } = await post(bankBatch([{ ref: "A1", amount: 500 }], { creditSum: 501 }));
    assert.equal(res.status, 400);
    assert.match(String(body.reason), /creditSum/);
    assert.equal(tables.depositIngest.rows.length, 0, "no DepositIngest row for a refused batch");
    assert.equal(calls.buildQBPaymentRequest.length, 0);
});

test("the Hoppe case: three Pending milestones at the same amount, only one REQUESTED → that one applies", async () => {
    const requested = seedMilestone({ amount: 13447.68, name: "Rough In complete", invoiceCode: "INV-00173" });
    seedMilestone({ amount: 13447.68, name: "Drywall complete", requested: false });
    seedMilestone({ amount: 13447.68, name: "Tile complete", requested: false });

    const { body } = await post(bankBatch([{ ref: "26236015002406", amount: 13447.68 }]));
    const result = creditResult(body, "26236015002406");
    assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
    assert.equal(result.scheduleId, requested);
    assert.deepEqual(body.counts, { credits: 1, applied: 1, needsHuman: 0, proposed: 0, replay: 0 });

    // The candidate query itself must carry the requested filter — this is the
    // rule, and it lives in SQL.
    assert.deepEqual(queries.paymentSchedule[0].where.qbInvoiceSentAt, { not: null });
    assert.equal(tables.paymentSchedule.rows.find(r => r.id === requested)!.status, "Paid");
});

test("a qbInvoiceId-only milestone is NOT a candidate — an unsent QBO invoice was never requested", async () => {
    seedMilestone({ amount: 4000, requested: false, qbInvoiceId: "qb-inv-unsent" });

    const { body } = await post(bankBatch([{ ref: "REF-UNSENT", amount: 4000 }]));
    const result = creditResult(body, "REF-UNSENT");
    assert.equal(result.status, "unmatched");
    assert.match(String(result.reason), /no requested pending milestone matches \$4000\.00/);
    assert.equal(calls.buildQBPaymentRequest.length, 0, "no QBO write for a non-candidate");
});

test("three REQUESTED milestones at the same amount → a human, with every candidate named", async () => {
    seedMilestone({ amount: 13447.68, name: "Rough In", invoiceCode: "INV-A", projectName: "Hoppe Hall Bath" });
    seedMilestone({ amount: 13447.68, name: "Drywall", invoiceCode: "INV-B", projectName: "Hoppe Hall Bath" });
    seedMilestone({ amount: 13447.68, name: "Tile", invoiceCode: "INV-C", projectName: "Hoppe Hall Bath" });

    const { body } = await post(bankBatch([{ ref: "REF-AMBIG", amount: 13447.68 }]));
    const result = creditResult(body, "REF-AMBIG");
    assert.equal(result.status, "unmatched");
    assert.match(String(result.reason), /matches 3 milestones/);
    for (const code of ["INV-A", "INV-B", "INV-C"]) assert.match(String(result.reason), new RegExp(code));
    assert.ok(result.officeTaskId, "an OfficeTask is filed for the human");
    assert.match(taskNotes().join("\n"), /Hoppe Hall Bath/);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
});

test("the union rule: a same-amount milestone settled RECENTLY by any source blocks the apply", async t => {
    await t.test("Paid 3 days ago → a human", async () => {
        seedMilestone({ amount: 7500, name: "Requested milestone" });
        seedMilestone({ amount: 7500, name: "Just settled elsewhere", status: "Paid", paymentDate: utc(isoDaysAgo(3)) });

        const { body } = await post(bankBatch([{ ref: "REF-UNION-NEAR", amount: 7500 }]));
        const result = creditResult(body, "REF-UNION-NEAR");
        assert.equal(result.status, "unmatched");
        assert.match(String(result.reason), /matches 2 milestones/);
        assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
    });

    await t.test("Paid 20 days ago → outside the window, the apply proceeds", async () => {
        const requested = seedMilestone({ amount: 7500, name: "Requested milestone" });
        seedMilestone({ amount: 7500, name: "Settled long ago", status: "Paid", paymentDate: utc(isoDaysAgo(20)) });

        const { body } = await post(bankBatch([{ ref: "REF-UNION-FAR", amount: 7500 }]));
        const result = creditResult(body, "REF-UNION-FAR");
        assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
        assert.equal(result.scheduleId, requested);
    });
});

test("auto-apply requires qbInvoiceId — a requested milestone with no QBO link goes to a human", async () => {
    seedMilestone({ amount: 2500, qbInvoiceId: null, name: "Unlinked milestone" });

    const { body } = await post(bankBatch([{ ref: "REF-NOLINK", amount: 2500 }]));
    const result = creditResult(body, "REF-NOLINK");
    assert.equal(result.status, "unmatched");
    assert.match(String(result.reason), /no QuickBooks invoice link/);
    assert.equal(calls.buildQBPaymentRequest.length, 0);
});

test("the wait rule: a credit posted yesterday is PROPOSED, not applied", async () => {
    const requested = seedMilestone({ amount: 3300 });
    const yesterday = isoDaysAgo(1);

    const { body } = await post(bankBatch([{ ref: "REF-YOUNG", amount: 3300 }], { postDate: yesterday }));
    const result = creditResult(body, "REF-YOUNG");
    assert.equal(result.status, "proposed");
    assert.equal(body.counts.proposed, 1);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0, "a proposed credit never reaches QuickBooks");

    const row = depositRow("REF-YOUNG");
    assert.equal(row!.status, "proposed");
    assert.equal(row!.paymentScheduleId, requested, "the would-apply milestone is recorded");
    assert.equal(tables.paymentSchedule.rows.find(r => r.id === requested)!.status, "Pending");
});

test("dryRun writes `proposed` and touches no money boundary, even for an old credit", async () => {
    seedMilestone({ amount: 999 });
    const { body } = await post(bankBatch([{ ref: "REF-DRY", amount: 999 }], { dryRun: true }));
    assert.equal(creditResult(body, "REF-DRY").status, "proposed");
    assert.equal(body.dryRun, true);
    assert.equal(calls.buildQBPaymentRequest.length, 0);
    assert.equal(depositRow("REF-DRY")!.qbRequestPayload ?? null, null);
});

test("two same-day same-amount credits in ONE batch → both go to a human", async () => {
    seedMilestone({ amount: 500 });
    const { body } = await post(bankBatch([{ ref: "AA", amount: 500 }, { ref: "BB", amount: 500 }]));

    for (const ref of ["AA", "BB"]) {
        const result = creditResult(body, ref);
        assert.equal(result.status, "unmatched", `${ref} must go to a human`);
        assert.match(String(result.reason), /different bank credits/);
    }
    assert.equal(body.counts.needsHuman, 2);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
});

test("a re-POST of the same day is a REPLAY: one payment, alreadyApplied, never a collision", async () => {
    seedMilestone({ amount: 1200 });
    const first = await post(bankBatch([{ ref: "REF-REPLAY", amount: 1200 }]));
    assert.equal(creditResult(first.body, "REF-REPLAY").status, "applied");
    assert.equal(first.body.counts.replay, 0);

    const second = await post(bankBatch([{ ref: "REF-REPLAY", amount: 1200 }]));
    const result = creditResult(second.body, "REF-REPLAY");
    assert.equal(result.status, "applied");
    assert.equal(result.alreadyApplied, true);
    assert.equal(result.replay, true);
    assert.equal(second.body.counts.replay, 1);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 1, "exactly one QuickBooks payment for one bank credit");
    assert.equal(tables.depositIngest.rows.length, 1);
});

test("a `proposed` row is re-evaluated by the next POST rather than treated as a collision", async () => {
    const requested = seedMilestone({ amount: 4500 });
    const dry = await post(bankBatch([{ ref: "REF-AGE", amount: 4500 }], { dryRun: true }));
    assert.equal(creditResult(dry.body, "REF-AGE").status, "proposed");

    const live = await post(bankBatch([{ ref: "REF-AGE", amount: 4500 }]));
    const result = creditResult(live.body, "REF-AGE");
    assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
    assert.equal(result.replay, true);
    assert.equal(tables.paymentSchedule.rows.find(r => r.id === requested)!.status, "Paid");
});

test("the money write carries the bank reference, the WTB deposit account, and receipt suppression", async () => {
    const requested = seedMilestone({ amount: 13447.68 });
    await post(bankBatch([{ ref: "26236015002406", amount: 13447.68 }]));

    const built = calls.buildQBPaymentRequest[0];
    assert.equal(built.paymentRefNum, "26236015002406", "PaymentRefNum carries the bank reference");
    assert.equal(built.txnDate, SETTLED_DAY);
    assert.equal(built.depositToAccountId, BANK_DEPOSIT_TO_ACCOUNT_ID);

    const settled = calls.settleMilestoneFromQBPayment[0];
    assert.equal(settled.paymentScheduleId, requested);
    assert.equal(settled.referenceNumber, "26236015002406");
    assert.equal(settled.suppressClientReceipt, true, "a swept credit never emails the client a receipt");
});

test("the photo path is unchanged: no deposit account, no receipt suppression", async () => {
    tables.project.rows.push({ id: "project-1", name: "Hoppe Hall Bath", client: { name: "Hoppe" } });
    const requested = seedMilestone({ amount: 800, requested: false, projectName: "Hoppe Hall Bath" });

    const { body } = await post({
        fileId: "drive-file-photo", projectName: "Hoppe Hall Bath", amount: 800,
        checkDate: SETTLED_DAY, checkNumber: "4501", payerName: "Hoppe",
    });
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.reason}`);
    assert.equal(body.scheduleId, requested);
    assert.equal(calls.buildQBPaymentRequest[0].depositToAccountId, undefined);
    assert.equal(calls.settleMilestoneFromQBPayment[0].suppressClientReceipt, undefined);

    // and it now persists the columns the cross-source claim check reads
    const row = tables.depositIngest.rows.find(r => r.fileId === "drive-file-photo")!;
    assert.equal(row.amountCents, 80_000);
    assert.equal(row.postDate?.toISOString().slice(0, 10), SETTLED_DAY);
    assert.equal(row.source ?? null, null, "a photo row carries no source");
});

test("cross-source claim check: a photo row already working this money stands the sweep down", async () => {
    seedMilestone({ amount: 6100 });
    tables.depositIngest.rows.push({
        id: "photo-row", fileId: "drive-file-inflight", status: "processing", source: null,
        extracted: "{}", attempts: 1, amountCents: 610_000, postDate: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 2)),
        paymentScheduleId: "sched-other", processingStartedAt: new Date(), updatedAt: new Date(),
    });

    const { body } = await post(bankBatch([{ ref: "REF-CLAIMED", amount: 6100 }]));
    const result = creditResult(body, "REF-CLAIMED");
    assert.equal(result.status, "unmatched");
    assert.match(String(result.reason), /deposit photo \(file drive-file-inflight\)/);
    assert.match(String(result.reason), /sched-other/);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
});

test("cross-source claim check, the other direction: a bank row in flight stands the PHOTO down", async () => {
    tables.project.rows.push({ id: "project-1", name: "Hoppe Hall Bath", client: { name: "Hoppe" } });
    seedMilestone({ amount: 6100, requested: false, projectName: "Hoppe Hall Bath" });
    tables.depositIngest.rows.push({
        id: "bank-row", fileId: bankFileId("REF-INFLIGHT"), status: "qbo_created", source: BANK_DEPOSIT_SOURCE,
        bankReference: "REF-INFLIGHT", extracted: "{}", attempts: 1, amountCents: 610_000,
        postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-elsewhere", processingStartedAt: new Date(), updatedAt: new Date(),
    });

    const { body } = await post({
        fileId: "drive-file-late", projectName: "Hoppe Hall Bath", amount: 6100,
        checkDate: SETTLED_DAY, checkNumber: "4777", payerName: "Hoppe",
    });
    assert.equal(body.status, "unmatched");
    assert.match(String(body.reason), /deposit sweep \(bank ref REF-INFLIGHT\)/);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
});

test("dedup messaging, photo first: the sweep's task says the photo already applied it", async () => {
    seedMilestone({ amount: 2100, status: "Paid", paymentDate: utc(isoDaysAgo(30)) }); // outside the union window
    tables.depositIngest.rows.push({
        id: "photo-applied", fileId: "drive-file-earlier", status: "applied", source: null,
        extracted: "{}", attempts: 1, amountCents: 210_000, postDate: utc(SETTLED_DAY), updatedAt: new Date(),
    });

    const { body } = await post(bankBatch([{ ref: "REF-AFTER-PHOTO", amount: 2100 }]));
    const result = creditResult(body, "REF-AFTER-PHOTO");
    assert.equal(result.status, "unmatched");
    assert.match(String(result.reason), /likely the same check already applied from a deposit photo \(file drive-file-earlier\)/);
    assert.match(String(result.reason), /Verify, then archive this task/);
});

test("dedup messaging, bank first: the photo's task says the sweep already applied it", async () => {
    tables.project.rows.push({ id: "project-1", name: "Hoppe Hall Bath", client: { name: "Hoppe" } });
    tables.depositIngest.rows.push({
        id: "bank-applied", fileId: bankFileId("REF-EARLIER"), status: "applied", source: BANK_DEPOSIT_SOURCE,
        bankReference: "REF-EARLIER", extracted: "{}", attempts: 1, amountCents: 210_000,
        postDate: utc(SETTLED_DAY), updatedAt: new Date(),
    });

    const { body } = await post({
        fileId: "drive-file-after-bank", projectName: "Hoppe Hall Bath", amount: 2100,
        checkDate: SETTLED_DAY, checkNumber: "4808", payerName: "Hoppe",
    });
    assert.equal(body.status, "unmatched");
    assert.match(String(body.reason), /already applied by the deposit sweep from bank ref REF-EARLIER/);
    assert.match(String(body.reason), /Verify, then archive this task/);
});

test("check images are looked up by the :side-suffixed key, and a wrong-family payer is a conflict", async () => {
    seedMilestone({ amount: 9000, projectName: "Mesplay Kitchen", clientName: "Sandi Mesplay" });
    tables.bankImage.rows.push({
        id: "img-1", source: "WTB_ONLINE", sourceExternalId: "REF-IMG:front", kind: "CHECK_FRONT",
        payerName: "Sandi Christensen", memoText: null, normalizedCheckNumber: "1027",
        amountCents: 900_000, documentDate: utc(SETTLED_DAY),
    });

    const { body } = await post(bankBatch([{ ref: "REF-IMG", amount: 9000 }]));
    const result = creditResult(body, "REF-IMG");

    assert.deepEqual(
        queries.bankImage[0].where,
        { source: "WTB_ONLINE", sourceExternalId: { startsWith: "REF-IMG:" } },
        "the lookup must be a prefix match on the reference, not equality",
    );
    assert.equal(result.status, "unmatched", "a check naming a different family must never auto-book");
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
});

test("an agreeing check image is corroboration, not an obstacle", async () => {
    const requested = seedMilestone({ amount: 9000, projectName: "Mesplay Kitchen", clientName: "Sandi Mesplay" });
    tables.bankImage.rows.push({
        id: "img-ok", source: "WTB_ONLINE", sourceExternalId: "REF-IMG-OK:front", kind: "CHECK_FRONT",
        payerName: "Sandi Mesplay", memoText: "kitchen", normalizedCheckNumber: "1028",
        amountCents: 900_000, documentDate: utc(SETTLED_DAY),
    });

    const { body } = await post(bankBatch([{ ref: "REF-IMG-OK", amount: 9000 }]));
    const result = creditResult(body, "REF-IMG-OK");
    assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
    assert.equal(result.scheduleId, requested);
});

test("two payer-bearing images under one reference is a conflict — one deposit cannot have two payers", async () => {
    seedMilestone({ amount: 9500, projectName: "Hoppe Hall Bath", clientName: "Hoppe" });
    for (const [side, payer] of [["front", "Hoppe"], ["back", "Someone Else"]]) {
        tables.bankImage.rows.push({
            id: `img-${side}`, source: "WTB_ONLINE", sourceExternalId: `REF-TWO:${side}`, kind: "CHECK_FRONT",
            payerName: payer, memoText: null, normalizedCheckNumber: null, amountCents: 950_000, documentDate: utc(SETTLED_DAY),
        });
    }

    const { body } = await post(bankBatch([{ ref: "REF-TWO", amount: 9500 }]));
    const result = creditResult(body, "REF-TWO");
    assert.equal(result.status, "unmatched");
    assert.match(String(result.reason), /2 check images .* name a payer/);
});

test("a QuickBooks balance mismatch (Marge already booked it) creates no payment", async () => {
    seedMilestone({ amount: 1500, qbInvoiceId: "qb-inv-prebooked" });
    qboBalanceByInvoice.set("qb-inv-prebooked", 0);

    const { body } = await post(bankBatch([{ ref: "REF-PREBOOKED", amount: 1500 }]));
    const result = creditResult(body, "REF-PREBOOKED");
    assert.equal(result.status, "failed", `expected a retryable guard failure, got ${result.status}`);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0, "the guard rejects BEFORE the create");
    assert.match(String(depositRow("REF-PREBOOKED")!.lastError), /balance-mismatch/);
});

test("the batch response carries the counts the Bot Health line is built from", async () => {
    seedMilestone({ amount: 100 });   // clean → applied
    seedMilestone({ amount: 250 });   // duplicated below → both human
    seedMilestone({ amount: 250 });

    const { body } = await post(bankBatch([
        { ref: "R-OK", amount: 100 },
        { ref: "R-DUP-1", amount: 250 },
        { ref: "R-DUP-2", amount: 250 },
    ]));
    assert.deepEqual(body.counts, { credits: 3, applied: 1, needsHuman: 2, proposed: 0, replay: 0 });
});
