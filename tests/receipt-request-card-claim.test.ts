import assert from "node:assert/strict";
import test from "node:test";
import {
    buildCardFromItems,
    selectOwnerItems,
    type CardCandidateIssue,
    type CardItem,
} from "../src/lib/receipt-request-cards";

/**
 * The claim protocol, exercised against an in-memory stand-in for the
 * `ReceiptRequestCard` table (Codex blocker 3).
 *
 * The table's UNIQUE (owner, pacificDate) is the whole mechanism, so the fake
 * models exactly that and nothing else. The point is to prove the ORDER of
 * operations is safe — claim, then post, then mark — not to re-test Postgres.
 */

const DATE = "2026-08-20";

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

/**
 * How long a claimed-but-unposted row is left alone before another run may
 * re-post it. Mirrors RESUME_AFTER_MS in the cron: the advisory lock there is
 * transaction-scoped and released before any card is posted, so without this
 * lease a second overlapping run "resumes" the first's in-flight row and the
 * card goes out twice. (This test found exactly that.)
 */
const RESUME_AFTER_MS = 10 * 60_000;

/** UNIQUE (owner, pacificDate), and nothing else. */
function cardTable() {
    const rows = new Map<string, { id: string; owner: string; itemsJson: string; overflow: number; postedAt: Date | null; attempts: number; createdAt: Date }>();
    let seq = 0;
    return {
        rows,
        find(owner: string, date: string) {
            return rows.get(`${owner}|${date}`) ?? null;
        },
        create(owner: string, date: string, items: CardItem[], overflow: number) {
            const key = `${owner}|${date}`;
            if (rows.has(key)) throw new UniqueViolation();
            const row = { id: `card-${++seq}`, owner, itemsJson: JSON.stringify(items), overflow, postedAt: null as Date | null, attempts: 0, createdAt: new Date() };
            rows.set(key, row);
            return row;
        },
        markPosted(id: string) {
            for (const row of rows.values()) if (row.id === id) { row.postedAt = new Date(); row.attempts++; }
        },
    };
}

/** The cron's claim → post → mark sequence, with the post injected. */
async function runOnce(
    table: ReturnType<typeof cardTable>,
    candidates: CardCandidateIssue[],
    post: (owner: string, items: CardItem[]) => Promise<boolean>,
    now: Date = new Date(),
): Promise<{ posted: string[]; claimed: string[]; resumed: string[] }> {
    const posted: string[] = [];
    const claimed: string[] = [];
    const resumed: string[] = [];
    const toPost: Array<{ owner: string; rowId: string; items: CardItem[] }> = [];

    for (const owner of ["CJ", "Richard"]) {
        const existing = table.find(owner, DATE);
        if (existing) {
            if (existing.postedAt !== null) continue;
            if (now.getTime() - existing.createdAt.getTime() < RESUME_AFTER_MS) continue;
            resumed.push(owner);
            toPost.push({ owner, rowId: existing.id, items: JSON.parse(existing.itemsJson) as CardItem[] });
            continue;
        }
        const { items, overflow } = selectOwnerItems(candidates, owner);
        if (items.length === 0) continue;
        try {
            const row = table.create(owner, DATE, items, overflow);
            claimed.push(owner);
            toPost.push({ owner, rowId: row.id, items });
        } catch (error) {
            if (error instanceof UniqueViolation) continue;
            throw error;
        }
    }

    for (const entry of toPost) {
        const ok = await post(entry.owner, entry.items);
        if (!ok) continue;
        table.markPosted(entry.rowId);
        posted.push(entry.owner);
    }
    return { posted, claimed, resumed };
}

test("two simultaneous runs post ONE card per owner", async () => {
    const table = cardTable();
    const candidates = [issue(), issue({ id: "ri-2", targetKey: "bl-2", owner: "Richard", cardTail: "6098" })];
    const posts: string[] = [];
    const post = async (owner: string) => { posts.push(owner); return true; };

    // Both runs select and claim before either posts — the interleaving that
    // the old "stamp the issue after posting" design could not survive.
    const [a, b] = await Promise.all([
        runOnce(table, candidates, post),
        runOnce(table, candidates, post),
    ]);

    assert.equal(posts.length, 2, "one card for CJ, one for Richard — not four");
    assert.deepEqual([...posts].sort(), ["CJ", "Richard"]);
    assert.equal(a.claimed.length + b.claimed.length, 2, "each owner-day is claimed exactly once");
    assert.equal(table.rows.size, 2);
});

test("a later run on the same day posts nothing", async () => {
    const table = cardTable();
    const candidates = [issue()];
    const posts: string[] = [];
    const post = async (owner: string) => { posts.push(owner); return true; };

    await runOnce(table, candidates, post);
    await runOnce(table, candidates, post);
    assert.deepEqual(posts, ["CJ"], "the second run finds a posted claim and stops");
});

test("a crash between claim and post costs AT MOST one duplicate, never a silent miss", async () => {
    const table = cardTable();
    const candidates = [issue()];

    // Run 1: claims, then the process dies before the post is marked.
    await runOnce(table, candidates, async () => false);
    const row = table.find("CJ", DATE)!;
    assert.notEqual(row, null, "the claim is durable");
    assert.equal(row.postedAt, null);

    // Run 2, after the lease expires, resumes THAT row rather than re-selecting.
    const later = new Date(Date.now() + RESUME_AFTER_MS + 1);
    const posts: string[] = [];
    const second = await runOnce(table, candidates, async owner => { posts.push(owner); return true; }, later);
    assert.deepEqual(second.resumed, ["CJ"]);
    assert.deepEqual(posts, ["CJ"]);
    assert.equal(table.rows.size, 1, "no second claim row was created");

    // Run 3 is a no-op.
    const third = await runOnce(table, candidates, async () => { throw new Error("must not post"); }, later);
    assert.deepEqual(third.posted, []);
});

test("a resumed card re-posts the SAME items in the SAME order", async () => {
    const table = cardTable();
    // Three items; only the first two would be selected if the queue changed.
    const candidates = [
        issue({ id: "a", targetKey: "bl-a", postedDate: "2026-08-10" }),
        issue({ id: "b", targetKey: "bl-b", postedDate: "2026-08-11" }),
    ];
    await runOnce(table, candidates, async () => false);
    const claimedItems = JSON.parse(table.find("CJ", DATE)!.itemsJson) as CardItem[];
    const later = new Date(Date.now() + RESUME_AFTER_MS + 1);

    // The queue moves on: a brand-new, older-looking charge appears.
    const changed = [...candidates, issue({ id: "c", targetKey: "bl-c", postedDate: "2026-08-01" })];
    let seen: CardItem[] = [];
    await runOnce(table, changed, async (_owner, items) => { seen = items; return true; }, later);

    assert.deepEqual(seen.map(i => i.targetKey), claimedItems.map(i => i.targetKey),
        "renumbering would break every 'sign N' reply against this thread");
    assert.deepEqual(seen.map(i => i.n), [1, 2]);
});

test("the request id and thread key are the same deterministic string", () => {
    const { items, overflow } = selectOwnerItems([issue()], "CJ");
    const a = buildCardFromItems("CJ", DATE, items, overflow);
    const b = buildCardFromItems("CJ", DATE, items, overflow);
    assert.equal(a.requestId, "receipt-req-CJ-2026-08-20");
    assert.equal(a.requestId, b.requestId);
    assert.equal(a.text, b.text);
});
