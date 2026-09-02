import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    componentVersionOf,
    componentVersionsMatch,
    driveFileIdFromUrl,
    planReceiptRequests,
    type MissingReceiptDisplayDetails,
    type ReceiptRequestPlan,
} from "../src/lib/receipt-requests";
import { dayKeyInTimeZone } from "../src/lib/tz-date";
import {
    applyReceiptRequestPlan,
    evidenceBoundsFor,
    shouldResumeSweep,
    sweepPhaseAfter,
} from "../src/app/api/cron/receipt-requests/route";

/**
 * Round-21 review findings. Each one is a way this sweep could report a clean,
 * finished night while a real charge went un-chased or a half-applied verdict
 * was left behind.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sweepSource = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
const migrationSql = readFileSync(
    join(repoRoot, "prisma/migrations/20260901120000_phase2_receipt_queue/migration.sql"),
    "utf8",
);
const applyScript = readFileSync(join(repoRoot, "scripts/apply-phase2-receipt-queue.mjs"), "utf8");

const ZONE = "America/Los_Angeles";

// ── 1. the fingerprint covers the bank line's updatedAt ────────────────────

test("a BRAND-NEW unmatched line fingerprints identically on both sides", () => {
    // The failing case in production terms: a charge posted last night, with no
    // issue yet and no intake anywhere. The in-transaction fingerprint reads the
    // component's bank lines WITH `updatedAt`; the planned one used to omit it,
    // so `newest` was "" on one side and the line's timestamp on the other. The
    // two could never agree, all three attempts "replanned", and the component
    // was abandoned undecided — so the one case this feature exists for was the
    // one case it never chased.
    const line = { id: "bl-new", rawDescriptor: "LOWES #02516 POS DEB C#8516", updatedAt: new Date("2026-09-02T11:00:00Z") };
    const locked = componentVersionOf({ issues: [], intakes: [], lines: [line], expenses: [] });

    const planned = componentVersionOf({ issues: [], intakes: [], lines: [line], expenses: [] });
    assert.equal(componentVersionsMatch(planned, locked), true, "same fields, same fingerprint");

    // The bug, stated as data: drop `updatedAt` from the planned side only.
    const withoutIt = componentVersionOf({
        issues: [], intakes: [], expenses: [],
        lines: [{ id: line.id, rawDescriptor: line.rawDescriptor }],
    });
    assert.equal(componentVersionsMatch(withoutIt, locked), false, "and it can never reconcile");
    assert.equal(withoutIt.newest, "", "because `newest` had nothing to read");
    assert.equal(locked.newest, line.updatedAt.toISOString());
});

test("an issue or intake in the component used to MASK the missing line stamp", () => {
    // Why this went unnoticed: with any issue or intake in the set, `newest` was
    // usually theirs, so the omission only showed on the components that had
    // neither — which is exactly a fresh, never-chased charge.
    const line = { id: "bl-1", rawDescriptor: "LOWES #02516", updatedAt: new Date("2026-09-01T10:00:00Z") };
    const issues = [{ targetKey: "bl-1", updatedAt: new Date("2026-09-02T10:00:00Z") }];
    const withStamp = componentVersionOf({ issues, intakes: [], lines: [line], expenses: [] });
    const without = componentVersionOf({
        issues, intakes: [], expenses: [],
        lines: [{ id: line.id, rawDescriptor: line.rawDescriptor }],
    });
    assert.equal(componentVersionsMatch(withStamp, without), true, "the issue's newer stamp hid it");
});

test("a line touched mid-plan still forces a replan", () => {
    // The fix must not make the fence weaker: a descriptor refresh bumps
    // `updatedAt`, and that has to be visible.
    const before = componentVersionOf({
        issues: [], intakes: [], expenses: [],
        lines: [{ id: "bl-1", rawDescriptor: "LOWES #02516", updatedAt: new Date("2026-09-02T10:00:00Z") }],
    });
    const after = componentVersionOf({
        issues: [], intakes: [], expenses: [],
        lines: [{ id: "bl-1", rawDescriptor: "LOWES #02516", updatedAt: new Date("2026-09-02T10:05:00Z") }],
    });
    assert.equal(componentVersionsMatch(before, after), false);
});

test("every bank-line read that feeds a plan selects updatedAt", () => {
    // A select that forgets the column reintroduces the P0 silently: the field
    // is optional on the fingerprint input, so the omission type-checks.
    const selects = sweepSource.match(/select: \{ id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true[^}]*\}/g) ?? [];
    assert.ok(selects.length >= 4, `expected the batch/cohort selects, found ${selects.length}`);
    for (const select of selects) {
        assert.ok(select.includes("updatedAt: true"), `a BatchLine select without updatedAt:\n  ${select}`);
    }
    // And the planned fingerprint actually passes it through.
    assert.match(sweepSource, /lines: componentLines\.map\(row => \(\{[\s\S]{0,200}updatedAt: row\.updatedAt,/);
});

// ── 2. a component transaction is all-or-nothing ──────────────────────────

/**
 * A transaction that keeps its writes ONLY if the callback resolves — the one
 * property of `prisma.$transaction` this finding turns on. `committed` is what
 * survived; anything staged by a callback that threw is gone.
 */
async function inTransaction(
    committed: string[],
    fn: (write: (key: string) => void) => Promise<void>,
): Promise<void> {
    const staged: string[] = [];
    await fn(key => staged.push(key));
    committed.push(...staged);
}

const detailsFor = (id: string): MissingReceiptDisplayDetails => ({
    owner: "Richard",
    cardTail: "8516",
    postedDate: "2026-08-16",
    amountCents: -12_345,
    payee: "Lowes",
    rawDescriptor: "LOWES #02516 POS DEB C#8516",
    fingerprint: `pb-${id}`,
});

const TWO_CHARGES: ReceiptRequestPlan = {
    open: [
        { targetKey: "bl-a", displayDetails: detailsFor("bl-a") },
        { targetKey: "bl-b", displayDetails: detailsFor("bl-b") },
    ],
    close: [],
    undecided: [],
};

/** Writes through `write`, and fails on bl-b — the second verdict of the pair. */
const secondFails = (write: (key: string) => void) => async (targetKey: string) => {
    if (targetKey === "bl-b") throw new Error("deadlock detected");
    write(targetKey);
    return {
        decision: { step: 2 as const, action: "create" as const, canonicalCodes: ["MISSING_RECEIPT" as const], reasonHash: "x", openGeneration: 1 },
        applied: true,
    };
};

test("an error on the SECOND verdict rolls the first one back", async () => {
    const committed: string[] = [];
    await assert.rejects(
        () => inTransaction(committed, async write => {
            await applyReceiptRequestPlan(TWO_CHARGES, secondFails(write), { abortOnError: true });
        }),
        /deadlock detected/,
        "the throw has to reach the transaction, or there is nothing to roll back",
    );
    assert.deepEqual(committed, [], "bl-a's write does not survive its component");
});

test("swallowing the error is what half-applied the component", async () => {
    // The same plan without `abortOnError`: the first verdict commits with the
    // transaction and the second is downgraded to a counter, so the component
    // holds HALF an allocation — one charge chased, its twin neither chased nor
    // closed. That is the state one-to-one matching exists to make impossible.
    const committed: string[] = [];
    let summary: Awaited<ReturnType<typeof applyReceiptRequestPlan>> | null = null;
    await inTransaction(committed, async write => {
        summary = await applyReceiptRequestPlan(TWO_CHARGES, secondFails(write));
    });
    assert.deepEqual(committed, ["bl-a"], "which is exactly the partial commit");
    assert.deepEqual(summary!.failedTargets, ["bl-b"]);
    assert.equal(summary!.errors, 1, "reported, and still committed — the two are not the same thing");
});

test("the non-aborting default survives, because the outer passes rely on it", async () => {
    // Outside a transaction a single bad target must NOT abandon the night's
    // remaining work — it is retained as an error and the cursor stops there.
    const seen: string[] = [];
    const summary = await applyReceiptRequestPlan(
        { open: [{ targetKey: "bl-a", displayDetails: detailsFor("bl-a") }], close: ["bl-b", "bl-c"], undecided: [] },
        async targetKey => {
            seen.push(targetKey);
            if (targetKey === "bl-b") throw new Error("transient");
            return { decision: { step: 1, action: "clear", canonicalCodes: [], reasonHash: "" }, applied: true };
        },
    );
    assert.deepEqual(seen, ["bl-a", "bl-b", "bl-c"], "bl-c still ran");
    assert.deepEqual(summary.failedTargets, ["bl-b"]);
});

test("the component transaction is the caller that asks to abort", () => {
    assert.match(sweepSource, /\{ abortOnError: true \},\s*\);\s*summary\.opened \+= applied\.opened;/);
});

// ── 4. undecided work may not stamp a completion ──────────────────────────

test("contended work keeps the cycle unfinished and resumable", () => {
    const at = (over: Partial<Parameters<typeof sweepPhaseAfter>[0]>) => sweepPhaseAfter({
        openExhausted: true, openErrors: 0, lineExhausted: true, lineErrors: 0, ...over,
    });
    assert.equal(at({}), "done");
    // A component that ran out of replans got NO verdict. Calling the cycle
    // done stamps `chaserCompletedAt`, and the morning card is then built from
    // an issue set nobody reconciled.
    assert.equal(at({ openContended: 1 }), "open-issues");
    assert.equal(at({ lineContended: 1 }), "lines");
    // Unfinished means the resume pass picks it up, with no cursor parked.
    assert.equal(shouldResumeSweep(at({ lineContended: 1 }), null, null), true);
    assert.equal(shouldResumeSweep(at({}), null, null), false);
});

test("only a done phase carries the stamp, and contention cannot reach done", () => {
    // The stamp is written ONLY on "done" (that expression is asserted in
    // receipt-sweep-marker.test.ts), so blocking "done" is what blocks the card.
    assert.match(sweepSource, /await writePhase\(phase, phase === "done" \? new Date\(\)\.toISOString\(\) : undefined\);/);
    // And the contention counts actually reach the decision.
    assert.match(sweepSource, /const phase = sweepPhaseAfter\(\{[\s\S]{0,240}openContended,[\s\S]{0,240}lineContended,/);
    // A run that left contended work says so, and says there is more to do.
    assert.match(sweepSource, /moreToProcess: !exhausted \|\| !openExhausted \|\| openContended > 0 \|\| lineContended > 0/);
});

test("a STABLE non-verdict does not block the cycle for ever", () => {
    // A line outside the loaded evidence span, or one whose competing set is
    // too large to load, reproduces identically on every future run. Blocking
    // on those would stall the morning card permanently rather than for one
    // cycle, so `contended` is reported separately from `undecided` and only
    // the contended half holds the phase open.
    assert.match(sweepSource, /if \(!outcome\.replan\) return \{ \.\.\.outcome, contended: 0, replans \};/);
    assert.match(sweepSource, /return \{ summary: emptySummary\(\), undecided: batch\.length, contended: batch\.length, replans \};/);
});

// ── 5. an expense's day key is the COMPANY's, not UTC's ───────────────────

test("every instant the evidence window can return files inside the window", () => {
    // THE INVARIANT. The query bounds are company-local midnights; the day key
    // has to agree with them at both edges, or the matcher files a row on a day
    // the query never claimed to cover.
    const bounds = evidenceBoundsFor("2026-08-16", "2026-08-18", ZONE);
    assert.equal(dayKeyInTimeZone(bounds.timestamp.gte, ZONE), "2026-08-16");
    const lastInstant = new Date(bounds.timestamp.lt.getTime() - 1);
    assert.equal(dayKeyInTimeZone(lastInstant, ZONE), "2026-08-18", "the last loadable instant is still the last allowed day");
    // The UTC slice breaks it: that same instant is 06:59:59.999 on the 19th.
    assert.equal(lastInstant.toISOString().slice(0, 10), "2026-08-19");
});

test("a receipt filed on a Pacific evening is not pushed onto the next day", () => {
    // 7pm PDT on the 18th. The UTC day is the 19th, which is three days from a
    // charge on the 16th — outside the ±2 match window — so the charge got
    // chased with its receipt sitting right there.
    const evening = new Date("2026-08-19T02:00:00Z");
    assert.equal(dayKeyInTimeZone(evening, ZONE), "2026-08-18");
    assert.equal(evening.toISOString().slice(0, 10), "2026-08-19");

    const base = {
        bankLines: [{
            id: "bl-1", postedDate: "2026-08-16", amountCents: -12_345,
            rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null,
        }],
        intakes: [],
        openIssueKeys: [],
        now: new Date("2026-08-25T12:00:00Z"),
    };
    const withDate = (date: string) => planReceiptRequests({
        ...base,
        expenses: [{ id: "exp-1", qbPurchaseId: null, hasReceipt: true, amountCents: 12_345, date, vendor: "Lowes" }],
    });

    assert.deepEqual(
        withDate(evening.toISOString().slice(0, 10)).open.map(o => o.targetKey),
        ["bl-1"],
        "the UTC day is out of range — a chase for a receipt we hold",
    );
    assert.deepEqual(withDate(dayKeyInTimeZone(evening, ZONE)).open, [], "the company day matches");
});

test("the day key is DST-correct at both transitions", () => {
    // A fixed -8 or -7 offset gets one of these wrong; Intl gets both right.
    // Spring forward, 2026-03-08: 07:59:59Z is 23:59:59 PST on the 7th.
    assert.equal(dayKeyInTimeZone(new Date("2026-03-08T07:59:59Z"), ZONE), "2026-03-07");
    assert.equal(dayKeyInTimeZone(new Date("2026-03-08T08:00:00Z"), ZONE), "2026-03-08");
    // Fall back, 2026-11-01: PDT is still in force at 06:00Z (23:00 on the 31st).
    assert.equal(dayKeyInTimeZone(new Date("2026-11-01T06:00:00Z"), ZONE), "2026-10-31");
    assert.equal(dayKeyInTimeZone(new Date("2026-11-01T07:00:00Z"), ZONE), "2026-11-01");
    // Ordinary midnight, PDT.
    assert.equal(dayKeyInTimeZone(new Date("2026-08-19T06:59:59Z"), ZONE), "2026-08-18");
    assert.equal(dayKeyInTimeZone(new Date("2026-08-19T07:00:00Z"), ZONE), "2026-08-19");
});

test("both planning paths derive the expense day key from the resolved zone", () => {
    const uses = sweepSource.match(/date: row\.date \? [^\n]+/g) ?? [];
    assert.equal(uses.length, 2, "the batch path and the recompute path");
    for (const use of uses) {
        assert.match(use, /dayKeyInTimeZone\(row\.date, zone\)/, use);
    }
    // The SAME zone the window boundaries came from — two reads could disagree.
    assert.match(sweepSource, /const zone = await resolveCompanyTimeZone\(\);\s*const range = evidenceBoundsFor\(fromYmd, toYmd, zone\);/);
    // `txnDate` is @db.Date and keeps its UTC slice on purpose.
    assert.match(sweepSource, /txnDate: row\.txnDate \? row\.txnDate\.toISOString\(\)\.slice\(0, 10\) : null,/);
});

// ── 7. a stored link must name the verified file ──────────────────────────

test("driveFileIdFromUrl reads the id out of the shapes Drive mints", () => {
    const id = "1sEISJBJaGRYpivooQJBR";
    for (const url of [
        `https://drive.google.com/file/d/${id}/view`,
        `https://drive.google.com/file/d/${id}/view?usp=sharing`,
        `https://docs.google.com/document/d/${id}/edit`,
        `https://drive.google.com/open?id=${id}`,
        `https://drive.google.com/uc?id=${id}&export=download`,
        `https://drive.google.com/drive/folders/${id}`,
    ]) {
        assert.equal(driveFileIdFromUrl(url), id, url);
    }
});

test("driveFileIdFromUrl refuses anything that does not name a Drive file", () => {
    for (const url of [
        "https://ghzdbzdnwjxazvmcefbh.supabase.co/storage/v1/object/public/memos/x.pdf",
        "https://lh3.googleusercontent.com/abc",
        "https://drive.google.com/",
        "https://drive.google.com/file/d/short/view",
        "https://evil.example.com/file/d/1sEISJBJaGRYpivooQJBR/view",
        "not a url",
        null,
        undefined,
        42,
    ]) {
        assert.equal(driveFileIdFromUrl(url), null, String(url));
    }
});

test("a lookalike host cannot smuggle an id through", () => {
    // Substring matching on the host is the classic version of this bug.
    assert.equal(driveFileIdFromUrl("https://drive.google.com.evil.test/file/d/1sEISJBJaGRYpivooQJBR/view"), null);
});

// ── 8. the constraint comparison converges instead of churning ────────────

/** SQL `translate(x, '" ', '')`: drop every double quote and space. */
const stripQuotesAndSpaces = (value: string) => value.split('"').join("").split(" ").join("");

/** The literals the two guarded DO blocks compare `pg_get_constraintdef` against. */
function expectedDefinitions(sql: string): string[] {
    const found: string[] = [];
    const pattern = /<>\s*translate\('((?:[^']|'')*)',\s*'" ',\s*''\)/g;
    for (const match of sql.matchAll(pattern)) found.push(match[1].replace(/''/g, "'"));
    return found;
}

test("the expected definitions are what Postgres actually emits", () => {
    // Real `pg_get_constraintdef` output for these two CHECKs. The camelCase
    // column comes back QUOTED — which the old expected string omitted, so the
    // ELSIF fired on every application and dropped and re-added a constraint
    // that was already correct.
    const real = [
        `CHECK (("sourceOfRecord" = ANY (ARRAY['STATEMENT'::text, 'QBO'::text])))`,
        `CHECK ((status = ANY (ARRAY['PENDING'::text, 'POSTING'::text, 'POSTED'::text, 'UNCERTAIN'::text])))`,
    ];
    for (const sql of [migrationSql, applyScript]) {
        const expected = expectedDefinitions(sql);
        assert.equal(expected.length, 2, "both DO blocks compare a definition");
        for (let i = 0; i < real.length; i++) {
            assert.equal(
                stripQuotesAndSpaces(expected[i]),
                stripQuotesAndSpaces(real[i]),
                `a second application would drop and re-add:\n  ${real[i]}`,
            );
        }
    }
});

test("the old literal comparison really did differ — the regression is real", () => {
    const old = `CHECK ((sourceOfRecord = ANY (ARRAY['STATEMENT'::text, 'QBO'::text])))`;
    const real = `CHECK (("sourceOfRecord" = ANY (ARRAY['STATEMENT'::text, 'QBO'::text])))`;
    assert.notEqual(old, real, "which is why every run did DDL");
    assert.equal(stripQuotesAndSpaces(old), stripQuotesAndSpaces(real), "and why normalising fixes it");
});

test("neither file still compares the raw definition", () => {
    for (const sql of [migrationSql, applyScript]) {
        assert.doesNotMatch(sql, /current_def <> 'CHECK \(\('/);
        // Both sides go through the same normalisation, or it is not a comparison.
        assert.equal((sql.match(/translate\(current_def, '" ', ''\)/g) ?? []).length, 2);
    }
});
