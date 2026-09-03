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
    findCollisions,
    isCustomerDepositClass,
    isDeterministicQboGuardFailure,
    isNotCustomerDepositReason,
    notCustomerDepositNote,
    MAX_BANK_CREDITS_PER_BATCH,
    CLAIMING_STATUSES,
    MONEY_BOUNDARY_CLAIM_STATUSES,
    RESERVATION_RETAINING_STATUSES,
    LIVE_APPLY_ENV_VAR,
    PROGRESS_WINDOW_DAYS,
    bankCreditFingerprint,
    booksWithoutOverride,
    hasPayerCorroboration,
    liveApplyEnabled,
    milestoneProgressTokens,
    progressCorroboration,
    requestedByInstant,
    parseBankBatch,
    qboGuardNote,
    reservationLostNote,
    selectPayerBearingImage,
    sweepBatchOk,
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
        if (key === "OR") { if (!(cond as Row[]).some(c => matchWhere(row, c))) return false; continue; }
        if (key === "AND") { if (!(cond as Row[]).every(c => matchWhere(row, c))) return false; continue; }
        if (key === "NOT") { if (matchWhere(row, cond as Row)) return false; continue; }
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
    // The job-progress corroboration reads these two.
    inspection: new Table("inspection"),
    dailyLog: new Table("dailyLog"),
    // Only the real settle path (M3) reaches these.
    invoice: new Table("invoice"),
    estimatePaymentSchedule: new Table("estimatePaymentSchedule"),
    estimate: new Table("estimate"),
    paymentNotification: new Table("paymentNotification"),
};

const queries: { paymentSchedule: Row[]; bankImage: Row[] } = { paymentSchedule: [], bankImage: [] };
/** Ordered trace of the calls that matter for serialization proofs. */
const callLog: string[] = [];
/** fileId → the status its DepositIngest row was CREATED with. */
const createdStatus = new Map<string, string>();
/** fileId → the fingerprint create() was GIVEN. Distinct from the row's final
 *  value, which the legacy backfill would repair a moment later — the point of
 *  the rule is that the stamp happens at creation. */
const createdFingerprint = new Map<string, string | null>();

const fakePrisma: Row = {
    depositIngest: Object.assign(Object.create(tables.depositIngest), {
        create: async (args: { data: Row }) => {
            const row = await tables.depositIngest.create(args);
            createdStatus.set(String(row.fileId), String(row.status));
            createdFingerprint.set(String(row.fileId), (args.data.bankFingerprint as string | undefined) ?? null);
            return row;
        },
        findFirst: async (args: { where?: Row }) => {
            callLog.push("CLAIM_QUERY");
            return tables.depositIngest.findFirst(args);
        },
    }),
    bankImage: {
        findMany: async (args: Row) => {
            queries.bankImage.push(args);
            return tables.bankImage.findMany(args);
        },
    },
    paymentSchedule: {
        // Wrapped only so the candidate query can be asserted; every other
        // method delegates straight through to the table.
        findMany: async (args: Row) => {
            queries.paymentSchedule.push(args);
            return tables.paymentSchedule.findMany(args);
        },
        findUnique: (args: { where: Row }) => tables.paymentSchedule.findUnique(args),
        findFirst: (args: { where?: Row }) => tables.paymentSchedule.findFirst(args),
        create: (args: { data: Row }) => tables.paymentSchedule.create(args),
        update: (args: { where: Row; data: Row }) => tables.paymentSchedule.update(args),
        updateMany: (args: { where: Row; data: Row }) => tables.paymentSchedule.updateMany(args),
    },
    officeTask: tables.officeTask,
    officeBoardColumn: tables.officeBoardColumn,
    project: tables.project,
    inspection: tables.inspection,
    dailyLog: tables.dailyLog,
    invoice: tables.invoice,
    estimatePaymentSchedule: tables.estimatePaymentSchedule,
    estimate: tables.estimate,
    paymentNotification: tables.paymentNotification,
    $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(fakePrisma),
    // lockMoneyParents' SELECT ... FOR UPDATE. Nothing to lock in memory.
    $queryRaw: async () => [],
    // The claim domain's advisory lock. Recorded (with the call order) so the
    // test can prove it is taken BEFORE the claim query, not after it.
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        callLog.push(`SQL:${strings.join("?")}|${values.join(",")}`);
        return 0;
    },
    $executeRawUnsafe: async () => 0,
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
/** The REAL settleMilestoneFromQBPayment (not the route's stub) — M3 is about
 *  what that shared function decides on its own, for the caller that passes no
 *  options at all: the hourly QuickBooks sync. */
let settleMilestoneFromQBPayment: (input: Row) => Promise<boolean>;
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

    // Second load, different target: the real settle module, with only Prisma
    // faked (it reaches it as "./prisma", a relative specifier).
    let relativePrismaPatched = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "./prisma" || id === "@/lib/prisma") { relativePrismaPatched = true; return { prisma: fakePrisma }; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    let settleMod: Row;
    try {
        settleMod = await import("../src/lib/quickbooks-payments");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (!relativePrismaPatched) throw new Error('deposit-sweep.test.ts: the mock of "./prisma" never applied to the settle module');
    settleMilestoneFromQBPayment = settleMod.settleMilestoneFromQBPayment as never;
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
    projectId?: string;
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
        // Real Prisma rows always carry these; the cumulative-share ordering
        // reads them.
        createdAt: new Date(TODAY.getTime() - 60 * 86_400_000),
        dueDate: null,
        name: opts.name ?? `Milestone ${scheduleSeq}`,
        status: opts.status ?? "Pending",
        amount: opts.amount,
        invoiceId: `inv-${scheduleSeq}`,
        qbInvoiceId: opts.qbInvoiceId === undefined ? `qb-inv-${scheduleSeq}` : opts.qbInvoiceId,
        // Requested well BEFORE the credit posts — the realistic order, and the
        // one the chronology rule requires. Tests that care about the boundary
        // set this explicitly.
        qbInvoiceSentAt: opts.requested === false ? null : new Date(TODAY.getTime() - 30 * 86_400_000),
        paymentDate: opts.paymentDate ?? null,
        invoice: {
            id: `inv-${scheduleSeq}`,
            projectId: opts.projectId ?? "project-1",
            code: opts.invoiceCode ?? `INV-${scheduleSeq}`,
            status: opts.invoiceStatus ?? "Issued",
            project: { id: opts.projectId ?? "project-1", name: opts.projectName ?? "Hoppe Hall Bath" },
            client: { name: opts.clientName ?? "Hoppe" },
        },
    });
    return id;
}

function bankBatch(
    credits: Array<{ ref: string; amount: number; detail?: string; description?: string; bai?: string }>,
    overrides: Row = {},
) {
    return {
        source: "bank",
        postDate: SETTLED_DAY,
        credits: credits.map(c => ({
            bankReference: c.ref,
            amount: c.amount,
            // The real WTB shape for a branch deposit, unless a test is
            // deliberately posting some other class of credit.
            baiCode: c.bai ?? "174",
            description: c.description ?? "OTHER DEPOSITS",
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
    createdStatus.clear();
    createdFingerprint.clear();
    callLog.length = 0;
    for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = [];
    qboBalanceByInvoice = new Map();
    scheduleSeq = 0;
    tables.officeBoardColumn.rows.push({ id: "col-1", name: "To Do", position: 0, createdAt: new Date() });
    process.env.DEPOSIT_INGEST_SECRET = SECRET;
    // Most cases are about the MATCHING rules, so they run with live apply
    // switched on — the state Justin has to opt into. The switch's own
    // behaviour (and its default) is covered by its own tests below.
    process.env[LIVE_APPLY_ENV_VAR] = "true";
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

    await t.test("creditSum is REQUIRED — a batch without the bank's own total is refused", () => {
        // The runner never sends one it derived from the rows; a missing figure
        // means the day had no independent TOTAL CREDITS row, and a control
        // total that checks itself proves nothing.
        for (const missing of [undefined, null]) {
            const batch = bankBatch([{ ref: "A1", amount: 100 }]);
            const parsed = parseBankBatch({ ...batch, creditSum: missing });
            assert.equal(parsed.ok, false);
            assert.match((parsed as { reason: string }).reason, /creditSum is required/);
        }
        const notANumber = parseBankBatch({ ...bankBatch([{ ref: "A1", amount: 100 }]), creditSum: "100" });
        assert.equal(notANumber.ok, false);
        assert.match((notANumber as { reason: string }).reason, /creditSum must be a number/);
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

const credit = (ref: string, amount: number) => ({
    bankReference: ref, amount, amountCents: Math.round(amount * 100),
    baiCode: "174", description: "OTHER DEPOSITS", transactionDetail: "DEPOSIT - DDA/MMKT",
    customerReference: null,
});

test("collisions: two DIFFERENT references at the same amount flag each other", () => {
    const collisions = findCollisions([credit("A1", 500), credit("B2", 500), credit("C3", 900)]);
    assert.deepEqual(collisions.get("A1"), ["B2"]);
    assert.deepEqual(collisions.get("B2"), ["A1"]);
    assert.equal(collisions.get("C3"), undefined);
});

test("collisions: a stored same-day row counts, whatever state a previous run left it in", () => {
    // C2: the verdict must not depend on how far an earlier run got. Every one
    // of these is a row a crash could have left behind.
    for (const status of ["processing", "failed", "proposed", "applied", "unmatched"]) {
        const collisions = findCollisions([credit("A1", 500)], [{ bankReference: "B2", amountCents: 50_000, status } as any]);
        assert.deepEqual(collisions.get("A1"), ["B2"], `a stored ${status} twin must still collide`);
    }
    // A stored row at a different amount is not a twin.
    assert.equal(findCollisions([credit("A1", 500)], [{ bankReference: "B2", amountCents: 90_000 }]).get("A1"), undefined);
    // Only batch references get a verdict; a stored row is evidence, not a target.
    assert.equal(findCollisions([credit("A1", 500)], [{ bankReference: "B2", amountCents: 50_000 }]).get("B2"), undefined);
});

test("wait rule: a credit posted yesterday is too young; two days old is eligible", () => {
    const now = new Date("2026-08-26T10:00:00Z"); // 3am Pacific on the 26th
    assert.equal(bankCreditIsOldEnough("2026-08-25", now), false);
    assert.equal(bankCreditIsOldEnough("2026-08-24", now), true);
    assert.equal(bankCreditIsOldEnough("2026-08-26", now), false);
});

test("wait rule: 6pm Pacific is still TODAY — the UTC day must not shorten the window", () => {
    // The sweep runs at 6pm Pacific. Under the old `toISOString()` reading, UTC
    // had already rolled over to the 26th, so an Aug 24 credit looked two days
    // old after ONE local day — silently halving the window that exists to give
    // the photo path first dibs on a fresh check.
    const sixPmPacific = new Date("2026-08-26T01:00:00Z"); // 2026-08-25 18:00 PDT
    assert.equal(sixPmPacific.toISOString().slice(0, 10), "2026-08-26", "premise: UTC is already tomorrow");

    assert.equal(bankCreditIsOldEnough("2026-08-24", sixPmPacific), false, "one local day is not two");
    assert.equal(bankCreditIsOldEnough("2026-08-23", sixPmPacific), true);
    // The following evening it becomes eligible, as intended.
    assert.equal(bankCreditIsOldEnough("2026-08-24", new Date("2026-08-27T01:00:00Z")), true);
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
    const claimNote = crossSourceClaimNote({ fileId: "drive-1", source: null, bankReference: null, status: "processing", paymentScheduleId: "sched-9", postDate: "2026-08-24" });
    assert.match(claimNote, /deposit photo \(file drive-1\)/);
    assert.match(claimNote, /working \(processing\)/);
    assert.match(claimNote, /milestone sched-9/);
    assert.match(
        reservationLostNote({ fileId: "bank:262", source: BANK_DEPOSIT_SOURCE, bankReference: "262", status: "applied", paymentScheduleId: "s1", postDate: null }),
        /already being applied by the deposit sweep \(bank ref 262/,
    );
    assert.equal(reservationLostNote(null), "milestone already being applied by another deposit");
});

test("live apply is a DECISION: the switch fails closed on anything but \"true\"", () => {
    for (const value of [undefined, "", "false", "1", "yes", "TRUE", "true ", "on"]) {
        assert.equal(
            liveApplyEnabled(value === undefined ? {} : { [LIVE_APPLY_ENV_VAR]: value }),
            false,
            `${JSON.stringify(value)} must NOT enable live money writes`,
        );
    }
    assert.equal(liveApplyEnabled({ [LIVE_APPLY_ENV_VAR]: "true" }), true);
});

test("payer corroboration is what the switch exempts", () => {
    // Evidence, not an amount coincidence.
    assert.equal(hasPayerCorroboration("verified"), true);
    assert.equal(hasPayerCorroboration("recorded"), true);
    assert.equal(hasPayerCorroboration("amount_only"), false);
    assert.equal(hasPayerCorroboration("unknown"), false);
    assert.equal(hasPayerCorroboration("conflict"), false);
});

test("chronology: the bound is the END of the post date, in the company's day", () => {
    // A milestone requested at 4pm Pacific on the deposit's own day still
    // counts; one requested the next morning does not.
    const bound = requestedByInstant("2026-08-24");
    assert.equal(new Date("2026-08-24T23:00:00Z") <= bound, true, "4pm Pacific on the day");
    assert.equal(new Date("2026-08-25T06:59:00Z") <= bound, true, "11:59pm Pacific on the day");
    assert.equal(new Date("2026-08-25T16:00:00Z") <= bound, false, "9am Pacific the next day");
});

test("replay identity: the fingerprint is the credit, not just its reference", () => {
    const credit = { postDate: "2026-08-24", amountCents: 1_344_768, baiCode: "174", description: "OTHER DEPOSITS", transactionDetail: "DEPOSIT - DDA/MMKT" };
    // Cosmetic re-rendering of the same row is the same credit.
    assert.equal(
        bankCreditFingerprint(credit),
        bankCreditFingerprint({ ...credit, description: "  other   deposits ", transactionDetail: "deposit - dda/mmkt " }),
    );
    // Anything that makes it a DIFFERENT deposit changes it.
    for (const change of [
        { postDate: "2026-08-25" },
        { amountCents: 1_344_769 },
        { baiCode: "165" },
        { description: "INTEREST PAID" },
        { transactionDetail: "MOBILE D 1234" },
    ]) {
        assert.notEqual(bankCreditFingerprint({ ...credit, ...change }), bankCreditFingerprint(credit), JSON.stringify(change));
    }
});

test("progress tokens: a milestone name's distinctive words, and only those", () => {
    assert.deepEqual(milestoneProgressTokens("Rough In complete"), ["ROUGH"]);
    assert.deepEqual(milestoneProgressTokens("Drywall complete"), ["DRYWALL"]);
    assert.deepEqual(milestoneProgressTokens("Tile & Finish Carpentry"), ["TILE", "FINISH", "CARPENTRY"]);
    // Nothing distinctive: (b) must not be able to fire on a name like this,
    // or ANY log would corroborate it.
    assert.deepEqual(milestoneProgressTokens("Final Payment"), []);
    assert.deepEqual(milestoneProgressTokens("Deposit"), []);
});

test("job progress: the field has to agree that THIS PHASE is done", async t => {
    const base = {
        postDate: "2026-08-24",
        milestoneName: "Rough In complete",
        inspections: [] as Array<{ result: string; type: string | null; date: string | null }>,
        dailyLogs: [] as Array<{ date: string; workPerformed: string }>,
    };

    await t.test("(a) a passed inspection OF THIS PHASE, inside the window", () => {
        const result = progressCorroboration({ ...base, inspections: [{ result: "PASSED", type: "Rough-in", date: "2026-08-21" }] });
        assert.equal(result.corroborated, true);
        assert.equal(result.via, "inspection");
        assert.match(result.detail, /"Rough-in" inspection passed on 2026-08-21/);
    });

    await t.test("…but an inspection of a DIFFERENT phase unlocks nothing", () => {
        // The whole risk of this rung: a plumbing sign-off must not release a
        // cabinetry milestone just because it happened the same week.
        for (const type of ["Plumbing final", "Electrical service", "Gas line", null]) {
            assert.equal(
                progressCorroboration({ ...base, inspections: [{ result: "PASSED", type, date: "2026-08-21" }] }).corroborated,
                false,
                `a "${type}" inspection must not corroborate "Rough In complete"`,
            );
        }
    });

    await t.test("…nor a FAILED one, nor one outside the window", () => {
        const insp = (over: Record<string, unknown>) => progressCorroboration({
            ...base,
            inspections: [{ result: "PASSED", type: "Rough-in", date: "2026-08-21", ...over } as never],
        }).corroborated;
        assert.equal(insp({ result: "FAILED" }), false);
        assert.equal(insp({ date: "2026-07-01" }), false, "older than the window");
        assert.equal(insp({ date: "2026-08-26" }), false, "after the deposit");
        assert.equal(insp({ date: null }), false);
    });

    await t.test("(b) a daily log that names this phase, as a WHOLE WORD", () => {
        const result = progressCorroboration({
            ...base,
            dailyLogs: [{ date: "2026-08-20", workPerformed: "Finished rough plumbing and electrical rough-in" }],
        });
        assert.equal(result.corroborated, true);
        assert.equal(result.via, "daily-log");
        assert.match(result.detail, /2026-08-20/);
    });

    await t.test("…so a token buried inside another word corroborates nothing", () => {
        // "textile" is not "tile"; "roughly" is not "rough". Substring matching
        // would have taken either as proof the phase was finished.
        assert.equal(
            progressCorroboration({ ...base, dailyLogs: [{ date: "2026-08-20", workPerformed: "Roughly half the trim is up" }] }).corroborated,
            false,
        );
        assert.equal(
            progressCorroboration({
                ...base,
                milestoneName: "Tile complete",
                dailyLogs: [{ date: "2026-08-20", workPerformed: "Delivered textile samples to the client" }],
            }).corroborated,
            false,
        );
        // …while the real word still does.
        assert.equal(
            progressCorroboration({
                ...base,
                milestoneName: "Tile complete",
                dailyLogs: [{ date: "2026-08-20", workPerformed: "Set tile in the hall bath" }],
            }).corroborated,
            true,
        );
    });

    await t.test("…and a log about a DIFFERENT phase corroborates nothing", () => {
        const result = progressCorroboration({
            ...base,
            dailyLogs: [{ date: "2026-08-20", workPerformed: "Hung drywall in the hall bath and taped corners" }],
        });
        assert.equal(result.corroborated, false);
        assert.match(result.detail, /no daily log mentioning "rough"/);
    });

    await t.test("a name with no distinctive words can never be corroborated", () => {
        const result = progressCorroboration({
            ...base,
            milestoneName: "Final Payment",
            inspections: [{ result: "PASSED", type: "Final", date: "2026-08-21" }],
            dailyLogs: [{ date: "2026-08-20", workPerformed: "final payment work complete milestone deposit" }],
        });
        assert.equal(result.corroborated, false);
        assert.match(result.detail, /no distinctive words/);
    });

    await t.test("nothing at all is not corroboration", () => {
        assert.equal(progressCorroboration(base).corroborated, false);
    });

    await t.test("there is NO percent-complete rung — it could not be dated", () => {
        // Project.percentComplete has no historical snapshot: percentCompleteAsOf
        // is just when it was last written, and the nightly recalc refreshes it,
        // so progress made after the deposit would have vouched for it.
        const result = progressCorroboration({
            ...base,
            percentComplete: 99, percentCompleteAsOf: "2026-08-25", requiredPercent: 10,
        } as unknown as Parameters<typeof progressCorroboration>[0]);
        assert.equal(result.corroborated, false, "percent-complete data must be ignored entirely");
    });
});

test("the ladder: payer evidence and job progress both book without the switch", () => {
    assert.equal(booksWithoutOverride("verified"), true);
    assert.equal(booksWithoutOverride("recorded"), true);
    assert.equal(booksWithoutOverride("progress"), true);
    assert.equal(booksWithoutOverride("amount_only"), false);
    assert.equal(booksWithoutOverride("unknown"), false);
    assert.equal(hasPayerCorroboration("progress"), false, "progress is a SEPARATE rung, not payer evidence");
});

test("claim sets: every state that can still HOLD a milestone counts as a claim", () => {
    // These are the partial reservation index's predicate
    // (scripts/apply-deposit-ingest-schema.mjs). `reconcile` and `failed` were
    // missing from the hand-written lists, and both sit past a money boundary
    // holding their milestone on purpose — so a photo and a bank credit could
    // each reserve a DIFFERENT milestone for the same deposit.
    assert.deepEqual(
        [...RESERVATION_RETAINING_STATUSES].sort(),
        ["applied", "failed", "processing", "qbo_created", "qbo_unknown", "reconcile"],
    );
    for (const status of RESERVATION_RETAINING_STATUSES) {
        assert.ok(CLAIMING_STATUSES.includes(status), `bank side must treat a photo row in ${status} as a claim`);
        assert.ok(MONEY_BOUNDARY_CLAIM_STATUSES.includes(status), `photo side must treat a bank row in ${status} as a claim`);
    }
    // …and `proposed` stays non-blocking for the photo path only (C1).
    assert.ok(CLAIMING_STATUSES.includes("proposed"));
    assert.equal(MONEY_BOUNDARY_CLAIM_STATUSES.includes("proposed" as never), false);
});

test("deposit class: ONLY a real customer deposit is sweepable", async t => {
    const row = (over: Record<string, string | null> = {}) => ({
        baiCode: "174", description: "OTHER DEPOSITS", transactionDetail: "DEPOSIT - DDA/MMKT", ...over,
    });

    await t.test("a branch deposit and a mobile deposit are customer deposits", () => {
        assert.equal(isCustomerDepositClass(row()), true);
        assert.equal(isCustomerDepositClass(row({ transactionDetail: "MOBILE DEPOSIT" })), true);
        assert.equal(isCustomerDepositClass(row({ transactionDetail: "MOBILE D 2343776286" })), true);
        // Whitespace and case are the bank's, not ours.
        assert.equal(isCustomerDepositClass(row({ description: "  other   deposits ", transactionDetail: "deposit - dda/mmkt  " })), true);
    });

    await t.test("everything else is refused — this is an ALLOWLIST", () => {
        // Each of these can land on the exact cents of a requested milestone.
        assert.equal(isCustomerDepositClass(row({ baiCode: "165", description: "INTEREST PAID" })), false, "interest");
        assert.equal(isCustomerDepositClass(row({ description: "INTEREST PAID" })), false, "interest under a deposit BAI");
        assert.equal(isCustomerDepositClass(row({ baiCode: "165", description: "ACH CREDIT", transactionDetail: "ACH REFUND" })), false, "ACH credit");
        assert.equal(isCustomerDepositClass(row({ baiCode: "195", description: "INCOMING WIRE", transactionDetail: "WIRE IN" })), false, "wire");
        assert.equal(isCustomerDepositClass(row({ description: "TRANSFER FROM SAVINGS", transactionDetail: "TRANSFER" })), false, "transfer");
        // An owner capital contribution that arrives under the deposit
        // description but a detail we do not recognise.
        assert.equal(isCustomerDepositClass(row({ transactionDetail: "CAPITAL CONTRIBUTION" })), false, "owner deposit, unknown detail");
        // Missing fields fail CLOSED (an older runner that sends none of them).
        assert.equal(isCustomerDepositClass({}), false);
        assert.equal(isCustomerDepositClass(row({ baiCode: null })), false);
        assert.equal(isCustomerDepositClass(row({ transactionDetail: null })), false);
    });

    await t.test("the reason names what the bank actually said", () => {
        const note = notCustomerDepositNote({ description: "INTEREST PAID", transactionDetail: "INTEREST" });
        assert.match(note, /not a customer deposit class \(INTEREST PAID \/ INTEREST\)/);
        assert.equal(isNotCustomerDepositReason(note), true);
        assert.equal(isNotCustomerDepositReason("no requested pending milestone matches $10.00"), false);
        assert.equal(isNotCustomerDepositReason(null), false);
    });
});

test("batch cap: a day is a handful of credits, not fifty-one", () => {
    assert.equal(MAX_BANK_CREDITS_PER_BATCH, 50);
    const many = Array.from({ length: MAX_BANK_CREDITS_PER_BATCH + 1 }, (_, i) => ({ ref: `R${i}`, amount: (i + 1) / 100 }));
    const parsed = parseBankBatch(bankBatch(many, {
        creditCount: many.length,
        creditSum: many.reduce((sum, c) => sum + Math.round(c.amount * 100), 0) / 100,
    }));
    assert.equal(parsed.ok, false);
    assert.match((parsed as { reason: string }).reason, /50-row batch cap/);
    assert.match((parsed as { reason: string }).reason, /one day at a time/);

    // …and exactly the cap is fine.
    const atCap = many.slice(0, MAX_BANK_CREDITS_PER_BATCH);
    assert.equal(parseBankBatch(bankBatch(atCap, {
        creditCount: atCap.length,
        creditSum: atCap.reduce((sum, c) => sum + Math.round(c.amount * 100), 0) / 100,
    })).ok, true);
});

test("dryRun is a BOOLEAN — a truthy string must never read as live", () => {
    // The wrong way round is catastrophic: "true" would be treated as live and
    // the shadow week would book real money.
    for (const value of ["true", "false", 1, 0, null, {}, []]) {
        const parsed = parseBankBatch(bankBatch([{ ref: "A1", amount: 10 }], { dryRun: value }));
        assert.equal(parsed.ok, false, `dryRun ${JSON.stringify(value)} must be refused`);
        assert.match((parsed as { reason: string }).reason, /dryRun must be a boolean/);
    }
    // The two real values, and absence.
    assert.equal((parseBankBatch(bankBatch([{ ref: "A1", amount: 10 }], { dryRun: true })) as { batch: { dryRun: boolean } }).batch.dryRun, true);
    assert.equal((parseBankBatch(bankBatch([{ ref: "A1", amount: 10 }], { dryRun: false })) as { batch: { dryRun: boolean } }).batch.dryRun, false);
    assert.equal((parseBankBatch(bankBatch([{ ref: "A1", amount: 10 }])) as { batch: { dryRun: boolean } }).batch.dryRun, false);
});

test("M1: a deterministic QuickBooks guard failure is explained, not retried", () => {
    assert.equal(isDeterministicQboGuardFailure("balance-mismatch"), true);
    assert.equal(isDeterministicQboGuardFailure("invoice-not-found"), true);
    assert.equal(isDeterministicQboGuardFailure("missing-customer"), true);
    assert.equal(isDeterministicQboGuardFailure("some-transient-thing"), false);

    const note = qboGuardNote({ reason: "balance-mismatch", qbBalance: 0, expected: 13447.68 }, "INV-00173");
    assert.match(note, /QuickBooks shows \$0\.00 owed on INV-00173, not \$13447\.68/);
    assert.match(note, /probably already booked\. Verify and archive\./);
    assert.match(qboGuardNote({ reason: "invoice-not-found" }, "INV-1"), /no longer exists/);
    assert.match(qboGuardNote({ reason: "missing-customer" }, "INV-1"), /no customer/);
});

test("M2: `ok` means the batch finished cleanly, not that everything booked", () => {
    const base = { credits: 3, applied: 1, proposed: 1, unmatched: 1, reconcile: 0, failed: 0, qboUnknown: 0, unresolved: 0, replay: 0 };
    // Asking a human is the sweep working as designed.
    assert.equal(sweepBatchOk(base), true);
    // Unresolved money is not.
    assert.equal(sweepBatchOk({ ...base, credits: 4, failed: 1 }), false);
    assert.equal(sweepBatchOk({ ...base, credits: 4, qboUnknown: 1 }), false);
    assert.equal(sweepBatchOk({ ...base, credits: 4, reconcile: 1 }), false);
    // The catch-all is what makes a status nobody named (qbo_created after a
    // settle threw, a busy processing row) fail the batch instead of vanishing.
    assert.equal(sweepBatchOk({ ...base, credits: 4, unresolved: 1 }), false);
});

test("M2: buckets that do not add up to the credit count can never report success", () => {
    // The failure this function exists to prevent: a credit counted as nothing
    // at all. If the partition is broken, the honest answer is "not ok" — never
    // a success derived from an incomplete tally.
    const short = { credits: 3, applied: 1, proposed: 1, unmatched: 0, reconcile: 0, failed: 0, qboUnknown: 0, unresolved: 0, replay: 0 };
    assert.equal(sweepBatchOk(short), false, "2 buckets for 3 credits is not a clean batch");
    assert.equal(sweepBatchOk({ ...short, unmatched: 1 }), true, "…and it is once every credit is accounted for");
    // Double counting is a broken partition too.
    assert.equal(sweepBatchOk({ ...short, applied: 2, unmatched: 1 }), false);
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
    assert.deepEqual(body.counts, {
        credits: 1, applied: 1, proposed: 0, unmatched: 0, reconcile: 0, failed: 0, qboUnknown: 0, unresolved: 0, replay: 0,
    });

    // The candidate query itself must carry the requested filter — this is the
    // rule, and it lives in SQL.
    assert.deepEqual(
        queries.paymentSchedule[0].where.qbInvoiceSentAt,
        { not: null, lte: requestedByInstant(SETTLED_DAY) },
        'requested, AND requested before the money arrived',
    );
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
    assert.equal(body.counts.unmatched, 2);
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

test("the claim check is CROSS-source only: two photos at the same amount both apply", async () => {
    // Two deposit photos at identical cents inside the window are NOT the
    // hazard the claim check exists for: each carries a project name, which is
    // what tells them apart, and the photo path's matching rules are untouched
    // by the sweep. Blocking the second one here would be a regression in a
    // path that was never ambiguous. (Prisma's `not` matches NULL rows, so a
    // `not: row.source` spelling of this filter would do exactly that — hence
    // the positive other-source equality in reserveMilestone.)
    tables.project.rows.push(
        { id: "project-1", name: "Hoppe Hall Bath", client: { name: "Hoppe" } },
        { id: "project-2", name: "Mesplay Kitchen", client: { name: "Mesplay" } },
    );
    const hoppeMilestone = seedMilestone({ amount: 5150.42, projectId: "project-1", projectName: "Hoppe Hall Bath", clientName: "Hoppe", requested: false });
    const mesplayMilestone = seedMilestone({ amount: 5150.42, projectId: "project-2", projectName: "Mesplay Kitchen", clientName: "Mesplay", requested: false });

    const first = await post({
        fileId: "drive-photo-hoppe", projectName: "Hoppe Hall Bath", amount: 5150.42,
        checkDate: SETTLED_DAY, checkNumber: "5001", payerName: "Hoppe",
    });
    assert.equal(first.body.status, "applied", `first photo: ${first.body.reason}`);
    assert.equal(first.body.scheduleId, hoppeMilestone);

    const second = await post({
        fileId: "drive-photo-mesplay", projectName: "Mesplay Kitchen", amount: 5150.42,
        checkDate: SETTLED_DAY, checkNumber: "5002", payerName: "Mesplay",
    });
    assert.equal(second.body.status, "applied", `second photo must not be claim-blocked: ${second.body.reason}`);
    assert.equal(second.body.scheduleId, mesplayMilestone);
    assert.equal(tables.paymentSchedule.rows.find(r => r.id === mesplayMilestone)!.status, "Paid");
});

test("the claim check is CROSS-source only: two bank credits days apart still resolve on their own rules", async () => {
    // Bank-vs-bank at one amount is covered by the batch collision rule (same
    // day) and by the union rule plus the applied-row lookup (different days),
    // so the claim check must not fire between two bank rows either.
    const requested = seedMilestone({ amount: 5250.43 });
    tables.depositIngest.rows.push({
        id: "bank-earlier", fileId: bankFileId("REF-BANK-EARLIER"), status: "applied", source: BANK_DEPOSIT_SOURCE,
        bankReference: "REF-BANK-EARLIER", extracted: "{}", attempts: 1, amountCents: 525_043,
        postDate: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 6)), paymentScheduleId: "sched-unrelated", updatedAt: new Date(),
    });

    const { body } = await post(bankBatch([{ ref: "REF-BANK-LATER", amount: 5250.43 }]));
    const result = creditResult(body, "REF-BANK-LATER");
    assert.equal(result.status, "applied", `a second bank credit is judged on the match rules, not the claim check: ${result.reason}`);
    assert.equal(result.scheduleId, requested);
});

test("claim check: a bank row in reconcile or failed still holds its milestone, so the photo stands down", async t => {
    for (const status of ["reconcile", "failed"]) {
        await t.test(`bank row in ${status} blocks the photo`, async () => {
            for (const table of Object.values(tables)) table.rows = [];
            tables.officeBoardColumn.rows.push({ id: "col-1", name: "To Do", position: 0, createdAt: new Date() });
            tables.project.rows.push({ id: "project-1", name: "Hoppe Hall Bath", client: { name: "Hoppe" } });
            // A DIFFERENT milestone from the one the photo would reserve: this
            // is the hole — two sources, same deposit, two milestones.
            seedMilestone({ amount: 7373.73, requested: false, projectName: "Hoppe Hall Bath" });
            tables.depositIngest.rows.push({
                id: `bank-${status}`, fileId: bankFileId(`REF-${status.toUpperCase()}`), status,
                source: BANK_DEPOSIT_SOURCE, bankReference: `REF-${status.toUpperCase()}`, extracted: "{}",
                attempts: 1, amountCents: 737_373, postDate: utc(SETTLED_DAY),
                paymentScheduleId: "sched-held-elsewhere", settleStartedAt: new Date(), updatedAt: new Date(),
            });

            const { body } = await post({
                fileId: `drive-photo-vs-${status}`, projectName: "Hoppe Hall Bath", amount: 7373.73,
                checkDate: SETTLED_DAY, checkNumber: "8001", payerName: "Hoppe",
            });
            assert.equal(body.status, "unmatched", `a ${status} bank row still owns this money`);
            assert.match(String(body.reason), /deposit sweep \(bank ref REF-/);
            assert.match(String(body.reason), /sched-held-elsewhere/);
            assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
        });

        await t.test(`photo row in ${status} blocks the bank credit`, async () => {
            for (const table of Object.values(tables)) table.rows = [];
            tables.officeBoardColumn.rows.push({ id: "col-1", name: "To Do", position: 0, createdAt: new Date() });
            const requested = seedMilestone({ amount: 7474.74 });
            assert.notEqual(requested, "sched-photo-holds");
            tables.depositIngest.rows.push({
                id: `photo-${status}`, fileId: `drive-file-${status}`, status, source: null,
                extracted: "{}", attempts: 1, amountCents: 747_474, postDate: utc(SETTLED_DAY),
                paymentScheduleId: "sched-photo-holds", settleStartedAt: new Date(), updatedAt: new Date(),
            });

            const { body } = await post(bankBatch([{ ref: `REF-VS-${status.toUpperCase()}`, amount: 7474.74 }]));
            const result = creditResult(body, `REF-VS-${status.toUpperCase()}`);
            assert.equal(result.status, "unmatched", `a ${status} photo row still owns this money`);
            assert.match(String(result.reason), /deposit photo \(file drive-file-/);
            assert.match(String(result.reason), /sched-photo-holds/);
            assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
        });
    }
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
    seedMilestone({ amount: 1500, qbInvoiceId: "qb-inv-prebooked", invoiceCode: "INV-PREBOOKED" });
    qboBalanceByInvoice.set("qb-inv-prebooked", 0);

    const { body } = await post(bankBatch([{ ref: "REF-PREBOOKED", amount: 1500 }]));
    const result = creditResult(body, "REF-PREBOOKED");
    // M1: terminal and explained, rather than eight retries of a request that
    // can never succeed.
    assert.equal(result.status, "unmatched", `expected a terminal guard rejection, got ${result.status}`);
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0, "the guard rejects BEFORE the create");
    assert.match(String(depositRow("REF-PREBOOKED")!.lastError), /probably already booked/);
});

test("C1: a PROPOSED bank row does not block the photo path — that window is the photo's", async () => {
    // The wait rule exists to give the evidence-rich photo first dibs on a fresh
    // check. A `proposed` bank row holding that window must not then be treated
    // as a claim against the photo, or the rule inverts itself.
    tables.project.rows.push({ id: "project-1", name: "Hoppe Hall Bath", client: { name: "Hoppe" } });
    const milestone = seedMilestone({ amount: 4321.55, projectName: "Hoppe Hall Bath", clientName: "Hoppe" });

    // A young credit lands as `proposed`, reserving nothing but recording intent.
    const yesterday = isoDaysAgo(1);
    const held = await post(bankBatch([{ ref: "REF-HELD", amount: 4321.55 }], { postDate: yesterday }));
    assert.equal(creditResult(held.body, "REF-HELD").status, "proposed");
    assert.equal(depositRow("REF-HELD")!.paymentScheduleId, milestone);

    // The photo of that same check arrives and must apply.
    const photo = await post({
        fileId: "drive-photo-vs-proposed", projectName: "Hoppe Hall Bath", amount: 4321.55,
        checkDate: yesterday, checkNumber: "6001", payerName: "Hoppe",
    });
    assert.equal(photo.body.status, "applied", `the photo must win its own window: ${photo.body.reason}`);
    assert.equal(photo.body.scheduleId, milestone);
    const paymentsAfterPhoto = calls.sendQBPaymentCreateRequest.length;

    // …and tomorrow's replay of the held credit resolves to a human, told why.
    const replay = await post(bankBatch([{ ref: "REF-HELD", amount: 4321.55 }], { postDate: yesterday }));
    const result = creditResult(replay.body, "REF-HELD");
    assert.equal(result.status, "unmatched");
    assert.match(String(result.reason), /already applied from a deposit photo \(file drive-photo-vs-proposed\)/);
    assert.equal(calls.sendQBPaymentCreateRequest.length, paymentsAfterPhoto, "the sweep books nothing on top of the photo");
});

test("C2: a collision survives a crash — the replay re-classifies and never books", async () => {
    seedMilestone({ amount: 6543.21 });
    // The crash: a previous run detected the collision, created this row as
    // `processing`, and died before filing it. Under the first cut of the
    // preflight the replay would see a row and drop it from classification.
    tables.depositIngest.rows.push({
        id: "crashed-row", fileId: bankFileId("REF-CRASH-A"), status: "processing", source: BANK_DEPOSIT_SOURCE,
        bankReference: "REF-CRASH-A", extracted: JSON.stringify({ fileId: bankFileId("REF-CRASH-A"), amount: 6543.21 }),
        attempts: 1, amountCents: 654_321, postDate: utc(SETTLED_DAY),
        processingStartedAt: new Date(Date.now() - 60 * 60_000), updatedAt: new Date(),
    });

    const { body } = await post(bankBatch([
        { ref: "REF-CRASH-A", amount: 6543.21 },
        { ref: "REF-CRASH-B", amount: 6543.21 },
    ]));

    for (const ref of ["REF-CRASH-A", "REF-CRASH-B"]) {
        const result = creditResult(body, ref);
        assert.equal(result.status, "unmatched", `${ref}: ${result.reason}`);
        assert.match(String(result.reason), /different bank credits/);
        assert.equal(depositRow(ref)!.status, "unmatched");
    }
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0, "a collision never books money");
    assert.equal(calls.buildQBPaymentRequest.length, 0);
});

test("C2: the collision verdict is persisted BEFORE any matching runs", async () => {
    seedMilestone({ amount: 7654.32 });
    let statusesWhenMatchingStarted: string[] | null = null;
    const realFindMany = fakePrisma.paymentSchedule.findMany;
    // The candidate query is the first thing matching does; snapshot the deposit
    // rows at that moment.
    fakePrisma.paymentSchedule.findMany = async (args: Row) => {
        statusesWhenMatchingStarted ??= tables.depositIngest.rows.map(r => String(r.status));
        return realFindMany(args);
    };
    try {
        await post(bankBatch([{ ref: "REF-ORDER-A", amount: 7654.32 }, { ref: "REF-ORDER-B", amount: 7654.32 }]));
    } finally {
        fakePrisma.paymentSchedule.findMany = realFindMany;
    }

    // The rows are BORN terminal. This is the crash-safety property: a process
    // that dies immediately after the insert still leaves a filed collision,
    // whereas a row born `processing` and finalized later can be lost.
    for (const ref of ["REF-ORDER-A", "REF-ORDER-B"]) {
        assert.equal(
            createdStatus.get(bankFileId(ref)), "unmatched",
            `${ref}'s row must be created already unmatched, never created as processing and finalized afterwards`,
        );
    }
    assert.equal(statusesWhenMatchingStarted, null, "matching must never run at all for a fully-colliding batch");
    assert.equal(tables.depositIngest.rows.length, 2);
    for (const row of tables.depositIngest.rows) assert.equal(row.status, "unmatched");
});

test("M1: a QuickBooks balance mismatch files for a human instead of burning retries", async () => {
    seedMilestone({ amount: 8765.43, qbInvoiceId: "qb-inv-already-booked", invoiceCode: "INV-00173" });
    qboBalanceByInvoice.set("qb-inv-already-booked", 0);

    const { body } = await post(bankBatch([{ ref: "REF-ALREADY-BOOKED", amount: 8765.43 }]));
    const result = creditResult(body, "REF-ALREADY-BOOKED");
    assert.equal(result.status, "unmatched", "deterministic guard failures are terminal, not retryable");
    assert.match(String(result.reason), /QuickBooks shows \$0\.00 owed on INV-00173, not \$8765\.43/);
    assert.match(String(result.reason), /probably already booked/);
    assert.ok(result.officeTaskId, "a human is asked to verify and archive");
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
    assert.equal(body.counts.failed, 0);
    assert.equal(body.ok, true, "an unmatched credit is a clean finish");
});

test("M2: a batch with unresolved credits answers ok:false with the full counts", async () => {
    // A QuickBooks outage: tokens resolve, the guard call throws. Every credit
    // lands in `failed`, which the runner must be able to see.
    seedMilestone({ amount: 9876.54 });
    const realBuild = fakeQuickbooks.buildQBPaymentRequest;
    fakeQuickbooks.buildQBPaymentRequest = async () => { throw new Error("QuickBooks is down"); };
    try {
        const { res, body } = await post(bankBatch([{ ref: "REF-OUTAGE", amount: 9876.54 }]));
        assert.equal(res.status, 200, "the batch WAS processed — 400 is for a payload we cannot trust");
        assert.equal(body.ok, false, "an unattended runner must be able to tell this went wrong");
        assert.equal(creditResult(body, "REF-OUTAGE").status, "failed");
        assert.deepEqual(body.counts, {
            credits: 1, applied: 0, proposed: 0, unmatched: 0, reconcile: 0, failed: 1, qboUnknown: 0, unresolved: 0, replay: 0,
        });
    } finally {
        fakeQuickbooks.buildQBPaymentRequest = realBuild;
    }
});

test("M3: the SYNC path suppresses the client receipt on its own when a bank deposit owns the milestone", async t => {
    // The sweep persists qbo_created BEFORE it settles. If it dies in that gap,
    // the hourly QuickBooks sync finds the payment the sweep just created and
    // settles the milestone itself — passing no options at all. Relying on the
    // caller to say "suppress" loses the flag exactly there, and the client gets
    // a receipt for money nobody has looked at. So the shared settle derives it.
    const seedSettleFixture = (scheduleId: string) => {
        tables.invoice.rows.push({
            id: "inv-settle", code: "INV-SETTLE", projectId: "project-1", estimateId: null,
            status: "Issued", totalAmount: 100, balanceDue: 100,
        });
        tables.paymentSchedule.rows.push({
            id: scheduleId, invoiceId: "inv-settle", name: "Swept milestone", amount: 100,
            status: "Pending", sourceScheduleId: null,
        });
    };

    await t.test("a bank row in qbo_created suppresses, with no opt from the caller", async () => {
        seedSettleFixture("sched-swept");
        tables.depositIngest.rows.push({
            id: "bank-inflight", fileId: bankFileId("REF-M3"), status: "qbo_created", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-M3", extracted: "{}", attempts: 1, amountCents: 10_000,
            postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-swept", updatedAt: new Date(),
        });

        const settled = await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-swept", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-from-sync", paidAt: new Date(), referenceNumber: "REF-M3",
        });
        assert.equal(settled, true);

        const notes = tables.paymentNotification.rows;
        assert.equal(notes.length, 1);
        assert.equal(notes[0].suppressClientReceipt, true, "the sync path must not email a receipt for a swept credit");
    });

    await t.test("an ordinary milestone still notifies normally", async () => {
        seedSettleFixture("sched-ordinary");
        const settled = await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-ordinary", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-ordinary", paidAt: new Date(), referenceNumber: "1234",
        });
        assert.equal(settled, true);
        assert.equal(tables.paymentNotification.rows.length, 1);
        assert.notEqual(tables.paymentNotification.rows[0].suppressClientReceipt, true);
    });

    await t.test("undo-and-repay: a FINISHED sweep does not silence a later, unrelated payment", async () => {
        // The bug: suppressing on "any applied bank row for this schedule"
        // means the client never gets a receipt again, for any future payment
        // on that milestone, because history never changes.
        seedSettleFixture("sched-repaid");
        tables.depositIngest.rows.push({
            id: "bank-old", fileId: bankFileId("REF-OLD"), status: "applied", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-OLD", extracted: "{}", attempts: 1, amountCents: 10_000,
            postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-repaid",
            qbPaymentId: "qb-payment-THE-OLD-ONE", updatedAt: new Date(),
        });

        await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-repaid", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-A-DIFFERENT-ONE", paidAt: new Date(), referenceNumber: "5678",
        });
        assert.notEqual(
            tables.paymentNotification.rows[0].suppressClientReceipt, true,
            "a new payment on the same milestone is a new event — the client hears about it",
        );
    });

    await t.test("…but the SAME payment still suppresses, whatever state the row reached", async () => {
        seedSettleFixture("sched-same-payment");
        tables.depositIngest.rows.push({
            id: "bank-done", fileId: bankFileId("REF-SAME"), status: "applied", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-SAME", extracted: "{}", attempts: 1, amountCents: 10_000,
            postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-same-payment",
            qbPaymentId: "qb-payment-THE-SWEPT-ONE", updatedAt: new Date(),
        });

        await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-same-payment", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-THE-SWEPT-ONE", paidAt: new Date(), referenceNumber: "REF-SAME",
        });
        assert.equal(tables.paymentNotification.rows[0].suppressClientReceipt, true);
    });

    await t.test("a sweep parked in RECONCILE is still the sweep's money", async () => {
        // It was missing from the status list, so the hourly recovery of a
        // reconcile-parked sweep payment emailed the client a receipt.
        seedSettleFixture("sched-reconcile");
        tables.depositIngest.rows.push({
            id: "bank-reconcile", fileId: bankFileId("REF-RECONCILE"), status: "reconcile", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-RECONCILE", extracted: "{}", attempts: 3, amountCents: 10_000,
            postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-reconcile", updatedAt: new Date(),
        });

        await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-reconcile", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-recovered", paidAt: new Date(), referenceNumber: "REF-RECONCILE",
        });
        assert.equal(tables.paymentNotification.rows[0].suppressClientReceipt, true);
    });

    await t.test("a merely PROCESSING bank row does not suppress — it has not touched the money", async () => {
        // A bank row is `processing` from the moment it is claimed, before any
        // match and before any QuickBooks request. If the client pays the
        // Intuit link in that window, that settle is NOT the sweep's and the
        // client must still get their receipt.
        seedSettleFixture("sched-merely-processing");
        tables.depositIngest.rows.push({
            id: "bank-processing", fileId: bankFileId("REF-PROCESSING"), status: "processing", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-PROCESSING", extracted: "{}", attempts: 1, amountCents: 10_000,
            postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-merely-processing",
            processingStartedAt: new Date(), updatedAt: new Date(),
        });

        await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-merely-processing", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-from-the-client", paidAt: new Date(), referenceNumber: "9999",
        });
        assert.notEqual(
            tables.paymentNotification.rows[0].suppressClientReceipt, true,
            "an unrelated payment must not lose its receipt to a sweep that had not started",
        );
    });

    await t.test("…but once the sweep has reached QuickBooks, it does", async () => {
        seedSettleFixture("sched-at-qbo");
        tables.depositIngest.rows.push({
            id: "bank-at-qbo", fileId: bankFileId("REF-AT-QBO"), status: "qbo_unknown", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-AT-QBO", extracted: "{}", attempts: 1, amountCents: 10_000,
            postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-at-qbo",
            qbRequestPayload: "{}", processingStartedAt: new Date(), updatedAt: new Date(),
        });

        await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-at-qbo", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-recovered", paidAt: new Date(), referenceNumber: "REF-AT-QBO",
        });
        assert.equal(tables.paymentNotification.rows[0].suppressClientReceipt, true);
    });

    await t.test("a TERMINAL-but-unmatched bank row does not suppress — it owns nothing", async () => {
        seedSettleFixture("sched-released");
        tables.depositIngest.rows.push({
            id: "bank-released", fileId: bankFileId("REF-M3-RELEASED"), status: "unmatched", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-M3-RELEASED", extracted: "{}", attempts: 1, amountCents: 10_000,
            postDate: utc(SETTLED_DAY), paymentScheduleId: "sched-released", updatedAt: new Date(),
        });
        await settleMilestoneFromQBPayment({
            paymentScheduleId: "sched-released", invoiceId: "inv-settle",
            qbPaymentId: "qb-payment-released", paidAt: new Date(), referenceNumber: "1234",
        });
        assert.notEqual(tables.paymentNotification.rows[0].suppressClientReceipt, true);
    });
});

test("M2 (round 2): a credit left in qbo_created — a REAL payment awaiting recovery — fails the batch", async () => {
    // The residual hole: settleAndFinalize persists qbo_created (the QuickBooks
    // payment EXISTS) and then throws on the settle. That comes back as a
    // per-credit `qbo_created`, which no named bucket counted, so the batch
    // still answered ok:true and the runner logged a healthy day over a payment
    // nobody had finished applying.
    seedMilestone({ amount: 11111.11 });
    const realSettle = fakeQuickbooksPayments.settleMilestoneFromQBPayment;
    fakeQuickbooksPayments.settleMilestoneFromQBPayment = async () => { throw new Error("settle blew up after the QBO payment existed"); };
    try {
        const { res, body } = await post(bankBatch([{ ref: "REF-QBO-CREATED", amount: 11111.11 }]));
        assert.equal(res.status, 200);
        assert.equal(creditResult(body, "REF-QBO-CREATED").status, "qbo_created");
        assert.equal(body.counts.unresolved, 1, "the catch-all must count it");
        assert.equal(body.counts.applied, 0);
        assert.equal(body.ok, false, "a batch holding an unfinished QuickBooks payment is NOT a clean run");
        // The buckets still partition the batch.
        const { credits: total, replay: _replay, ...buckets } = body.counts as Record<string, number>;
        assert.equal(Object.values(buckets).reduce((a, b) => a + b, 0), total);
    } finally {
        fakeQuickbooksPayments.settleMilestoneFromQBPayment = realSettle;
    }

    // …and the row itself is left recoverable, holding the real payment.
    const row = depositRow("REF-QBO-CREATED")!;
    assert.equal(row.status, "qbo_created");
    assert.ok(row.qbPaymentId, "the QuickBooks payment id is preserved for the resume");
});

test("P0: a credit that is not a customer deposit NEVER books, even at the exact amount", async t => {
    await t.test("an owner/interest/transfer credit at a requested amount files for a human", async () => {
        // The dangerous case: money in that is not a customer payment, landing
        // on the exact cents of a requested milestone.
        const milestone = seedMilestone({ amount: 25000 });
        const { body } = await post(bankBatch([{
            ref: "REF-OWNER", amount: 25000, bai: "165", description: "ACH CREDIT", detail: "OWNER CONTRIBUTION",
        }]));

        const result = creditResult(body, "REF-OWNER");
        assert.equal(result.status, "unmatched");
        assert.match(String(result.reason), /not a customer deposit class \(ACH CREDIT \/ OWNER CONTRIBUTION\)/);
        assert.equal(calls.buildQBPaymentRequest.length, 0, "no QuickBooks call at all");
        assert.equal(tables.paymentSchedule.rows.find(r => r.id === milestone)!.status, "Pending");
        assert.ok(result.officeTaskId, "it LOOKS like a payment, so a human is asked");
    });

    await t.test("the same credit at an amount nobody is owed is filed silently", async () => {
        seedMilestone({ amount: 25000 });
        const { body } = await post(bankBatch([{
            ref: "REF-INTEREST", amount: 3.17, bai: "165", description: "INTEREST PAID", detail: "INTEREST",
        }]));

        const result = creditResult(body, "REF-INTEREST");
        assert.equal(result.status, "unmatched");
        assert.match(String(result.reason), /not a customer deposit class/);
        assert.equal(result.officeTaskId, null, "routine interest must not become a task every single day");
        assert.equal(tables.officeTask.rows.length, 0);
    });

    await t.test("…and the daily replay does not resurrect the task it declined to file", async () => {
        seedMilestone({ amount: 25000 });
        const batch = bankBatch([{ ref: "REF-INTEREST", amount: 3.17, bai: "165", description: "INTEREST PAID", detail: "INTEREST" }]);
        await post(batch);
        const { body } = await post(batch);
        assert.equal(creditResult(body, "REF-INTEREST").status, "unmatched");
        assert.equal(tables.officeTask.rows.length, 0, "a quiet row stays quiet on every replay");
    });

    await t.test("a mobile deposit IS a customer deposit and applies", async () => {
        const milestone = seedMilestone({ amount: 4242.42 });
        const { body } = await post(bankBatch([{
            ref: "REF-MOBILE", amount: 4242.42, detail: "MOBILE D 2343776286",
        }]));
        const result = creditResult(body, "REF-MOBILE");
        assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
        assert.equal(result.scheduleId, milestone);
    });
});

test("P1: a `proposed` row survives a long shadow run without inventing a reconcile", async () => {
    // Every daily POST re-evaluates a proposed row. Counting those as retries
    // turned a clean dry-run credit into a fabricated `reconcile` incident on
    // the ninth day — an incident report for a credit that never failed.
    seedMilestone({ amount: 5959.59 });
    const batch = bankBatch([{ ref: "REF-SHADOW", amount: 5959.59 }], { dryRun: true });

    for (let day = 1; day <= 12; day++) {
        const { body } = await post(batch);
        const result = creditResult(body, "REF-SHADOW");
        assert.equal(result.status, "proposed", `day ${day}: ${result.reason}`);
    }
    const row = depositRow("REF-SHADOW")!;
    assert.equal(row.status, "proposed");
    assert.equal(row.attempts, 1, "twelve re-evaluations consumed no retry budget");
    assert.equal(tables.officeTask.rows.length, 0, "and filed no incident");
});

test("P0: with the live-apply switch OFF, a perfect amount-only match is SUGGESTED, not booked", async () => {
    delete process.env[LIVE_APPLY_ENV_VAR];
    const milestone = seedMilestone({ amount: 6161.61 });

    const { body } = await post(bankBatch([{ ref: "REF-SUGGEST", amount: 6161.61 }]));
    const result = creditResult(body, "REF-SUGGEST");
    assert.equal(result.status, "proposed", `expected suggest-only, got ${result.status}: ${result.reason}`);
    // The reason has to say plainly what happened, what did NOT happen to the
    // money, and what a human can do about it: this is the line they act on.
    assert.match(
        String(result.reason),
        /phase not corroborated by any daily log or inspection; no payment was booked; set DEPOSIT_SWEEP_LIVE_APPLY=true to book amount-only matches/,
    );
    assert.match(
        String(result.reason),
        /no daily log mentioning|no distinctive words/,
        "and explains what it looked for, or why it could not look",
    );
    assert.equal(calls.buildQBPaymentRequest.length, 0, "no money boundary is touched at all");
    assert.equal(depositRow("REF-SUGGEST")!.paymentScheduleId, milestone, "the suggestion is recorded");
    assert.equal(tables.paymentSchedule.rows.find(r => r.id === milestone)!.status, "Pending");
});

test("P0: with the switch ON, the same credit books", async () => {
    process.env[LIVE_APPLY_ENV_VAR] = "true";
    const milestone = seedMilestone({ amount: 6161.61 });

    const { body } = await post(bankBatch([{ ref: "REF-LIVE", amount: 6161.61 }]));
    const result = creditResult(body, "REF-LIVE");
    assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
    assert.equal(result.scheduleId, milestone);
});

test("P0: payer corroboration books even with the switch OFF", async () => {
    // A check image naming the customer is evidence, not an amount
    // coincidence, so it is not what the switch is guarding against.
    delete process.env[LIVE_APPLY_ENV_VAR];
    const milestone = seedMilestone({ amount: 6262.62, projectName: "Mesplay Kitchen", clientName: "Sandi Mesplay" });
    tables.bankImage.rows.push({
        id: "img-corroborated", source: "WTB_ONLINE", sourceExternalId: "REF-CORROBORATED:front", kind: "CHECK_FRONT",
        payerName: "Sandi Mesplay", memoText: "kitchen", normalizedCheckNumber: "1099",
        amountCents: 626_262, documentDate: utc(SETTLED_DAY),
    });

    const { body } = await post(bankBatch([{ ref: "REF-CORROBORATED", amount: 6262.62 }]));
    const result = creditResult(body, "REF-CORROBORATED");
    assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
    assert.equal(result.scheduleId, milestone);
});

test("P0: a wrong-payer check image is a conflict even with the switch ON", async () => {
    // Same deposit class, same amount, everything else valid — only the payer
    // disagrees. The switch must not be able to override that.
    process.env[LIVE_APPLY_ENV_VAR] = "true";
    const milestone = seedMilestone({ amount: 6363.63, projectName: "Mesplay Kitchen", clientName: "Sandi Mesplay" });
    tables.bankImage.rows.push({
        id: "img-wrong-payer", source: "WTB_ONLINE", sourceExternalId: "REF-WRONGPAYER:front", kind: "CHECK_FRONT",
        payerName: "Sandi Christensen", memoText: null, normalizedCheckNumber: "1100",
        amountCents: 636_363, documentDate: utc(SETTLED_DAY),
    });

    const { body } = await post(bankBatch([{ ref: "REF-WRONGPAYER", amount: 6363.63 }]));
    const result = creditResult(body, "REF-WRONGPAYER");
    assert.equal(result.status, "unmatched", "a named payer from another family must never book");
    assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
    assert.equal(tables.paymentSchedule.rows.find(r => r.id === milestone)!.status, "Pending");
});

test("P0: chronology — a milestone requested AFTER the deposit is not a candidate", async t => {
    await t.test("requested the day after the credit posted", async () => {
        const milestone = seedMilestone({ amount: 7171.71 });
        // Requested at 9am Pacific the day AFTER the money arrived.
        tables.paymentSchedule.rows.find(r => r.id === milestone)!.qbInvoiceSentAt =
            new Date(`${isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS)}T16:00:00.000Z`);

        const { body } = await post(bankBatch([{ ref: "REF-LATE", amount: 7171.71 }]));
        const result = creditResult(body, "REF-LATE");
        assert.equal(result.status, "unmatched");
        assert.match(String(result.reason), /milestone requested after the deposit/);
        assert.equal(calls.buildQBPaymentRequest.length, 0);
        assert.equal(tables.paymentSchedule.rows.find(r => r.id === milestone)!.status, "Pending");
    });

    await t.test("requested late on the credit's own day still counts", async () => {
        const milestone = seedMilestone({ amount: 7272.72 });
        // 4pm Pacific on the deposit's own day — before the day ends.
        tables.paymentSchedule.rows.find(r => r.id === milestone)!.qbInvoiceSentAt =
            new Date(`${SETTLED_DAY}T23:00:00.000Z`);

        const { body } = await post(bankBatch([{ ref: "REF-SAMEDAY", amount: 7272.72 }]));
        const result = creditResult(body, "REF-SAMEDAY");
        assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
        assert.equal(result.scheduleId, milestone);
    });
});

test("P0: a swept credit that needs a human but gets NO task is unresolved, not clean", async t => {
    await t.test("the task create throws", async () => {
        seedMilestone({ amount: 8181.81 });
        seedMilestone({ amount: 8181.81 }); // ambiguous → needs a human
        const realCreate = tables.officeTask.create;
        (tables.officeTask as Row).create = async () => { throw new Error("office board is on fire"); };
        try {
            const { body } = await post(bankBatch([{ ref: "REF-NOTASK", amount: 8181.81 }]));
            const result = creditResult(body, "REF-NOTASK");
            assert.equal(result.status, "reconcile", "an invisible review is not a finished one");
            assert.match(String(result.reason), /review task could not be filed/);
            assert.equal(body.counts.reconcile, 1);
            assert.equal(body.ok, false, "the runner must fail on it");
        } finally {
            (tables.officeTask as Row).create = realCreate;
        }
    });

    await t.test("no office board column is configured at all", async () => {
        tables.officeBoardColumn.rows = [];
        seedMilestone({ amount: 8282.82 });
        seedMilestone({ amount: 8282.82 });

        const { body } = await post(bankBatch([{ ref: "REF-NOBOARD", amount: 8282.82 }]));
        const result = creditResult(body, "REF-NOBOARD");
        assert.equal(result.status, "reconcile");
        assert.equal(body.ok, false);
        assert.equal(depositRow("REF-NOBOARD")!.status, "reconcile");
    });
});

test("P1: the preflight leaves an ACTIVE worker alone, and a cancelled one stops before QuickBooks", async t => {
    await t.test("a fresh PRE-BOUNDARY worker is cancelled, so both credits reach a human", async () => {
        // Leaving it running was wrong: it could still win its own
        // processing→qbo_unknown CAS and create a payment for a credit this
        // preflight had already ruled a collision.
        seedMilestone({ amount: 8383.83 });
        tables.depositIngest.rows.push({
            id: "row-busy", fileId: bankFileId("REF-BUSY"), status: "processing", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-BUSY", extracted: JSON.stringify({ fileId: bankFileId("REF-BUSY") }),
            attempts: 1, amountCents: 838_383, postDate: utc(SETTLED_DAY),
            processingStartedAt: new Date(), updatedAt: new Date(), // lease is FRESH
        });

        const { body } = await post(bankBatch([
            { ref: "REF-BUSY", amount: 8383.83 },
            { ref: "REF-OTHER", amount: 8383.83 },
        ]));

        for (const ref of ["REF-BUSY", "REF-OTHER"]) {
            assert.equal(creditResult(body, ref).status, "unmatched", `${ref} must go to a human`);
            assert.match(String(depositRow(ref)!.lastError), /different bank credits/);
        }
        assert.equal(depositRow("REF-BUSY")!.paymentScheduleId ?? null, null, "the cancelled worker releases its reservation");
        assert.equal(calls.sendQBPaymentCreateRequest.length, 0);
    });

    await t.test("a twin already PAST the boundary is left alone, and this credit is escalated", async () => {
        // That payment exists in QuickBooks and cannot be called back, so the
        // colliding credit is not merely unmatched — it is unresolved.
        seedMilestone({ amount: 8585.85 });
        tables.depositIngest.rows.push({
            id: "row-committed", fileId: bankFileId("REF-COMMITTED"), status: "qbo_created", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-COMMITTED", extracted: JSON.stringify({ fileId: bankFileId("REF-COMMITTED") }),
            attempts: 1, amountCents: 858_585, postDate: utc(SETTLED_DAY), qbPaymentId: "qb-payment-live",
            qbRequestPayload: "{}", paymentScheduleId: "sched-committed",
            processingStartedAt: new Date(), updatedAt: new Date(),
        });

        const { body } = await post(bankBatch([
            { ref: "REF-COMMITTED", amount: 8585.85 },
            { ref: "REF-TOOLATE", amount: 8585.85 },
        ]));

        assert.equal(depositRow("REF-COMMITTED")!.status, "qbo_created", "a committed payment is never yanked");
        assert.equal(depositRow("REF-COMMITTED")!.paymentScheduleId, "sched-committed", "…and keeps its reservation");
        const late = creditResult(body, "REF-TOOLATE");
        assert.equal(late.status, "reconcile", "the collision with a committed payment is unresolved money");
        assert.match(String(late.reason), /REF-COMMITTED has already reached QuickBooks/);
        assert.equal(body.ok, false);
    });

    await t.test("a row cancelled mid-flight stops at the money boundary with no QuickBooks call", async () => {
        const milestone = seedMilestone({ amount: 8484.84 });
        // The preflight of a LATER credit cancels this row while it is between
        // matching and the QuickBooks create.
        const realBuild = fakeQuickbooks.buildQBPaymentRequest;
        fakeQuickbooks.buildQBPaymentRequest = async (...args: unknown[]) => {
            const row = depositRow("REF-CANCELLED");
            if (row) row.status = "unmatched"; // someone else re-classified it
            return (realBuild as (...a: unknown[]) => unknown)(...args) as never;
        };
        try {
            const { body } = await post(bankBatch([{ ref: "REF-CANCELLED", amount: 8484.84 }]));
            assert.equal(calls.buildQBPaymentRequest.length, 1, "it got as far as building the request");
            assert.equal(calls.sendQBPaymentCreateRequest.length, 0, "…and stopped before creating the payment");
            assert.notEqual(creditResult(body, "REF-CANCELLED").status, "applied");
            assert.equal(tables.paymentSchedule.rows.find(r => r.id === milestone)!.status, "Pending");
            assert.equal(depositRow("REF-CANCELLED")!.qbRequestPayload ?? null, null, "no request body was persisted");
        } finally {
            fakeQuickbooks.buildQBPaymentRequest = realBuild;
        }
    });
});

test("B1: a COLLISION that cannot file its task is unresolved too, not a quiet unmatched", async t => {
    await t.test("the preflight's own task create fails", async () => {
        seedMilestone({ amount: 9191.91 });
        // Fail ONLY the two preflight creates, then let the board recover. If
        // the preflight ignored its own failure, the per-credit loop's healer
        // would quietly file the task a moment later and the batch would answer
        // a clean `unmatched` — so a test that fails every create cannot tell
        // the two implementations apart. This one can.
        const realCreate = tables.officeTask.create;
        let failuresLeft = 2;
        (tables.officeTask as Row).create = async (args: { data: Row }) => {
            if (failuresLeft-- > 0) throw new Error("office board is on fire");
            return realCreate.call(tables.officeTask, args);
        };
        try {
            const { body } = await post(bankBatch([
                { ref: "REF-COLL-A", amount: 9191.91 },
                { ref: "REF-COLL-B", amount: 9191.91 },
            ]));
            for (const ref of ["REF-COLL-A", "REF-COLL-B"]) {
                const result = creditResult(body, ref);
                assert.equal(result.status, "reconcile", `${ref}: an invisible collision review is not a finished one`);
                assert.equal(depositRow(ref)!.status, "reconcile");
                assert.match(String(depositRow(ref)!.lastError), /review task could not be filed/);
            }
            assert.equal(body.counts.reconcile, 2);
            assert.equal(body.counts.unmatched, 0);
            assert.equal(body.ok, false, "the runner must fail on it");
        } finally {
            (tables.officeTask as Row).create = realCreate;
        }
    });

    await t.test("a replay that still cannot file the task keeps saying so", async () => {
        // The daily re-POST used to answer a clean `unmatched` forever for a
        // review nobody could see.
        seedMilestone({ amount: 9292.92 });
        tables.depositIngest.rows.push({
            id: "row-taskless", fileId: bankFileId("REF-TASKLESS"), status: "unmatched", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-TASKLESS", extracted: JSON.stringify({ fileId: bankFileId("REF-TASKLESS"), amount: 9292.92 }),
            attempts: 1, amountCents: 929_292, postDate: utc(SETTLED_DAY),
            lastError: "2 milestones match", officeTaskId: null, updatedAt: new Date(),
        });
        const realCreate = tables.officeTask.create;
        (tables.officeTask as Row).create = async () => { throw new Error("still on fire"); };
        try {
            const { body } = await post(bankBatch([{ ref: "REF-TASKLESS", amount: 9292.92 }]));
            const result = creditResult(body, "REF-TASKLESS");
            assert.equal(result.status, "reconcile");
            assert.equal(body.ok, false);
        } finally {
            (tables.officeTask as Row).create = realCreate;
        }
    });
});

test("R7: a reused bank reference carrying DIFFERENT money is a human's problem", async t => {
    await t.test("the same credit twice is a replay", async () => {
        seedMilestone({ amount: 1234.56 });
        const batch = bankBatch([{ ref: "REF-FP", amount: 1234.56 }]);
        assert.equal(creditResult((await post(batch)).body, "REF-FP").status, "applied");
        const second = await post(batch);
        assert.equal(creditResult(second.body, "REF-FP").status, "applied");
        assert.equal(creditResult(second.body, "REF-FP").alreadyApplied, true);
        assert.equal(calls.sendQBPaymentCreateRequest.length, 1);
    });

    await t.test("the same reference with a different amount is NOT", async () => {
        seedMilestone({ amount: 2345.67 });
        seedMilestone({ amount: 9999.99 });
        await post(bankBatch([{ ref: "REF-REUSED", amount: 2345.67 }]));
        const paymentsAfterFirst = calls.sendQBPaymentCreateRequest.length;

        const { body } = await post(bankBatch([{ ref: "REF-REUSED", amount: 9999.99 }]));
        const result = creditResult(body, "REF-REUSED");
        assert.equal(result.status, "reconcile");
        assert.match(String(result.reason), /bank reference reused with different data/);
        assert.equal(body.ok, false, "unresolved: the runner must fail");
        assert.ok(result.officeTaskId, "and a human is asked");
        assert.equal(calls.sendQBPaymentCreateRequest.length, paymentsAfterFirst, "no second payment");
    });

    await t.test("a cosmetic re-render of the same credit is still a replay", async () => {
        seedMilestone({ amount: 3456.78 });
        await post(bankBatch([{ ref: "REF-COSMETIC", amount: 3456.78 }]));
        const { body } = await post(bankBatch([{ ref: "REF-COSMETIC", amount: 3456.78, detail: "deposit -  dda/mmkt " }]));
        assert.equal(creditResult(body, "REF-COSMETIC").status, "applied");
        assert.equal(creditResult(body, "REF-COSMETIC").alreadyApplied, true);
    });
});

test("R8: every bank row records what it was, including collision rows", async t => {
    await t.test("a collision-created row carries its fingerprint", async () => {
        seedMilestone({ amount: 4321.99 });
        await post(bankBatch([
            { ref: "REF-CF-A", amount: 4321.99 },
            { ref: "REF-CF-B", amount: 4321.99 },
        ]));
        for (const ref of ["REF-CF-A", "REF-CF-B"]) {
            // Asserted on what create() was GIVEN: the legacy backfill would
            // otherwise repair a missing stamp a moment later and hide the bug.
            assert.ok(
                createdFingerprint.get(bankFileId(ref)),
                `${ref} must record the credit it was created from, at creation`,
            );
            assert.ok(depositRow(ref)!.bankFingerprint);
        }

        // …so reusing one of those references for different money is caught,
        // instead of reading as a clean replay of a row that recorded nothing.
        seedMilestone({ amount: 1111.11 });
        const { body } = await post(bankBatch([{ ref: "REF-CF-A", amount: 1111.11 }]));
        const result = creditResult(body, "REF-CF-A");
        assert.equal(result.status, "reconcile");
        assert.match(String(result.reason), /bank reference reused with different data/);
    });

    await t.test("a legacy row with no fingerprint is backfilled when the facts agree", async () => {
        const milestone = seedMilestone({ amount: 2222.22 });
        tables.depositIngest.rows.push({
            id: "legacy-row", fileId: bankFileId("REF-LEGACY"), status: "proposed", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-LEGACY", extracted: JSON.stringify({ fileId: bankFileId("REF-LEGACY"), amount: 2222.22 }),
            attempts: 1, amountCents: 222_222, postDate: utc(SETTLED_DAY),
            bankFingerprint: null, updatedAt: new Date(),
        });

        const { body } = await post(bankBatch([{ ref: "REF-LEGACY", amount: 2222.22 }]));
        const result = creditResult(body, "REF-LEGACY");
        assert.equal(result.status, "applied", `the legacy row is the same credit: ${result.reason}`);
        assert.equal(result.scheduleId, milestone);
        assert.ok(depositRow("REF-LEGACY")!.bankFingerprint, "and it now records what it was");
    });

    await t.test("a legacy row whose stored facts DISAGREE is not a replay", async () => {
        seedMilestone({ amount: 3333.33 });
        tables.depositIngest.rows.push({
            id: "legacy-mismatch", fileId: bankFileId("REF-LEGACY-BAD"), status: "applied", source: BANK_DEPOSIT_SOURCE,
            bankReference: "REF-LEGACY-BAD", extracted: "{}", attempts: 1,
            amountCents: 999_999, postDate: utc(SETTLED_DAY), // a DIFFERENT amount
            bankFingerprint: null, updatedAt: new Date(),
        });

        const { body } = await post(bankBatch([{ ref: "REF-LEGACY-BAD", amount: 3333.33 }]));
        const result = creditResult(body, "REF-LEGACY-BAD");
        assert.equal(result.status, "reconcile");
        assert.match(String(result.reason), /an unrecorded credit/);
        assert.equal(body.ok, false);
    });
});

test("R7: the claim domain is SERIALIZED — the advisory lock is taken before the claim query", async t => {
    await t.test("on the bank path", async () => {
        seedMilestone({ amount: 4567.89 });
        await post(bankBatch([{ ref: "REF-LOCK", amount: 4567.89 }]));

        const lockIndex = callLog.findIndex(entry => entry.startsWith("SQL:") && entry.includes("pg_advisory_xact_lock"));
        const claimIndex = callLog.indexOf("CLAIM_QUERY");
        assert.ok(lockIndex >= 0, `no advisory lock was taken: ${callLog.join(" | ")}`);
        assert.ok(claimIndex >= 0, "the claim query never ran");
        assert.ok(lockIndex < claimIndex, "the lock must precede the read, or two writers can both pass the check");
        // Keyed on the amount — the only thing the two sources share.
        assert.match(callLog[lockIndex], /deposit-claim:456789/);
    });

    await t.test("and on the photo path", async () => {
        tables.project.rows.push({ id: "project-1", name: "Hoppe Hall Bath", client: { name: "Hoppe" } });
        seedMilestone({ amount: 5678.90, requested: false, projectName: "Hoppe Hall Bath" });

        const { body } = await post({
            fileId: "drive-photo-lock", projectName: "Hoppe Hall Bath", amount: 5678.90,
            checkDate: SETTLED_DAY, checkNumber: "7777", payerName: "Hoppe",
        });
        assert.equal(body.status, "applied", `photo leg failed: ${body.reason}`);

        const lockIndex = callLog.findIndex(entry => entry.startsWith("SQL:") && entry.includes("pg_advisory_xact_lock"));
        const claimIndex = callLog.indexOf("CLAIM_QUERY");
        assert.ok(lockIndex >= 0 && claimIndex >= 0 && lockIndex < claimIndex, `lock ${lockIndex} claim ${claimIndex}`);
        assert.match(callLog[lockIndex], /deposit-claim:567890/);
    });
});

test("R7: job progress unlocks auto-apply without the switch (Justin's daily-log rule)", async t => {
    const hoppe = () => {
        delete process.env[LIVE_APPLY_ENV_VAR]; // the switch stays OFF throughout
        return seedMilestone({
            amount: 13447.68, name: "Rough In complete", invoiceCode: "INV-00173",
            projectName: "Hoppe Hall Bath", clientName: "Hoppe",
        });
    };

    await t.test("an inspection passed three days before the credit → books", async () => {
        const milestone = hoppe();
        tables.inspection.rows.push({
            id: "insp-1", projectId: "project-1", result: "PASSED", type: "Rough-in plumbing",
            performedDate: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 4)), scheduledDate: null,
        });

        const { body } = await post(bankBatch([{ ref: "REF-INSPECTED", amount: 13447.68 }]));
        const result = creditResult(body, "REF-INSPECTED");
        assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
        assert.equal(result.scheduleId, milestone);
    });

    await t.test("a daily log naming the phase → books", async () => {
        const milestone = hoppe();
        tables.dailyLog.rows.push({
            id: "log-1", projectId: "project-1", date: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 2)),
            workPerformed: "Completed rough plumbing; inspector walked the rough-in",
        });

        const { body } = await post(bankBatch([{ ref: "REF-LOGGED", amount: 13447.68 }]));
        const result = creditResult(body, "REF-LOGGED");
        assert.equal(result.status, "applied", `expected applied, got ${result.status}: ${result.reason}`);
        assert.equal(result.scheduleId, milestone);
    });

    await t.test("no logs and no inspection → suggest-only", async () => {
        hoppe();
        const { body } = await post(bankBatch([{ ref: "REF-NOEVIDENCE", amount: 13447.68 }]));
        const result = creditResult(body, "REF-NOEVIDENCE");
        assert.equal(result.status, "proposed");
        assert.match(String(result.reason), /phase not corroborated by any daily log or inspection; no payment was booked/);
        assert.match(String(result.reason), /no daily log mentioning "rough"/);
        assert.equal(calls.buildQBPaymentRequest.length, 0);
    });

    await t.test("a log about a DIFFERENT phase → suggest-only", async () => {
        hoppe();
        tables.dailyLog.rows.push({
            id: "log-2", projectId: "project-1", date: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 2)),
            workPerformed: "Hung drywall in the hall bath and taped the corners",
        });

        const { body } = await post(bankBatch([{ ref: "REF-WRONGPHASE", amount: 13447.68 }]));
        assert.equal(creditResult(body, "REF-WRONGPHASE").status, "proposed");
        assert.equal(calls.buildQBPaymentRequest.length, 0);
    });

    await t.test("an inspection on ANOTHER project does not corroborate this one", async () => {
        hoppe();
        tables.inspection.rows.push({
            id: "insp-other", projectId: "project-elsewhere", result: "PASSED", type: "Rough-in",
            performedDate: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 4)), scheduledDate: null,
        });

        const { body } = await post(bankBatch([{ ref: "REF-OTHERPROJECT", amount: 13447.68 }]));
        assert.equal(creditResult(body, "REF-OTHERPROJECT").status, "proposed");
    });

    await t.test("an inspection of a DIFFERENT PHASE on the right project does not either", async () => {
        hoppe();
        tables.inspection.rows.push({
            id: "insp-wrongphase", projectId: "project-1", result: "PASSED", type: "Final electrical",
            performedDate: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 4)), scheduledDate: null,
        });

        const { body } = await post(bankBatch([{ ref: "REF-WRONGPHASE-INSP", amount: 13447.68 }]));
        const result = creditResult(body, "REF-WRONGPHASE-INSP");
        assert.equal(result.status, "proposed", `a final-electrical sign-off is not rough-in: ${result.reason}`);
        assert.equal(calls.buildQBPaymentRequest.length, 0);
    });

    await t.test("a log with the token buried in another word does not either", async () => {
        hoppe();
        tables.dailyLog.rows.push({
            id: "log-textile", projectId: "project-1", date: utc(isoDaysAgo(BANK_APPLY_MIN_AGE_DAYS + 2)),
            workPerformed: "Roughly framed the soffit; textile samples delivered",
        });

        const { body } = await post(bankBatch([{ ref: "REF-SUBSTRING", amount: 13447.68 }]));
        assert.equal(creditResult(body, "REF-SUBSTRING").status, "proposed");
    });
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
    assert.deepEqual(body.counts, {
        credits: 3, applied: 1, proposed: 0, unmatched: 2, reconcile: 0, failed: 0, qboUnknown: 0, unresolved: 0, replay: 0,
    });
    assert.equal(body.ok, true, "two credits sent to a human is still a clean batch");
});
