import { test } from "node:test";
import assert from "node:assert/strict";

test('unknown delivery cannot be sent again after a new Pacific day and certified cycle', async () => {
    const rows=seed(emptyRows());
    const first=depsFor(rows,{post:async()=>({kind:'unknown',reason:'timeout'})}).deps;
    const digest=await prepare(rows);
    assert.equal((await runOnDemand({action:'apply',bankLineId:BANKLINE,digest},first,{allowedTargets:[BANKLINE]})).kind,'unknown');
    assert.equal(rows.cards[0].status,'UNCERTAIN');
    const tomorrow=new Date(NOW.getTime()+86_400_000);
    rows.settings.set('receiptRequestsPhase',JSON.stringify({phase:'done',chaserCompletedAt:tomorrow.toISOString(),completedCycleId:CYCLE_ID}));
    rows.settings.set('bankRegisterPullLastSuccess',tomorrow.toISOString());
    const second=depsFor(rows,{clock:()=>tomorrow,post:async()=>{throw Error('second send forbidden');}}).deps;
    const result=await runOnDemand({action:'prepare',bankLineId:BANKLINE},second,{allowedTargets:[BANKLINE]});
    assert.equal(result.kind,'blocked'); assert.equal(rows.cards.length,1);
    const snap=await second.readSnapshot(BANKLINE);
    assert.equal((await second.claim(snap,computeOnDemandDigest(snap,tomorrow))).kind,'blocked');
});

test('history CAS loss rolls back POSTED while retaining the signing issue', async () => {
    const rows=seed(emptyRows()); const {deps}=depsFor(rows);
    const snap=await deps.readSnapshot(BANKLINE); const claim=await deps.claim(snap,await prepare(rows));
    assert.equal(claim.kind,'claimed'); rows.failHistory=true;
    const result=await deps.finish(claim as Extract<ClaimResult,{kind:'claimed'}>,{kind:'delivered',threadName:THREAD,messageName:MESSAGE});
    assert.equal(result.kind,'failed'); assert.equal(rows.cards[0].status,'POSTING');
    assert.equal(rows.issues.get(ISSUE_ID)!.version,VERSION);
});


// No inherited credentials, network, or production database in this suite.
process.env.DATABASE_URL = "postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true";
process.env.RECEIPTS_CHAT_WEBHOOK = "https://chat.googleapis.com/v1/spaces/SYNTHSPACE/messages?key=k&token=t";
process.env.RECEIPT_OWNER_CHAT_USERS = JSON.stringify({Justin:"users/555000111"});
process.env.RECEIPT_ON_DEMAND_TARGETS = "null";
delete process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED;
globalThis.fetch = async () => { throw Error("NETWORK DENIED in isolated test"); };

import { createOnDemandDeps } from "../src/lib/receipt-on-demand-store";
import {
    runOnDemand, computeOnDemandDigest,
    type OnDemandDeps,
    type FinishResult,
    type PreparedSnapshot,
    type ClaimResult,
} from "../src/lib/receipt-on-demand";
import type { CardItem } from "../src/lib/receipt-request-cards";

const BANKLINE = "3f2b7c1a-9d4e-4a11-8f7b-2c8e6d1a0b93";
const ISSUE_ID = "issue_synth_0001";
const FP = `pb-${BANKLINE}`;
const CENTS = 12_345;
const POSTED = "2026-01-10";
const DAY = "2026-01-12";
const NOW = new Date("2026-01-12T14:30:00.000Z");
const WEBHOOK = process.env.RECEIPTS_CHAT_WEBHOOK as string;
const SPACE = "spaces/SYNTHSPACE";
const THREAD = `${SPACE}/threads/t1`;
const MESSAGE = `${SPACE}/messages/m1`;
const LEDGER = "41";
const EVIDENCE = "19";
const VERSION = 7;
const RAW = "POS DEB 1432 01/10/26 12345678 C#4321 CHEVRON 0093121 VANCOUVER WA";
const CYCLE_ID = "cyc_synth_0001";
const POLICY = "receipt-source-v1:off";
const FINGERPRINT = "absent";

interface Rows {
    settings: Map<string, string>;
    bankLines: Map<string, Record<string, unknown>>;
    issues: Map<string, Record<string, unknown>>;
    cards: Array<Record<string, unknown>>;
    deliveries: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    locks: string[];
    failDelivery?: boolean;
    failHistory?: boolean;
}

function emptyRows(): Rows {
    return {
        settings: new Map(),
        bankLines: new Map(),
        issues: new Map(),
        cards: [],
        deliveries: [],
        artifacts: [], locks: [],
    };
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function seed(rows: Rows): Rows {
    rows.settings.set("bankLedgerEpoch", LEDGER);
    rows.settings.set("receiptEvidenceEpoch", EVIDENCE);
    rows.settings.set("bankRegisterPullLastSuccess", NOW.toISOString());
    rows.settings.set("receiptRequestsPhase", JSON.stringify({
        phase: "done", chaserCompletedAt: NOW.toISOString(), blockedReason: null, completedCycleId: CYCLE_ID,
    }));
    rows.settings.set("receiptRequestsCycle", JSON.stringify({ id: CYCLE_ID, epoch: LEDGER, evidenceEpoch: EVIDENCE, recognitionPolicy: POLICY }));
    rows.bankLines.set(BANKLINE, {
        id: BANKLINE, account: "WTB-0723", sourceOfRecord: "STATEMENT", state: "POSTED",
        amountCents: -CENTS, postedDate: new Date(`${POSTED}T00:00:00.000Z`),
        rawDescriptor: RAW, checkNumber: null, updatedAt: new Date("2026-01-11T22:03:11.000Z"),
        qbTxnId: null, probuildExpenseId: null,
        observations: [{
            id: "obs_1", account: "WTB-0723", bankLineId: BANKLINE, sourceDocumentId: "doc_1",
            sourceLineId: "line_1", postedDate: new Date(`${POSTED}T00:00:00.000Z`),
            amountCents: -CENTS, rawDescriptor: RAW, checkNumber: null,
            statementImport: { id: "doc_1", account: "WTB-0723", status: "FINALIZED", contentHash: "a".repeat(64) },
        }],
    });
    rows.issues.set(ISSUE_ID, {
        id: ISSUE_ID, targetKey: BANKLINE, targetType: "bank-line", version: VERSION,
        clearedAt: null, reasonCodes: JSON.stringify(["MISSING_RECEIPT"]), acknowledgedCodes: JSON.stringify([]),
        displayDetails: JSON.stringify({
            payee: "Chevron", fingerprint: FP, owner: "Justin",
            postedDate: POSTED, amountCents: -CENTS, cardTail: "4321",
        }),
    });
    return rows;
}

function financeCalls(): Record<string, () => never> {
    const boom = () => { throw new Error("finance fake must not be called"); };
    return {
        receiptIntake: boom as never,
        expense: boom as never, email: boom as never, financial: boom as never,
    };
}

function makeDb(rows: Rows): { db: unknown; commits: number; rollbacks: number } {
    const state = { commits: 0, rollbacks: 0 };
    const matches = (row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean => {
        if (!where) return true;
        return Object.entries(where).every(([k, v]) => {
            if (v && typeof v === "object" && "in" in (v as object)) {
                return (v as { in: unknown[] }).in.includes(row[k]);
            }
            return row[k] === v;
        });
    };
    const settingSelect = (args: { where?: { key?: unknown } }) => {
        const keys = args.where?.key;
        if (keys && typeof keys === "object" && "in" in keys) {
            const list = (keys as { in: string[] }).in;
            return list.map(key => rows.settings.has(key) ? { key, value: rows.settings.get(key)! } : null).filter(Boolean);
        }
        if (typeof keys === "string") {
            return rows.settings.has(keys) ? [{ key: keys, value: rows.settings.get(keys)! }] : [];
        }
        return [];
    };
    const buildClient = (tx: boolean): unknown => ({
        automationSetting: {
            findMany: async (args: { where?: { key?: unknown } }) => clone(settingSelect(args ?? {})),
            findUnique: async (args: { where: { key: string } }) => {
                const key = args.where.key;
                return rows.settings.has(key) ? clone({ key, value: rows.settings.get(key)! }) : null;
            },
        },
        bankLine: {
            findUnique: async (args: { where: { id: string } }) => {
                const row = rows.bankLines.get(args.where.id);
                if (!row) return null;
                if (!tx) return clone(row);
                return row;
            },
        },
        reviewIssue: {
            updateMany: async (args: {where:Record<string,unknown>;data:Record<string,unknown>}) => {
                if (rows.failHistory) return {count:0};
                let count=0;
                for (const row of rows.issues.values()) {
                    if (!matches(row,args.where)) continue;
                    for (const [key,value] of Object.entries(args.data)) row[key] = value && typeof value==='object' && 'increment' in value ? Number(row[key])+Number((value as {increment:number}).increment) : value;
                    count++;
                }
                return {count};
            },
            findUnique: async (args: { where: { id?: string; targetType_targetKey?: { targetType: string; targetKey: string } } }) => {
                if (args.where.targetType_targetKey) {
                    const key = args.where.targetType_targetKey.targetKey;
                    for (const row of rows.issues.values()) {
                        if (row.targetKey === key) return clone(row);
                    }
                    return null;
                }
                const row = rows.issues.get(args.where.id as string);
                return row ? clone(row) : null;
            },
        },
        receiptMemoArtifact: {
            findFirst: async (args: { where: { targetKey: string } }) =>
                clone(rows.artifacts.find(a => a.targetKey === args.where.targetKey) ?? null),
        },
        receiptRequestCard: {
            findMany: async () => clone(rows.cards.filter(c => c.owner === "Justin").slice(0,51)),
            findUnique: async (args: { where: { owner_pacificDate?: { owner: string; pacificDate: string }; id?: string } }) => {
                if (args.where.owner_pacificDate) {
                    const { owner, pacificDate } = args.where.owner_pacificDate;
                    const row = rows.cards.find(c => c.owner === owner && c.pacificDate === pacificDate);
                    return row ? clone(row) : null;
                }
                const row = rows.cards.find(c => c.id === args.where.id);
                return row ? clone(row) : null;
            },
            create: async (args: { data: Record<string, unknown> }) => {
                const id = `card_${rows.cards.length + 1}`;
                rows.cards.push({ id, threadName: null, messageName: null, postedAt: null, lastError: null, attempts: 0, ...args.data });
                return { id };
            },
            updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                let count = 0;
                for (const row of rows.cards) {
                    if (!matches(row, args.where)) continue;
                    Object.assign(row, args.data);
                    count++;
                }
                return { count };
            },
        },
        receiptRequestCardDelivery: {
            findUnique: async (args: { where: { owner_deliveryDay: { owner: string; deliveryDay: string } } }) => {
                const { owner, deliveryDay } = args.where.owner_deliveryDay;
                const row = rows.deliveries.find(d => d.owner === owner && d.deliveryDay === deliveryDay);
                return row ? { id: row.id } : null;
            },
            create: async (args: { data: Record<string, unknown> }) => {
                if (rows.failDelivery) throw Object.assign(Error("synthetic collision"),{code:"P2002"});
                for (const d of rows.deliveries) {
                    if (d.owner === args.data.owner && d.deliveryDay === args.data.deliveryDay) {
                        const err = new Error("unique");
                        (err as { code?: string }).code = "P2002";
                        throw err;
                    }
                }
                rows.deliveries.push({ id: `del_${rows.deliveries.length + 1}`, ...args.data });
                return { id: `del_${rows.deliveries.length}` };
            },
        },
        $executeRaw: async () => { rows.locks.push("evidence-lock"); },
        $queryRaw: async (query: TemplateStringsArray | string, ...values: unknown[]) => {
            const sql = typeof query === "string" ? query : query.join("?");
            if (sql.includes("AutomationSetting")) rows.locks.push(values[0] === "receiptEvidenceEpoch" ? "evidence-epoch" : "bank-epoch");
            if (sql.includes("BankLine") && sql.includes("FOR UPDATE")) rows.locks.push("bank-row");
            if (sql.includes("ReviewIssue") && sql.includes("FOR UPDATE")) rows.locks.push("issue-row");
            if (sql.includes("AutomationSetting") && sql.includes("SELECT")) {
                const key = String(values[0]);
                if (key === "receiptEvidenceEpoch") {
                    return rows.settings.has(key) ? [{ value: rows.settings.get(key) }] : [];
                }
            }
            if (sql.includes("BankLine") && sql.includes("FOR UPDATE")) return [{ id: values[0] }];
            if (sql.includes("ReviewIssue") && sql.includes("FOR UPDATE")) return [{ id: values[0] }];
            if (sql.includes("AutomationSetting")) {
                const key = String(values[0]);
                const value = rows.settings.get(key) ?? "0";
                rows.settings.set(key, value);
                return [{ value }];
            }
            return [];
        },
    });

    const db = {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
            const working = clone(rows);
            const txClient = buildClient(true);
            const proxy = new Proxy(txClient as object, {
                get(target, prop) {
                    if (prop === "automationSetting" || prop === "bankLine" || prop === "reviewIssue"
                        || prop === "receiptMemoArtifact" || prop === "receiptRequestCard" || prop === "receiptRequestCardDelivery") {
                        const original = (target as Record<string, unknown>)[prop as string] as Record<string, unknown>;
                        const bound: Record<string, unknown> = {};
                        for (const [name, fn] of Object.entries(original)) bound[name] = fn;
                        return (target as Record<string, unknown>)[prop as string];
                    }
                    return (target as Record<string, unknown>)[prop as string];
                },
            });
            // Swap the working row store in for the duration of the transaction.
            const saved = {
                settings: rows.settings, bankLines: rows.bankLines, issues: rows.issues,
                cards: rows.cards, deliveries: rows.deliveries, artifacts: rows.artifacts,
            };
            rows.settings = working.settings;
            rows.bankLines = working.bankLines;
            rows.issues = working.issues;
            rows.cards = working.cards;
            rows.deliveries = working.deliveries;
            rows.artifacts = working.artifacts;
            try {
                const result = await fn(proxy);
                state.commits++;
                return result;
            } catch (error) {
                rows.settings = saved.settings;
                rows.bankLines = saved.bankLines;
                rows.issues = saved.issues;
                rows.cards = saved.cards;
                rows.deliveries = saved.deliveries;
                rows.artifacts = saved.artifacts;
                state.rollbacks++;
                throw error;
            }
        },
        automationSetting: (buildClient(false) as { automationSetting: unknown }).automationSetting,
        bankLine: (buildClient(false) as { bankLine: unknown }).bankLine,
        reviewIssue: (buildClient(false) as { reviewIssue: unknown }).reviewIssue,
        receiptMemoArtifact: (buildClient(false) as { receiptMemoArtifact: unknown }).receiptMemoArtifact,
        receiptRequestCard: (buildClient(false) as { receiptRequestCard: unknown }).receiptRequestCard,
        receiptRequestCardDelivery: (buildClient(false) as { receiptRequestCardDelivery: unknown }).receiptRequestCardDelivery,
        $executeRaw: (buildClient(false) as { $executeRaw: unknown }).$executeRaw,
        $queryRaw: (buildClient(false) as { $queryRaw: unknown }).$queryRaw,
        ...financeCalls(),
    };
    return { db, commits: 0, rollbacks: 0 };
}

function depsFor(
    rows: Rows,
    overrides: {
        loadTruth?: (ids: string[], deps?: unknown) => Promise<Map<string, unknown>>;
        post?: (card: unknown, url: string, timeoutMs: number) => Promise<FinishResult | { kind: "unknown"; reason: string }>;
        clock?: () => Date;
        config?: { allowedTargets?: unknown; webhookUrl?: string };
    } = {},
): { deps: OnDemandDeps; rows: Rows } {
    const { db } = makeDb(rows);
    const truth = overrides.loadTruth ?? (async (ids: string[]) => {
        const out = new Map<string, unknown>();
        for (const id of ids) {
            const issue = rows.issues.get(id);
            out.set(id, {
                clearedAt: issue?.clearedAt ?? null,
                acknowledged: false,
                resolved: false,
                evidenceSatisfied: false,
                owner: "Justin",
            });
        }
        return out;
    });
    const deps = createOnDemandDeps({
        db: db as never,
        clock: overrides.clock ?? (() => NOW),
        config: {
            allowedTargets: overrides.config?.allowedTargets ?? [BANKLINE],
            webhookUrl: overrides.config?.webhookUrl ?? WEBHOOK,
            env: { ...process.env, RECEIPT_OWNER_CHAT_USERS: JSON.stringify({ Justin: "users/555000111" }) } as NodeJS.ProcessEnv,
        },
        loadTruth: (truth as never),
    }) as OnDemandDeps;
    deps.post = (overrides.post ?? (async () => { throw Error("unexpected post in test"); })) as OnDemandDeps["post"];
    return { deps, rows };
}

async function prepare(rows: Rows, overrides: Parameters<typeof depsFor>[1] = {}) {
    const { deps } = depsFor(rows, overrides);
    const out = await runOnDemand({ action: "prepare", bankLineId: BANKLINE }, deps, { allowedTargets: [BANKLINE], now: () => NOW });
    assert.equal(out.kind, "ready", `expected ready, got ${JSON.stringify(out)}`);
    return (out as Extract<typeof out, { kind: "ready" }>).digest;
}

// ── Snapshot read ────────────────────────────────────────────────────────────

test("readSnapshot returns a canonical snapshot with the real issue id", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const snap: PreparedSnapshot = await deps.readSnapshot(BANKLINE);
    assert.equal(snap.account, "WTB-0723");
    assert.equal(snap.sourceOfRecord, "STATEMENT");
    assert.equal(snap.debitCents, CENTS);
    assert.equal(snap.postedDate, POSTED);
    assert.equal(snap.rawDescriptor, RAW);
    assert.equal(snap.owner, "Justin");
    assert.equal(snap.ownerUser, "users/555000111");
    assert.equal(snap.item.issueId, ISSUE_ID);
    assert.equal(snap.item.fingerprint, FP);
    assert.equal(snap.item.cents, CENTS);
    assert.equal(snap.item.amount, "123.45");
    assert.equal(snap.item.cardTail, "4321");
    assert.equal(snap.epochs.ledger, LEDGER);
    assert.equal(snap.epochs.evidence, EVIDENCE);
    assert.equal(snap.policy, POLICY);
    assert.equal(snap.sweep.certified, true);
    assert.equal(snap.sweep.fresh, true);
    assert.equal(snap.sweep.evidenceEligible, true);
    assert.equal(snap.flags.sourceFound, false);
});

test("readSnapshot invokes loadTruth with the actual issue id and honours sourceFound refusal", async () => {
    const rows = seed(emptyRows());
    const seen: string[] = [];
    const { deps } = depsFor(rows, {
        loadTruth: async (ids: string[]) => {
            seen.push(...ids);
            const out = new Map<string, unknown>();
            for (const id of ids) out.set(id, {
                clearedAt: null, acknowledged: false, resolved: false, evidenceSatisfied: true, owner: "Justin",
            });
            return out;
        },
    });
    const snap = await deps.readSnapshot(BANKLINE);
    assert.deepEqual(seen, [ISSUE_ID]);
    assert.equal(snap.flags.sourceFound, true);
});

test("readSnapshot throws when loadTruth returns nothing for the issue", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows, { loadTruth: async () => new Map<string, unknown>() });
    await assert.rejects(async () => { await deps.readSnapshot(BANKLINE); }, /evidence-incomplete/);
});

test("readSnapshot throws when the evidence epoch drifts during truth load", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows, {
        loadTruth: async (ids: string[]) => {
            rows.settings.set("receiptEvidenceEpoch", "20");
            const out = new Map<string, unknown>();
            for (const id of ids) out.set(id, {
                clearedAt: null, acknowledged: false, resolved: false, evidenceSatisfied: false, owner: "Justin",
            });
            return out;
        },
    });
    await assert.rejects(async () => { await deps.readSnapshot(BANKLINE); }, /source-moved/);
});

test("source-found refusal: missing evidence still throws even with a valid snapshot", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows, {
        loadTruth: async (ids: string[]) => {
            const out = new Map<string, unknown>();
            for (const id of ids) out.set(id, {
                clearedAt: null, acknowledged: false, resolved: false, evidenceSatisfied: false, owner: "Justin",
            });
            return out;
        },
    });
    const snap = await deps.readSnapshot(BANKLINE);
    assert.equal(snap.flags.sourceFound, false);
});

// ── Claim transaction ────────────────────────────────────────────────────────

test("claim takes evidence lock, evidence epoch, bank epoch, canonical row, then issue row", async () => {
    const rows=seed(emptyRows()); const {deps}=depsFor(rows);
    const snap=await deps.readSnapshot(BANKLINE);
    const result=await deps.claim(snap, await prepare(rows));
    assert.equal(result.kind,"claimed");
    assert.deepEqual(rows.locks.slice(0,5),["evidence-lock","evidence-epoch","bank-epoch","bank-row","issue-row"]);
});

test("claim returns blocked when the evidence epoch drifts under lock", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    rows.settings.set("receiptEvidenceEpoch", "99");
    const result = await deps.claim(snap, "0".repeat(64));
    assert.equal(result.kind, "blocked");
    assert.equal((result as { reason: string }).reason, "epoch-drift");
});

test("claim returns blocked when the bank ledger epoch drifts under lock", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    rows.settings.set("bankLedgerEpoch", "999");
    const result = await deps.claim(snap, "0".repeat(64));
    assert.equal(result.kind, "blocked");
    assert.equal((result as { reason: string }).reason, "epoch-drift");
});

test("claim returns source-drift when the issue version moves between reads", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    rows.issues.get(ISSUE_ID)!.version = VERSION + 1;
    const result = await deps.claim(snap, digest);
    assert.equal(result.kind, "blocked");
    assert.equal((result as { reason: string }).reason, "source-drift");
    assert.equal(rows.cards.length, 0);
    assert.equal(rows.deliveries.length, 0);
});

test("claim succeeds and writes a POSTING card plus the delivery reservation", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    const result = await deps.claim(snap, digest);
    assert.equal(result.kind, "claimed");
    assert.equal(rows.cards.length, 1);
    assert.equal(rows.cards[0].status, "POSTING");
    assert.equal(rows.cards[0].owner, "Justin");
    assert.equal(rows.cards[0].pacificDate, DAY);
    assert.equal(rows.deliveries.length, 1);
    assert.equal(rows.deliveries[0].owner, "Justin");
    assert.equal(rows.deliveries[0].deliveryDay, DAY);
});

test("claim returns already-posted only for an exact POSTED history match", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const card: CardItem[] = [{
        n: 1, fingerprint: FP, date: POSTED, vendor: "Chevron", cents: CENTS, amount: "123.45",
        cardTail: "4321", issueId: ISSUE_ID, targetKey: BANKLINE,
    }];
    rows.cards.push({
        id: "card_prev", owner: "Justin", pacificDate: DAY, itemsJson: JSON.stringify(card),
        overflow: 0, overflowExact: true, status: "POSTED", postedAt: NOW.toISOString(),
        threadName: THREAD, messageName: MESSAGE, lastError: null, attempts: 1,
    });
    rows.issues.get(ISSUE_ID)!.displayDetails = JSON.stringify({
        payee: "Chevron", fingerprint: FP, owner: "Justin", postedDate: POSTED, amountCents: -CENTS,
        cardTail: "4321",
        cards: [{ threadName: THREAD, messageName: MESSAGE, n: 1, date: DAY, requestId: `receipt-req-Justin-${DAY}` }],
    });
    const snap = await deps.readSnapshot(BANKLINE);
    const result = await deps.claim(snap, computeOnDemandDigest(snap,NOW));
    assert.equal(result.kind, "already-posted");
    assert.equal((result as { threadName: string }).threadName, THREAD);
    assert.equal((result as { messageName: string }).messageName, MESSAGE);
});

test("claim refuses to reuse an existing day card that is not an exact POSTED history match", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    rows.cards.push({
        id: "card_prev", owner: "Justin", pacificDate: DAY, itemsJson: "[]",
        overflow: 0, overflowExact: true, status: "POSTED", postedAt: NOW.toISOString(),
        threadName: THREAD, messageName: MESSAGE, lastError: null, attempts: 1,
    });
    const snap = await deps.readSnapshot(BANKLINE);
    const result = await deps.claim(snap, digest);
    assert.equal(result.kind, "blocked");
    assert.equal((result as { reason: string }).reason, "existing-day-card");
});

test("claim refuses a pre-existing delivery reservation for the day", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    rows.deliveries.push({ id: "del_old", owner: "Justin", deliveryDay: DAY, cardId: "card_old" });
    const snap = await deps.readSnapshot(BANKLINE);
    const result = await deps.claim(snap, digest);
    assert.equal(result.kind, "blocked");
    assert.equal((result as { reason: string }).reason, "day-reserved");
    assert.equal(rows.cards.length, 0);
});

test("claim race loser leaves no partial card or delivery row", async () => {
    const rows = seed(emptyRows());
    rows.cards.push({
        id: "card_winner", owner: "Justin", pacificDate: DAY, itemsJson: "[]",
        overflow: 0, overflowExact: true, status: "POSTING", claimedAt: NOW.toISOString(),
        claimToken: "tok", postedAt: null, threadName: null, messageName: null, lastError: null, attempts: 0,
    });
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    const result = await deps.claim(snap, digest);
    assert.equal(result.kind, "blocked");
    assert.equal(rows.cards.filter(c => c.status === "POSTING").length, 1);
    assert.equal(rows.deliveries.length, 0);
});

// ── Finish transaction ──────────────────────────────────────────────────────

test("finish records POSTED with the exact thread and writes history atomically", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    const claimed = await deps.claim(snap, digest);
    assert.equal(claimed.kind, "claimed");
    const result = await deps.finish(claimed as Extract<ClaimResult, { kind: "claimed" }>, {
        kind: "delivered", threadName: THREAD, messageName: MESSAGE,
    });
    assert.equal(result.kind, "recorded");
    assert.equal(rows.cards[0].status, "POSTED");
    assert.equal(rows.cards[0].threadName, THREAD);
    assert.equal(rows.cards[0].messageName, MESSAGE);
    const details = JSON.parse(rows.issues.get(ISSUE_ID)!.displayDetails as string);
    assert.equal(Array.isArray(details.cards) && details.cards.length, 1);
    assert.equal(details.cards[0].threadName, THREAD);
    assert.equal(details.cards[0].requestId, `receipt-req-Justin-${DAY}`);
    assert.equal(rows.issues.get(ISSUE_ID)!.version, VERSION + 1);
});

test("finish rolls back POSTED when the issue disappears before history", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    const claimed = await deps.claim(snap, digest);
    assert.equal(claimed.kind, "claimed");
    // The card is committed; blow away the issue so history cannot be recorded.
    rows.issues.delete(ISSUE_ID);
    const result = await deps.finish(claimed as Extract<ClaimResult, { kind: "claimed" }>, {
        kind: "delivered", threadName: THREAD, messageName: MESSAGE,
    });
    assert.equal(result.kind, "failed");
    assert.equal(rows.cards[0].status, "POSTING");
    assert.equal(rows.cards[0].threadName, null);
});

test("finish refuses an invalid provider space and leaves the row in POSTING", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    const claimed = await deps.claim(snap, digest);
    const wrongSpace = "spaces/OTHERSPACE/threads/t1";
    const wrongMsg = "spaces/OTHERSPACE/messages/m1";
    const result = await deps.finish(claimed as Extract<ClaimResult, { kind: "claimed" }>, {
        kind: "delivered", threadName: wrongSpace, messageName: wrongMsg,
    });
    assert.equal(result.kind, "failed");
    assert.equal(rows.cards[0].status, "POSTING");
});

test("finish records UNCERTAIN with no history on an unknown outcome", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows);
    const digest = await prepare(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    const claimed = await deps.claim(snap, digest);
    const result = await deps.finish(claimed as Extract<ClaimResult, { kind: "claimed" }>, {
        kind: "uncertain", reason: "provider-not-confirmed",
    });
    assert.equal(result.kind, "recorded");
    assert.equal(rows.cards[0].status, "UNCERTAIN");
    assert.equal(rows.cards[0].threadName, null);
    const details = JSON.parse(rows.issues.get(ISSUE_ID)!.displayDetails as string);
    assert.equal(details.cards, undefined);
});

// ── Atomic pair through the service ─────────────────────────────────────────

test("apply POSTS once, writes POSTED and history, and never calls a finance fake", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows, {post: async () => ({kind:"delivered",threadName:THREAD,messageName:MESSAGE})});
    const digest = await prepare(rows);
    const out = await runOnDemand(
        { action: "apply", bankLineId: BANKLINE, digest },
        deps,
        { allowedTargets: [BANKLINE], now: () => NOW },
    );
    assert.equal(out.kind, "posted", JSON.stringify(out));
    assert.equal(rows.cards[0].status, "POSTED");
    assert.equal(rows.deliveries.length, 1);
});

test("delivery reservation collision rolls back the newly created POSTING row", async () => {
    const rows=seed(emptyRows()); const {deps}=depsFor(rows);
    const digest=await prepare(rows); const snap=await deps.readSnapshot(BANKLINE);
    rows.failDelivery=true;
    const result=await deps.claim(snap,digest);
    assert.equal(result.kind,"blocked"); assert.equal(rows.cards.length,0); assert.equal(rows.deliveries.length,0);
});

test("a verified prior POSTED card returns its actual thread without another send", async () => {
    const rows = seed(emptyRows());
    rows.cards.push({
        id: "card_stale", owner: "Justin", pacificDate: DAY, itemsJson: JSON.stringify([{
            n: 1, fingerprint: FP, date: POSTED, vendor: "Chevron", cents: CENTS, amount: "123.45",
            cardTail: "4321", issueId: ISSUE_ID, targetKey: BANKLINE,
        }]),
        overflow: 0, overflowExact: true, status: "POSTED", postedAt: "2026-01-12T13:00:00.000Z",
        threadName: THREAD, messageName: MESSAGE, lastError: null, attempts: 1,
    });
    rows.issues.get(ISSUE_ID)!.displayDetails = JSON.stringify({
        payee: "Chevron", fingerprint: FP, owner: "Justin", postedDate: POSTED, amountCents: -CENTS, cardTail: "4321",
        cards: [{ threadName: THREAD, messageName: MESSAGE, n: 1, date: DAY, requestId: `receipt-req-Justin-${DAY}` }],
    });
    const { deps } = depsFor(rows);
    const digest = "0".repeat(64);
    const out = await runOnDemand(
        { action: "apply", bankLineId: BANKLINE, digest },
        deps,
        { allowedTargets: [BANKLINE], now: () => NOW },
    );
    assert.equal(out.kind, "posted");
    assert.equal(rows.cards.length, 1);
    assert.equal(rows.cards[0].id, "card_stale");
});

test("apply reports unknown and leaves POSTED untouched when the post throws", async () => {
    const rows = seed(emptyRows());
    const { deps } = depsFor(rows, {
        post: async () => { throw new Error("synthetic post timeout"); },
    });
    const digest = await prepare(rows);
    const out = await runOnDemand(
        { action: "apply", bankLineId: BANKLINE, digest },
        deps,
        { allowedTargets: [BANKLINE], now: () => NOW },
    );
    assert.equal(out.kind, "unknown");
    assert.equal(rows.cards[0].status, "UNCERTAIN");
    assert.equal(rows.deliveries.length, 1);
});

// ── Settings / policy drift ─────────────────────────────────────────────────

test("settings fingerprint refuses a phase-marker cycle id that no longer matches the current cycle", async () => {
    const rows = seed(emptyRows());
    rows.settings.set("receiptRequestsCycle", JSON.stringify({
        id: "cyc_other", epoch: LEDGER, evidenceEpoch: EVIDENCE, recognitionPolicy: POLICY,
    }));
    const { deps } = depsFor(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    assert.equal(snap.sweep.certified, false);
});

test("settings fingerprint refuses a phase marker whose completedCycleId is not the current cycle", async () => {
    const rows = seed(emptyRows());
    rows.settings.set("receiptRequestsPhase", JSON.stringify({
        phase: "done", chaserCompletedAt: NOW.toISOString(), blockedReason: null, completedCycleId: "cyc_stale",
    }));
    const { deps } = depsFor(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    assert.equal(snap.sweep.certified, false);
});

test("settings fingerprint refuses a cycle whose recorded recognition policy matches the off policy literal", async () => {
    const rows = seed(emptyRows());
    rows.settings.set("receiptRequestsCycle", JSON.stringify({
        id: CYCLE_ID, epoch: LEDGER, evidenceEpoch: EVIDENCE, recognitionPolicy: "receipt-source-v1:off",
    }));
    const { deps } = depsFor(rows);
    const snap = await deps.readSnapshot(BANKLINE);
    assert.equal(snap.policy, "receipt-source-v1:off");
    assert.equal(snap.sweep.certified, true);
    assert.notEqual(FINGERPRINT, "invalid");
});

test("settings fingerprint refuses a policy the cycle does not record when recognition is enabled", async () => {
    const rows = seed(emptyRows());
    rows.settings.set("receiptRequestsCycle", JSON.stringify({
        id: CYCLE_ID, epoch: LEDGER, evidenceEpoch: EVIDENCE, recognitionPolicy: "receipt-source-v2:on:deadbeef",
    }));
    process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED = "true";
    try {
        const { deps } = depsFor(rows);
        const snap = await deps.readSnapshot(BANKLINE);
        assert.equal(snap.sweep.certified, false);
    } finally {
        delete process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED;
    }
});
