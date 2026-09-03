import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    buildCardFromItems,
    selectOwnerItems,
    type CardCandidateIssue,
    type CardItem,
} from "../src/lib/receipt-request-cards";

/**
 * The claim protocol, exercised against an in-memory stand-in for
 * `ReceiptRequestCard` (Codex blockers 3, rounds 1 and 2).
 *
 * TWO claims live on that row and they answer different questions:
 *   - the DAY claim is `UNIQUE (owner, pacificDate)`: who gets to select today.
 *   - the POST claim is `claimedAt`/`claimToken`: who gets to send the message,
 *     and — because completion is fenced on the token — who gets to record that
 *     it was sent. Without the token, a superseded run's late completion could
 *     mark a row posted that it never posted.
 *
 * The fake models exactly those two and nothing else. The point is that the
 * ORDER of operations is safe, not to re-test Postgres.
 */

const DATE = "2026-08-20";
const CLAIM_LEASE_MS = 10 * 60_000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const issue = (over: Partial<CardCandidateIssue> = {}): CardCandidateIssue => ({
    id: "ri-1",
    targetKey: "bl-1",
    owner: "CJ",
    acknowledged: false,
    cardTail: "8516",
    postedDate: "2026-08-16",
    amountCents: -12_345,
    payee: "LOWES #02516",
    fingerprint: "pb-bl-1",
    everCarded: false,
    ...over,
});

class UniqueViolation extends Error {}

interface CardRow {
    id: string;
    owner: string;
    itemsJson: string;
    overflow: number;
    claimedAt: Date | null;
    claimToken: string | null;
    postedAt: Date | null;
    attempts: number;
}

function cardTable() {
    const rows = new Map<string, CardRow>();
    let seq = 0;
    return {
        rows,
        find(owner: string, date: string) {
            return rows.get(`${owner}|${date}`) ?? null;
        },
        /** UNIQUE (owner, pacificDate) — the DAY claim. */
        create(owner: string, date: string, items: CardItem[], overflow: number, now: Date, token: string) {
            const key = `${owner}|${date}`;
            if (rows.has(key)) throw new UniqueViolation();
            const row: CardRow = {
                id: `card-${++seq}`, owner, itemsJson: JSON.stringify(items), overflow,
                claimedAt: now, claimToken: token, postedAt: null, attempts: 0,
            };
            rows.set(key, row);
            return row;
        },
        /** The POST claim CAS. Returns the number of rows updated. */
        takePostClaim(id: string, now: Date, token: string): number {
            for (const row of rows.values()) {
                if (row.id !== id) continue;
                if (row.postedAt !== null) return 0;
                const free = row.claimedAt === null || row.claimedAt.getTime() < now.getTime() - CLAIM_LEASE_MS;
                if (!free) return 0;
                row.claimedAt = now;
                row.claimToken = token;
                return 1;
            }
            return 0;
        },
        /** Token-fenced completion. */
        markPosted(id: string, token: string): number {
            for (const row of rows.values()) {
                if (row.id !== id || row.claimToken !== token) continue;
                row.postedAt = new Date();
                row.attempts++;
                return 1;
            }
            return 0;
        },
        releaseClaim(id: string, token: string) {
            for (const row of rows.values()) {
                if (row.id !== id || row.claimToken !== token) continue;
                row.claimedAt = null;
                row.claimToken = null;
                row.attempts++;
            }
        },
    };
}

/** The cron's claim → record → post → complete sequence, with the post injected. */
async function runOnce(
    table: ReturnType<typeof cardTable>,
    candidates: CardCandidateIssue[],
    post: (owner: string, items: CardItem[]) => Promise<boolean>,
    now: Date = new Date(),
    tokenSeed = Math.random().toString(36).slice(2),
): Promise<{ posted: string[]; claimed: string[]; resumed: string[]; recordedBeforePost: string[] }> {
    const posted: string[] = [];
    const claimed: string[] = [];
    const resumed: string[] = [];
    const recordedBeforePost: string[] = [];
    const toPost: Array<{ owner: string; rowId: string; token: string; items: CardItem[] }> = [];

    for (const owner of ["CJ", "Richard"]) {
        const token = `${tokenSeed}-${owner}`;
        const existing = table.find(owner, DATE);
        if (existing) {
            if (existing.postedAt !== null) continue;
            if (table.takePostClaim(existing.id, now, token) === 0) continue;
            resumed.push(owner);
            toPost.push({ owner, rowId: existing.id, token, items: JSON.parse(existing.itemsJson) as CardItem[] });
            continue;
        }
        const { items, overflow } = selectOwnerItems(candidates, owner);
        if (items.length === 0) continue;
        try {
            const row = table.create(owner, DATE, items, overflow, now, token);
            claimed.push(owner);
            toPost.push({ owner, rowId: row.id, token, items });
        } catch (error) {
            if (error instanceof UniqueViolation) continue;
            throw error;
        }
    }

    for (const entry of toPost) {
        recordedBeforePost.push(entry.owner); // cards[] is written first
        const ok = await post(entry.owner, entry.items);
        if (!ok) {
            table.releaseClaim(entry.rowId, entry.token);
            continue;
        }
        if (table.markPosted(entry.rowId, entry.token) === 1) posted.push(entry.owner);
    }
    return { posted, claimed, resumed, recordedBeforePost };
}

test("two simultaneous runs post ONE card per owner", async () => {
    const table = cardTable();
    const candidates = [issue(), issue({ id: "ri-2", targetKey: "bl-2", owner: "Richard", cardTail: "6098" })];
    const posts: string[] = [];
    const post = async (owner: string) => { posts.push(owner); return true; };
    const now = new Date();

    const [a, b] = await Promise.all([
        runOnce(table, candidates, post, now, "A"),
        runOnce(table, candidates, post, now, "B"),
    ]);

    assert.equal(posts.length, 2, "one card for CJ, one for Richard — not four");
    assert.deepEqual([...posts].sort(), ["CJ", "Richard"]);
    assert.equal(a.claimed.length + b.claimed.length, 2, "each owner-day is claimed exactly once");
    assert.equal(table.rows.size, 2);
});

test("a later run on the same day posts nothing", async () => {
    const table = cardTable();
    const posts: string[] = [];
    const post = async (owner: string) => { posts.push(owner); return true; };
    await runOnce(table, [issue()], post);
    await runOnce(table, [issue()], post);
    assert.deepEqual(posts, ["CJ"], "the second run finds a posted claim and stops");
});

test("a run that does not hold the token cannot complete the post", async () => {
    const table = cardTable();
    const now = new Date();
    await runOnce(table, [issue()], async () => false, now, "A"); // claims, fails, releases

    // A stale run tries to complete with a token it no longer holds.
    const row = table.find("CJ", DATE)!;
    assert.equal(table.markPosted(row.id, "A-CJ"), 0, "the released token is dead");

    // The legitimate next run takes the claim and completes.
    const later = new Date(now.getTime() + 1000);
    const second = await runOnce(table, [issue()], async () => true, later, "B");
    assert.deepEqual(second.posted, ["CJ"]);
    assert.notEqual(table.find("CJ", DATE)!.postedAt, null);
});

test("a failed post leaves the row unposted for a SAME-DAY retry", async () => {
    const table = cardTable();
    const now = new Date();
    await runOnce(table, [issue()], async () => false, now, "A");
    const row = table.find("CJ", DATE)!;
    assert.equal(row.postedAt, null);
    assert.equal(row.claimToken, null, "the claim was released, not held until the lease expires");

    // Same day, moments later — no need to wait out a lease.
    const retry = await runOnce(table, [issue()], async () => true, new Date(now.getTime() + 1000), "B");
    assert.deepEqual(retry.posted, ["CJ"]);
    assert.deepEqual(retry.resumed, ["CJ"]);
});

test("a crash mid-post is recovered only after the lease, and costs at most one duplicate", async () => {
    const table = cardTable();
    const now = new Date();
    // Claim taken, then the process dies: neither markPosted nor releaseClaim ran.
    const token = "crashed-CJ";
    const { items, overflow } = selectOwnerItems([issue()], "CJ");
    table.create("CJ", DATE, items, overflow, now, token);

    // A run seconds later must NOT touch it — that is how you post twice.
    const early = await runOnce(table, [issue()], async () => { throw new Error("must not post"); }, new Date(now.getTime() + 1000), "B");
    assert.deepEqual(early.posted, []);

    // After the lease, it is recoverable.
    const later = new Date(now.getTime() + CLAIM_LEASE_MS + 1);
    const recovered = await runOnce(table, [issue()], async () => true, later, "C");
    assert.deepEqual(recovered.resumed, ["CJ"]);
    assert.deepEqual(recovered.posted, ["CJ"]);
    assert.equal(table.rows.size, 1, "no second claim row was created");
});

test("a resumed card re-posts the SAME items in the SAME order", async () => {
    const table = cardTable();
    const now = new Date();
    const candidates = [
        issue({ id: "a", targetKey: "bl-a", postedDate: "2026-08-10" }),
        issue({ id: "b", targetKey: "bl-b", postedDate: "2026-08-11" }),
    ];
    await runOnce(table, candidates, async () => false, now, "A");
    const claimedItems = JSON.parse(table.find("CJ", DATE)!.itemsJson) as CardItem[];

    // The queue moves on: a brand-new, older-looking charge appears.
    const changed = [...candidates, issue({ id: "c", targetKey: "bl-c", postedDate: "2026-08-01" })];
    let seen: CardItem[] = [];
    await runOnce(table, changed, async (_owner, items) => { seen = items; return true; }, new Date(now.getTime() + 1000), "B");

    assert.deepEqual(seen.map(i => i.targetKey), claimedItems.map(i => i.targetKey),
        "renumbering would break every 'sign N' reply against this thread");
    assert.deepEqual(seen.map(i => i.n), [1, 2]);
});

test("card history is written only AFTER a validated post", () => {
    // REVERSED in round 4. Writing history first marked items `everCarded` for
    // attempts that never reached Chat, so the never-carded-first ordering
    // deprioritised work nobody had actually been asked about — the exact
    // starvation that ordering exists to prevent. A post now only succeeds when
    // it returns both bridge identities, so "carded" means there is a real
    // thread to reply in; the residual risk moves to a crash between post and
    // record, which costs one un-recorded thread and is self-correcting on the
    // next card.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    const postAt = source.indexOf("const result = await postOwnerCard(webhookUrl, card, { timeoutMs: sendTimeoutMs });");
    // It rides INSIDE the completion transaction now — same ordering, and the
    // pair commits together (tests/receipt-request-cards.test.ts).
    const recordAt = source.indexOf("await recordCardOnIssues(card, result.threadName, result.messageName, now, tx);");
    assert.ok(postAt > 0 && recordAt > postAt, "history must follow the post");
    assert.doesNotMatch(source, /recordCardOnIssues\(card, null, null, now\)/, "no pre-post history write");
});

test("completion is token-fenced in the real route, not just in this fake", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    assert.match(source, /where: \{ id: rowId, claimToken: token \}/);
    assert.match(source, /OR: \[\{ claimedAt: null \}, \{ claimedAt: \{ lt: new Date\(now\.getTime\(\) - CLAIM_LEASE_MS\) \} \}\]/);
});

test("the request id and thread key are the same deterministic string", () => {
    const { items, overflow } = selectOwnerItems([issue()], "CJ");
    const a = buildCardFromItems("CJ", DATE, items, overflow);
    const b = buildCardFromItems("CJ", DATE, items, overflow);
    assert.equal(a.requestId, "receipt-req-CJ-2026-08-20");
    assert.equal(a.requestId, b.requestId);
    assert.equal(a.text, b.text);
});
