import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { postOwnerCard, type OwnerCard } from "../src/lib/receipt-request-cards";
import {
    duplicateChainReason,
    duplicateChainRefusal,
    lockWithInboundDuplicates,
} from "../src/lib/receipt-intake/duplicate-guard";
import { affidavitNameVerdict } from "../src/lib/receipt-affidavit-name";

/**
 * Codex PR #443, adversarial gate round 39.
 *
 *  1. EVERY CHAT POST BUILT ITS THREADING WRONG. `threadKey` went in the URL
 *     and the body carried only `{text}`. `spaces.messages.create` takes
 *     `messageReplyOption` as the query parameter and `thread.threadKey` in the
 *     message; the URL spelling is deprecated, so at best every retry opened a
 *     NEW thread — and the sweep routes replies by thread.
 *  2. THE DUPLICATE POINTER COULD BE BROKEN AFTER THE FACT. Marking refused a
 *     target that was already DUPLICATE, but nothing stopped the same chain
 *     being built upwards (A→B, then B marked a duplicate of C), nothing
 *     stopped VOIDing a row other rows were filed behind, and the intake worker
 *     could reclassify one to DUPLICATE while routing it.
 *  3. THE MEMO FILENAME PARSER ASSUMED A DELIMITER GUARANTEE NOBODY MADE. The
 *     amount was read from `fields[2]`, so a vendor carrying an underscore
 *     shifted every field right and the charge answered `artifact-mismatch`
 *     for ever.
 *  4. OPERATIONAL DOCS STILL DESCRIBED THE OLD SYSTEM: canonical lines "never
 *     minted from QBO", observations "never overwritten", the card's
 *     idempotency living in `displayDetails.card`, and the owner→Chat-user map
 *     as cosmetic when it gates who may sign a memo.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. The threading request Google Chat actually documents ─────────────────

const CARD: OwnerCard = {
    owner: "CJ",
    requestId: "receipt-req-CJ-2026-09-03",
    date: "2026-09-03",
    items: [],
    overflow: 0,
    overflowExact: true,
    text: "one item",
} as unknown as OwnerCard;

/** Captures the REAL request: the url as built, and the parsed JSON body. */
function captureFetch(response: Response) {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fake = ((input: unknown, init: { body?: string }) => {
        seen.push({
            url: String(input),
            body: JSON.parse(init.body ?? "{}") as Record<string, unknown>,
        });
        return Promise.resolve(response);
    }) as unknown as typeof fetch;
    return { seen, fake };
}

test("the thread key travels in the MESSAGE, and messageReplyOption in the query", async () => {
    const realFetch = globalThis.fetch;
    const { seen, fake } = captureFetch(new Response(
        JSON.stringify({ name: "spaces/s/messages/m", thread: { name: "spaces/s/threads/t" } }),
        { status: 200, headers: { "content-type": "application/json" } },
    ));
    globalThis.fetch = fake;
    try {
        const outcome = await postOwnerCard("https://chat.googleapis.com/v1/spaces/AAQA/messages?key=k&token=t", CARD);
        assert.equal(outcome.kind, "delivered");
    } finally {
        globalThis.fetch = realFetch;
    }

    assert.equal(seen.length, 1);
    const url = new URL(seen[0].url);
    assert.equal(
        url.searchParams.get("messageReplyOption"), "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        "the option that acts on a thread key is a QUERY parameter",
    );
    assert.equal(
        url.searchParams.get("threadKey"), null,
        "and the key itself is NOT — that spelling is deprecated, and an unsupported query parameter is a 400",
    );
    assert.deepEqual(
        seen[0].body,
        { text: "one item", thread: { threadKey: "receipt-req-CJ-2026-09-03" } },
        "the key belongs to the message, which is what makes a retry land in the same thread",
    );
    // The webhook's own credentials survive the rebuild — a dropped key is a 401
    // for every card.
    assert.equal(url.searchParams.get("key"), "k");
    assert.equal(url.searchParams.get("token"), "t");
});

test("PRE-FIX CONTROL: the old shape put the key where the API does not read it", () => {
    // What the previous build sent. Kept as an executable description of the
    // bug: nothing in the message names a thread, so Chat has nothing to reply
    // into and every retry starts a new one.
    const preFix = new URL("https://chat.googleapis.com/v1/spaces/AAQA/messages?key=k");
    preFix.searchParams.set("threadKey", CARD.requestId);
    preFix.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    const preFixBody = { text: CARD.text };
    assert.equal(preFix.searchParams.get("threadKey"), CARD.requestId);
    assert.equal("thread" in preFixBody, false, "the message named no thread at all");

    const source = readFileSync(join(repoRoot, "src/lib/receipt-request-cards.ts"), "utf8");
    assert.doesNotMatch(source, /searchParams\.set\("threadKey"/, "and that spelling must not come back");
});

// ── 2. A row other rows are filed behind stays an original ──────────────────

interface FakeRow { id: string; duplicateOfId: string | null }

/**
 * A fake `$queryRaw` over an in-memory table that answers the guard's own
 * statement — and, for the concurrency test, takes the lock the statement asks
 * for so two transactions genuinely take turns.
 */
function fakeTable(rows: FakeRow[]) {
    let held: Promise<void> = Promise.resolve();
    const locked = new Set<string>();
    const client = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            assert.match(sql, /FOR UPDATE/, "the guard must LOCK, not merely read");
            assert.match(sql, /ORDER BY "id"/, "and in id order, or two callers can deadlock");
            const ids = values.map(String);
            const matching = rows
                .filter(row => ids.includes(row.id) || (row.duplicateOfId !== null && ids.includes(row.duplicateOfId)))
                .sort((a, b) => (a.id < b.id ? -1 : 1));
            for (const row of matching) locked.add(row.id);
            return matching.map(row => ({ id: row.id, duplicateOfId: row.duplicateOfId }));
        },
    };
    return {
        rows,
        client,
        locked,
        /** One transaction at a time, which is what FOR UPDATE buys the caller. */
        transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
            const previous = held;
            let release!: () => void;
            held = new Promise<void>(resolve => { release = resolve; });
            await previous;
            try {
                return await fn();
            } finally {
                release();
            }
        },
    };
}

test("the guard locks the row AND everything filed behind it, and names what it found", async () => {
    const table = fakeTable([
        { id: "a", duplicateOfId: "b" },
        { id: "b", duplicateOfId: null },
        { id: "c", duplicateOfId: null },
        { id: "z", duplicateOfId: "c" },
    ]);

    const inbound = await lockWithInboundDuplicates(table.client as never, ["b", "c"]);
    assert.deepEqual(inbound.get("b"), ["a"], "a is filed behind b");
    assert.deepEqual(inbound.get("c"), ["z"]);
    assert.deepEqual([...table.locked].sort(), ["a", "b", "c", "z"], "the references are locked too, not just read");

    // A row nobody points at gets an entry, not an absence — callers read
    // `?? []` once and never branch on "row not found".
    const alone = await lockWithInboundDuplicates(table.client as never, ["a"]);
    assert.deepEqual(alone.get("a"), []);

    const refusal = duplicateChainRefusal("void", ["a", "d"]);
    assert.match(refusal.message, /can't be voided/);
    assert.match(refusal.message, /a, d/, "the ids are the actionable part");
    assert.equal(duplicateChainReason(["a", "d"]), "duplicate-chain:a,d");
});

test("SEQUENTIAL: A→B then B→C is refused, and voiding B is refused", async () => {
    const table = fakeTable([
        { id: "a", duplicateOfId: "b" },
        { id: "b", duplicateOfId: null },
        { id: "c", duplicateOfId: null },
    ]);

    // Marking B a duplicate of C: B is somebody's original, so it is refused.
    const forMark = await lockWithInboundDuplicates(table.client as never, ["b", "c"]);
    assert.deepEqual(forMark.get("b"), ["a"]);
    assert.throws(() => { throw duplicateChainRefusal("duplicate", forMark.get("b") ?? []); }, /can't be marked a duplicate/);

    // Voiding B: same refusal, different verb.
    const forVoid = await lockWithInboundDuplicates(table.client as never, ["b"]);
    assert.throws(() => { throw duplicateChainRefusal("void", forVoid.get("b") ?? []); }, /can't be voided/);

    // PRE-FIX CONTROL: the old rule only asked whether the TARGET was a
    // duplicate. C is a clean original, so B→C sailed through and left A
    // pointing at a copy.
    const targetWasClean = table.rows.find(r => r.id === "c")!.duplicateOfId === null;
    assert.equal(targetWasClean, true, "which is all the old check looked at");
});

test("CONCURRENT: two connections racing to break the same original — one waits, one is refused", async () => {
    /**
     * The pair race, one level up. Marge marks A→B while Richard marks B→C: the
     * inbound reference A→B lands in the first transaction, and the second must
     * SEE it. It does only because the lock covers inbound references — reading
     * them unlocked is the same time-of-check gap the pair lock exists for.
     */
    const table = fakeTable([
        { id: "a", duplicateOfId: null },
        { id: "b", duplicateOfId: null },
        { id: "c", duplicateOfId: null },
    ]);
    const refusals: string[] = [];

    const markAtoB = table.transaction(async () => {
        await lockWithInboundDuplicates(table.client as never, ["a", "b"]);
        table.rows.find(r => r.id === "a")!.duplicateOfId = "b";
    });
    const markBtoC = table.transaction(async () => {
        const inbound = await lockWithInboundDuplicates(table.client as never, ["b", "c"]);
        const blocking = inbound.get("b") ?? [];
        if (blocking.length > 0) {
            refusals.push(duplicateChainRefusal("duplicate", blocking).message);
            return;
        }
        table.rows.find(r => r.id === "b")!.duplicateOfId = "c";
    });
    await Promise.all([markAtoB, markBtoC]);

    assert.equal(refusals.length, 1, "the second transaction saw the first one's reference and refused");
    assert.equal(table.rows.find(r => r.id === "b")!.duplicateOfId, null, "so B is still an original");
    assert.equal(table.rows.find(r => r.id === "a")!.duplicateOfId, "b", "and A still points at it");

    // PRE-FIX CONTROL: without the inbound lock the second transaction reads B
    // as a clean original — the same interleaving, the chain formed.
    const loose = [
        { id: "a", duplicateOfId: null as string | null },
        { id: "b", duplicateOfId: null as string | null },
    ];
    const bLooksClean = loose.find(r => r.id === "b")!.duplicateOfId === null;
    loose.find(r => r.id === "a")!.duplicateOfId = "b";
    assert.equal(bLooksClean, true, "checked before the other write landed");
});

test("the three write paths all take the guard, and the worker refuses in its own way", () => {
    const actions = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    const mark = actions.slice(actions.indexOf("export async function markReceiptIntakeDuplicate("));
    assert.match(
        mark.slice(0, mark.indexOf("\n}")),
        /await withDuplicateChainLock\(fn => prisma\.\$transaction\(fn\), \[id, duplicateOfId\][\s\S]{0,3000}throw duplicateChainRefusal\("duplicate", inboundToSource\)/,
        "mark locks both rows plus their references, and refuses to become a link in a chain",
    );
    const voidFn = actions.slice(actions.indexOf("export async function voidReceiptIntake("));
    assert.match(
        voidFn.slice(0, voidFn.indexOf("\n}")),
        /await withDuplicateChainLock\(fn => prisma\.\$transaction\(fn\), \[id\], async \(tx, inboundById\) => \{[\s\S]{0,400}throw duplicateChainRefusal\("void", inbound\)[\s\S]{0,600}await runParkWrites\(/,
        "void locks, refuses and writes in ONE transaction — a duplicate marked in between would slip through",
    );

    // SINCE ROUND 40 (finding 1) the worker asks for a TRANSITION, not for a
    // fact it then acts on: the check and the write are one transaction, inside
    // the shared guard. Presence only — the proof is the worker-vs-admin
    // interleaving in tests/receipt-round40-fixes.test.ts.
    const worker = readFileSync(join(repoRoot, "src/lib/receipt-intake/worker.ts"), "utf8");
    const cron = readFileSync(join(repoRoot, "src/app/api/cron/receipt-intake-worker/route.ts"), "utf8");
    assert.match(worker, /async function applyRoutedState\(/);
    assert.match(worker, /return deps\.applyDuplicateTransition\(rowId, decision, patch, ownership\);/);
    assert.equal((worker.match(/await applyRoutedState\(/g) ?? []).length, 3);
    assert.match(cron, /applyDuplicateTransition: async \(rowId, decision, patch, ownership\) => withDuplicateChainLock\(/);
});

// ── 3. The memo filename is parsed, not positioned ─────────────────────────

test("a vendor carrying an underscore no longer makes the charge unanswerable", () => {
    const amount = 12_345; // $123.45
    for (const name of [
        "MissingReceiptAffidavit_2026-08-16_LOWES_123.45_CJ.pdf",
        "MissingReceiptAffidavit_2026-08-16_LOWES_02516_123.45_CJ.pdf",
        "MissingReceiptAffidavit_2026-08-16_A_B_TRADING_123.45_CJ.pdf",
        "MissingReceiptAffidavit_2026-08-16_LOWES HOME CENTER_123.45_CJ.pdf",
        "MissingReceiptAffidavit_2026-08-16_LOWES__123.45_CJ.pdf",
        "MissingReceiptAffidavit_2026-08-16_LOWES_123.45_CJ_.pdf",
        "MissingReceiptAffidavit_2026-08-16_LOWES_123.45_Christopher_Jones.pdf",
    ]) {
        assert.equal(affidavitNameVerdict(name, amount), "match", name);
        assert.equal(affidavitNameVerdict(name, -amount), "match", "the sign is the ledger's, not the memo's");
    }

    // PRE-FIX CONTROL: reading the third field returned the vendor tail for the
    // underscore cases, so they could never match and the chase never closed.
    const preFix = (name: string) => {
        const fields = name.slice("MissingReceiptAffidavit_".length).split("_");
        const match = /^(\d+)\.(\d{2})$/.exec(fields[2] ?? "");
        return match ? Number(match[1]) * 100 + Number(match[2]) : null;
    };
    assert.equal(preFix("MissingReceiptAffidavit_2026-08-16_LOWES_123.45_CJ.pdf"), amount, "the simple case worked");
    assert.equal(preFix("MissingReceiptAffidavit_2026-08-16_LOWES_02516_123.45_CJ.pdf"), null, "and the shifted one never could");
});

test("a WRONG amount is still refused, and an unreadable one is reported rather than refused", () => {
    const amount = 1_234; // $12.34
    // Positive evidence of another charge: refuse.
    assert.equal(affidavitNameVerdict("MissingReceiptAffidavit_2026-08-16_LOWES_112.34_CJ.pdf", amount), "mismatch");
    assert.equal(affidavitNameVerdict("MissingReceiptAffidavit_2026-08-16_LOWES_12.345_CJ.pdf", amount), "mismatch");
    assert.equal(affidavitNameVerdict("MissingReceiptAffidavit_2026-08-16_LOWES_12.3_CJ.pdf", amount), "mismatch");
    // No amount anywhere: the card association is the binding, so this is
    // accepted and reported — refusing it is what made a chase unanswerable.
    assert.equal(affidavitNameVerdict("MissingReceiptAffidavit_2026-08-16_LOWES_CJ.pdf", amount), "unparseable");
    // Never produced by the sign flow at all.
    assert.equal(affidavitNameVerdict("some-other-file.pdf", amount), "mismatch");
    assert.equal(affidavitNameVerdict("MissingReceiptAffidavit_2026-08-16_LOWES_12.34_CJ.txt", amount), "mismatch");
    assert.equal(affidavitNameVerdict(null, amount), "mismatch");

    const answers = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/answers/route.ts"), "utf8");
    assert.match(answers, /if \(nameVerdict === "mismatch"\) return \{ kind: "mismatch" \};/);
    assert.match(answers, /"affidavit-name-unparseable"/, "and the accepted-but-unchecked case is recorded for a human");
});

// ── 4. The docs describe the system that exists ────────────────────────────

test("no operational doc still describes the pre-Phase-2 contracts", () => {
    const files = [
        "prisma/schema.prisma",
        "src/lib/receipt-request-cards.ts",
        ".env.example",
        "src/lib/bank-line-mint.ts",
        "src/lib/bank-register-pull.ts",
    ];
    for (const file of files) {
        const source = readFileSync(join(repoRoot, file), "utf8").replace(/\r\n/g, "\n");
        assert.doesNotMatch(
            source, /only ever minted from a STATEMENT observation, never\n?\/*\s*\/*\s*from QBO/,
            `${file} still says QBO never mints`,
        );
        assert.doesNotMatch(
            source, /StatementImport rows are never overwritten/,
            `${file} still says observations are never overwritten`,
        );
    }

    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    assert.match(schema, /BANK_LINE_MINT_FROM_QBO is on, from a QuickBooks GENERAL LEDGER posting/);
    assert.match(schema, /BankLineObservation\.clearedStatus every time QuickBooks answers/);

    const cards = readFileSync(join(repoRoot, "src/lib/receipt-request-cards.ts"), "utf8");
    assert.match(cards, /The authoritative check: the `ReceiptRequestCard` row itself/);
    assert.match(cards, /is HISTORY, not the\s*\n \*\s*guard/, "the blob is named as history, not the guard");

    const env = readFileSync(join(repoRoot, ".env.example"), "utf8");
    assert.match(env, /NOT COSMETIC/);
    assert.match(env, /before it lets somebody sign a memo for that owner/);
});

test("the schema edit is a COMMENT edit — no column moves with it", () => {
    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model BankLine {"));
    const body = model.slice(0, model.indexOf("\n}"));
    assert.match(body, /sourceOfRecord\s+String\s+@default\("STATEMENT"\)/);
    assert.match(body, /amountCents\s+Int/);
});
