import assert from "node:assert/strict";
import test from "node:test";
import {
    STALE_RECONCILE_PLAN,
    pairStillMatches,
    guardAndLinkObservation,
    lockBankLineIdentity,
    toExpectedSnapshot,
    type ExpectedMatchKey,
    type GuardTxClient,
    type GuardedReconcileLink,
} from "../src/lib/bank-reconcile-guard";
import { normalizePayee, reconcileObservations } from "../src/lib/bank-ledger";

interface ObsRow { id: string; account: string; source: string; bankLineId: string | null; amountCents: number; rawDescriptor: string | null; checkNumber: string | null; postedDate: string }
interface LineRow { id: string; account: string; amountCents: number; normalizedPayee: string; checkNumber: string | null; postedDate: string }

function fakeTx(state: { obs: ObsRow | null; line: LineRow | null; claimed?: boolean }) {
    const calls: { kind: string; sql?: string; args?: unknown }[] = [];
    const tx = {
        $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => { calls.push({ kind: "exec", sql: s.join("?"), args: v }); },
        $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => {
            const sql = s.join("?");
            calls.push({ kind: "query", sql, args: v });
            if (sql.includes('FROM "BankLineObservation"') && sql.includes("FOR UPDATE")) return state.obs ? [state.obs] : [];
            if (sql.includes('FROM "BankLine"') && sql.includes("FOR UPDATE")) return state.line ? [state.line] : [];
            if (sql.includes('"bankLineId" =')) return state.claimed ? [{ id: "other" }] : [];
            return [];
        },
        bankLineObservation: {
            updateMany: async (args: { where: { id: string; bankLineId: null }; data: { bankLineId: string } }) => {
                calls.push({ kind: "update", args });
                if (state.obs && state.obs.id === args.where.id && state.obs.bankLineId === null) { state.obs.bankLineId = args.data.bankLineId; return { count: 1 }; }
                return { count: 0 };
            },
        },
    };
    return { calls, tx: tx as unknown as GuardTxClient };
}

const key: ExpectedMatchKey = { account: "WTB-0723", postedDate: "2026-09-02", amountCents: -12345, normalizedPayee: normalizePayee("HOME DEPOT #1234"), checkNumber: null };
function obs(overrides: Partial<ObsRow> = {}): ObsRow {
    return { id: "obs-1", account: key.account, source: "QBO_REGISTER", bankLineId: null, amountCents: key.amountCents, rawDescriptor: "HOME DEPOT #1234", checkNumber: null, postedDate: key.postedDate, ...overrides };
}
function line(overrides: Partial<LineRow> = {}): LineRow {
    return { id: "bl-1", account: key.account, amountCents: key.amountCents, normalizedPayee: key.normalizedPayee, checkNumber: null, postedDate: key.postedDate, ...overrides };
}
function link(overrides: Partial<GuardedReconcileLink> = {}): GuardedReconcileLink {
    return { observationId: "obs-1", bankLineId: "bl-1", expectedObservation: toExpectedSnapshot(key), expectedBankLine: toExpectedSnapshot(key), ...overrides } as GuardedReconcileLink;
}

test("reconcile guard: unchanged pair is locked FOR UPDATE, re-verified, and linked", async () => {
    const state = { obs: obs(), line: line() };
    const { tx, calls } = fakeTx(state);
    assert.deepEqual(await guardAndLinkObservation(tx, link()), { ok: true });
    assert.equal(state.obs.bankLineId, "bl-1");
    const forUpdate = calls.filter(c => c.kind === "query" && c.sql?.includes("FOR UPDATE"));
    assert.equal(forUpdate.length, 2, "both rows locked before the write");
    assert.ok(calls.findIndex(c => c.kind === "update") > calls.findIndex(c => c.sql?.includes('"bankLineId" =')), "claim check precedes the CAS");
});

test("reconcile guard: an observation whose descriptor moved after planning is refused as a stale plan", async () => {
    const state = { obs: obs({ rawDescriptor: "CHEVRON 0123" }), line: line() };
    const { tx, calls } = fakeTx(state);
    assert.deepEqual(await guardAndLinkObservation(tx, link()), { ok: false, reason: STALE_RECONCILE_PLAN });
    assert.equal(state.obs.bankLineId, null);
    assert.equal(calls.some(c => c.kind === "update"), false);
});

test("reconcile guard: an observation whose date was refreshed after planning is refused", async () => {
    const state = { obs: obs({ postedDate: "2026-09-03" }), line: line() };
    const { tx } = fakeTx(state);
    assert.deepEqual(await guardAndLinkObservation(tx, link()), { ok: false, reason: STALE_RECONCILE_PLAN });
    assert.equal(state.obs.bankLineId, null);
});

test("reconcile guard: a candidate whose payee or amount moved after planning is refused", async () => {
    for (const moved of [line({ normalizedPayee: "lowes" }), line({ amountCents: -12346 })]) {
        const state = { obs: obs(), line: moved };
        const { tx } = fakeTx(state);
        assert.deepEqual(await guardAndLinkObservation(tx, link()), { ok: false, reason: STALE_RECONCILE_PLAN });
        assert.equal(state.obs.bankLineId, null);
    }
});

test("reconcile guard: already-linked observation and already-claimed candidate are refused, no stale link", async () => {
    const linked = { obs: obs({ bankLineId: "bl-elsewhere" }), line: line() };
    assert.deepEqual(await guardAndLinkObservation(fakeTx(linked).tx, link()), { ok: false, reason: "observation-already-linked" });
    assert.equal(linked.obs.bankLineId, "bl-elsewhere");

    const claimed = { obs: obs(), line: line(), claimed: true };
    assert.deepEqual(await guardAndLinkObservation(fakeTx(claimed).tx, link()), { ok: false, reason: "bank-line-already-claimed" });
    assert.equal(claimed.obs.bankLineId, null);
});

test("reconcile guard: a link without expected snapshots fails closed; a vanished row fails closed", async () => {
    const state = { obs: obs(), line: line() };
    const { tx, calls } = fakeTx(state);
    assert.deepEqual(await guardAndLinkObservation(tx, { observationId: "obs-1", bankLineId: "bl-1" }), { ok: false, reason: STALE_RECONCILE_PLAN });
    assert.equal(calls.length, 0, "no queries at all without a snapshot");
    assert.deepEqual(await guardAndLinkObservation(fakeTx({ obs: null, line: line() }).tx, link()), { ok: false, reason: STALE_RECONCILE_PLAN });
});

test("reconcile guard: identity lock is a transaction-scoped advisory lock", async () => {
    const { tx, calls } = fakeTx({ obs: null, line: null });
    await lockBankLineIdentity(tx);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql ?? "", /pg_advisory_xact_lock/);
});


test("reconcile guard preserves planner check-number rules including asymmetric nulls", () => {
    for (const left of [null, "101", "102"]) for (const right of [null, "101", "102"]) {
        const observation = { ...key, id: "obs-1", bankLineId: null, checkNumber: left };
        const candidate = { ...key, id: "bl-1", checkNumber: right };
        const planned = reconcileObservations([observation], [candidate]);
        assert.equal(pairStillMatches(observation, candidate), planned.links.length === 1, `check ${left} / ${right}`);
    }
});

test("reconcile guard accepts unchanged deterministic duplicate pairings", async () => {
    const observations = ["obs-b", "obs-a"].map((id, i) => ({ ...key, id, bankLineId: null, qbTxnId: i === 0 ? "20" : "10" }));
    const candidates = ["bl-b", "bl-a"].map(id => ({ ...key, id }));
    const planned = reconcileObservations(observations, candidates);
    assert.equal(planned.pairedByOrder.length, 1);
    assert.equal(planned.links.length, 2);
    const linked = new Set<string>();
    for (const pair of planned.links) {
        const state = { obs: obs({ id: pair.observationId }), line: line({ id: pair.bankLineId }) };
        const result = await guardAndLinkObservation(fakeTx(state).tx, { ...pair, expectedObservation: key, expectedBankLine: key });
        assert.deepEqual(result, { ok: true });
        assert.equal(state.obs.bankLineId, pair.bankLineId);
        linked.add(pair.bankLineId);
    }
    assert.equal(linked.size, 2);
});
