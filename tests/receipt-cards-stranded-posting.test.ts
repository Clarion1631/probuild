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

import { convertStrandedPostingCards } from "../src/app/api/cron/receipt-request-cards/route";

const CLAIM_LEASE_MS = 10 * 60_000;
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

function fakeDb(rows: Row[], opts: { loseCas?: boolean } = {}) {
    const updates: Array<{ where: any; data: any }> = [];
    return {
        rows,
        updates,
        db: {
            receiptRequestCard: {
                async findMany(args: { where: any }) {
                    return rows.filter(r => matches(r, args.where)).map(r => ({ id: r.id, owner: r.owner, pacificDate: r.pacificDate }));
                },
                async updateMany(args: { where: any; data: any }) {
                    updates.push(args);
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
    assert.deepEqual(out, [{ id: "old", owner: "CJ", pacificDate: "2026-11-06" }]);
    assert.equal(f.rows[0].status, "UNCERTAIN");
    assert.equal(f.rows[0].lastError, "uncertain-delivery");
    assert.equal(f.rows[0].claimedAt, null);
    assert.equal(f.rows[0].claimToken, null);
});

test("today's POSTING row with a dead claim is converted (the same-day case the owner loop skips)", async () => {
    const f = fakeDb([row({ id: "today", claimedAt: null })]);
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out.map(r => r.id), ["today"]);
    assert.equal(f.rows[0].status, "UNCERTAIN");
});

test("a POSTING row whose claim is inside the lease is left alone", async () => {
    const f = fakeDb([row({ id: "live", claimedAt: new Date(NOW.getTime() - CLAIM_LEASE_MS + 1_000) })]);
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out, []);
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
    assert.deepEqual(out, []);
    assert.deepEqual(f.rows.map(r => r.status), ["PENDING", "UNCERTAIN", "POSTED", "POSTING"]);
    assert.equal(f.updates.length, 0);
});

test("a lost compare-and-set is not returned", async () => {
    const f = fakeDb([row({ id: "race" })], { loseCas: true });
    const out = await convertStrandedPostingCards(f.db as never, NOW);
    assert.deepEqual(out, []);
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].where.status, "POSTING");
    assert.equal(f.updates[0].where.postedAt, null);
});

test("handleGET runs the sweep before the per-owner loop", () => {
    const source = readFileSync(routePath, "utf8");
    const call = source.indexOf("await convertStrandedPostingCards(");
    const loop = source.indexOf("for (const owner of CARD_OWNERS_ASKED)");
    assert.ok(call > 0, "handleGET must call convertStrandedPostingCards");
    assert.ok(loop > 0);
    assert.ok(call < loop, "the sweep must precede the per-owner loop");
    assert.match(source, /\[cron\/receipt-request-cards\] stranded-posting/);
});
