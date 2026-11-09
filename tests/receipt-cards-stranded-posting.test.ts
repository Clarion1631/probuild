/**
 * A card row stranded in POSTING (the run died between the POSTING write and
 * the Chat response) must be converted to UNCERTAIN by a sweep that runs on any
 * day and ignores the per-owner delivery-day skip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.DATABASE_URL ??= "postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true";
process.env.NEXTAUTH_SECRET ??= "fiction-not-a-real-secret";

import { CLAIM_LEASE_MS, convertStrandedPostingCards } from "../src/app/api/cron/receipt-request-cards/route";
import { CARD_OWNERS_ASKED } from "../src/lib/receipt-request-cards";

const NOW = new Date("2026-11-10T14:30:00Z");
const routePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-request-cards/route.ts");

interface Row {
    id: string;
    owner: string;
    pacificDate: string;
    status: string;
    postedAt: Date | null;
    claimedAt: Date | null;
    claimToken: string | null;
    lastError: string | null;
}

const row = (over: Partial<Row> & { id: string }): Row => ({
    owner: "CJ",
    pacificDate: "2026-11-10",
    status: "POSTING",
    postedAt: null,
    claimedAt: new Date(NOW.getTime() - 3 * CLAIM_LEASE_MS),
    claimToken: "tok",
    lastError: null,
    ...over,
});

/** Evaluates exactly the where-shapes the helper uses. */
function matches(r: Row, where: any): boolean {
    if (where.id !== undefined && r.id !== where.id) return false;
    if (where.status !== undefined && r.status !== where.status) return false;
    if (where.owner?.in && !where.owner.in.includes(r.owner)) return false;
    if (where.postedAt === null && r.postedAt !== null) return false;
    if (where.OR) {
        const ok = where.OR.some((c: any) => {
            if (c.claimedAt === null) return r.claimedAt === null;
            if (c.claimedAt?.lt) return r.claimedAt !== null && r.claimedAt.getTime() < c.claimedAt.lt.getTime();
            return false;
        });
        if (!ok) return false;
    }
    return true;
}

function fakeDb(rows: Row[], opts: { loseCas?: boolean; throwOnId?: string; throwFind?: boolean } = {}) {
    const updates: Array<{ where: any; data: any }> = [];
    return {
        rows,
        updates,
        db: {
            receiptRequestCard: {
                async findMany(args: { where: any }) {
                    if (opts.throwFind) throw new Error("find boom");
                    return rows.filter(r => matches(r, args.where)).map(r => ({ id: r.id, owner: r.owner, pacificDate: r.pacificDate }));
                },
                async updateMany(args: { where: any; data: any }) {
                    updates.push(args);
                    if (opts.throwOnId !== undefined && args.where.id === opts.throwOnId) throw new Error("update boom");
                    if (opts.loseCas) return { count: 0 };
                    let count = 0;
                    for (const r of rows) {
                        if (matches(r, args.where)) { Object.assign(r, args.data); count++; }
                    }
                    return { count };
                },
            },
        },
    };
}

test("an earlier day's POSTING row with a dead claim becomes UNCERTAIN and is returned", async () => {
    const f = fakeDb([row({ id: "old", pacificDate: "2026-11-06" })]);
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out, { converted: [{ id: "old", owner: "CJ", pacificDate: "2026-11-06" }], failed: 0 });
    assert.equal(f.rows[0].status, "UNCERTAIN");
    assert.equal(f.rows[0].lastError, "uncertain-delivery");
    assert.equal(f.rows[0].claimedAt, null);
    assert.equal(f.rows[0].claimToken, null);
});

test("today's POSTING row with a dead claim is converted (the same-day case the owner loop skips)", async () => {
    const f = fakeDb([row({ id: "today", claimedAt: null })]);
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out.converted.map(r => r.id), ["today"]);
    assert.equal(f.rows[0].status, "UNCERTAIN");
});

test("a POSTING row whose claim is inside the lease is left alone", async () => {
    const f = fakeDb([row({ id: "live", claimedAt: new Date(NOW.getTime() - CLAIM_LEASE_MS + 1_000) })]);
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out, { converted: [], failed: 0 });
    assert.equal(f.rows[0].status, "POSTING");
    assert.equal(f.rows[0].claimToken, "tok");
    assert.equal(f.updates.length, 0);
});

test("PENDING, UNCERTAIN and POSTED rows are never touched, nor is a POSTING row with postedAt set", async () => {
    const f = fakeDb([
        row({ id: "p", status: "PENDING" }),
        row({ id: "u", status: "UNCERTAIN" }),
        row({ id: "d", status: "POSTED", postedAt: NOW }),
        row({ id: "ps", status: "POSTING", postedAt: NOW }),
    ]);
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out, { converted: [], failed: 0 });
    assert.deepEqual(f.rows.map(r => r.status), ["PENDING", "UNCERTAIN", "POSTED", "POSTING"]);
    assert.equal(f.updates.length, 0);
});

test("a lost compare-and-set is not returned", async () => {
    const f = fakeDb([row({ id: "race" })], { loseCas: true });
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out, { converted: [], failed: 0 });
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].where.status, "POSTING");
    assert.equal(f.updates[0].where.postedAt, null);
});

test("an on-demand row (owner Justin) with a dead claim is NOT converted", async () => {
    const f = fakeDb([row({ id: "od", owner: "Justin" })]);
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out, { converted: [], failed: 0 });
    assert.equal(f.rows[0].status, "POSTING");
    assert.equal(f.updates.length, 0);
});

test("the lease boundary: exactly now - lease is left alone, 1 ms older is converted", async () => {
    const edge = fakeDb([row({ id: "edge", claimedAt: new Date(NOW.getTime() - CLAIM_LEASE_MS) })]);
    assert.deepEqual(await convertStrandedPostingCards(edge.db as never, NOW), { converted: [], failed: 0 });
    assert.equal(edge.rows[0].status, "POSTING");
    const past = fakeDb([row({ id: "past", claimedAt: new Date(NOW.getTime() - CLAIM_LEASE_MS - 1) })]);
    assert.deepEqual((await convertStrandedPostingCards(past.db as never, NOW)).converted.map(r => r.id), ["past"]);
    assert.equal(past.rows[0].status, "UNCERTAIN");
});

test("the compare-and-set where carries the dead-claim OR and the owner filter", async () => {
    const f = fakeDb([row({ id: "cas" })]);
    await convertStrandedPostingCards(f.db as never, NOW);
    assert.equal(f.updates.length, 1);
    const where = f.updates[0].where;
    assert.equal(where.id, "cas");
    assert.deepEqual(where.owner, { in: CARD_OWNERS_ASKED });
    assert.deepEqual(where.OR, [{ claimedAt: null }, { claimedAt: { lt: new Date(NOW.getTime() - CLAIM_LEASE_MS) } }]);
});

test("handleGET sweeps after the enabled gate and before the weekday check, and every early return carries it", () => {
    const source = readFileSync(routePath, "utf8");
    const gate = source.indexOf('RECEIPT_REQUEST_CARDS_ENABLED !== "true"');
    const call = source.indexOf("await convertStrandedPostingCards(");
    const weekday = source.indexOf("isPacificWeekday(now)");
    assert.ok(gate > 0 && call > 0 && weekday > 0);
    assert.ok(gate < call, "the sweep must come after the enabled gate");
    assert.ok(call < weekday, "the sweep must come before the weekday check");
    assert.match(source, /\[cron\/receipt-request-cards\] stranded-posting/);
    assert.ok(source.split("...strandedBody").length - 1 >= 6, "every early return after the sweep spreads strandedBody");
});

test("a failing updateMany for the second row does not lose the first and third conversions", async () => {
    const f = fakeDb([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })], { throwOnId: "b" });
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out.converted.map(r => r.id), ["a", "c"]);
    assert.equal(out.failed, 1);
    assert.deepEqual(f.rows.map(r => r.status), ["UNCERTAIN", "POSTING", "UNCERTAIN"]);
});

test("a failing findMany rejects (the caller handles it)", async () => {
    const f = fakeDb([row({ id: "a" })], { throwFind: true });
    await assert.rejects(convertStrandedPostingCards(f.db as never, NOW));
});

test("source pins: strandedSweepFailed reaches the heartbeat predicate, strandedBody and the final summary", () => {
    const source = readFileSync(routePath, "utf8");
    const isFailure = source.slice(source.indexOf("isFailure: body =>"));
    assert.match(isFailure.split(/\r?\n/)[0], /body\.strandedSweepFailed === true/);
    const strandedBody = source.slice(source.indexOf("const strandedBody"), source.indexOf("const strandedBody") + 900);
    assert.match(strandedBody, /strandedSweepFailed: true/);
    const summary = source.slice(source.indexOf("ok: failures.length === 0"));
    assert.match(summary.slice(0, 400), /strandedSweepFailed \? \{ strandedSweepFailed: true \} : \{\}/);
});
