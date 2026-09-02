import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReviewIssue, type ReviewIssueLifecycleClient, type ReviewIssueRow } from "../src/lib/review-alert-lifecycle";
import { decodeReasonCodes } from "../src/lib/review-alert-reasons";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    RECEIPT_REQUEST_TARGET_TYPE,
    hasResolution,
    mergeReceiptRequestDetails,
    planReceiptRequests,
    type ReceiptEvidenceExpense,
    type ReceiptRequestBankLine,
} from "../src/lib/receipt-requests";
import {
    applyReceiptRequestPlan,
    evidenceBoundsFor,
    shouldResumeSweep,
    sweepPhaseAfter,
} from "../src/app/api/cron/receipt-requests/route";

/**
 * The whole promise of the nightly sweep in one file: run it twice over
 * identical data and the second pass writes nothing new. This runs the REAL
 * `evaluateReviewIssue` against an in-memory client rather than a fake
 * lifecycle, because the idempotency actually lives in that decision tree
 * (steps 5 and 1) — a stubbed lifecycle would prove nothing.
 *
 * No `mock.module` anywhere: CI pins Node 20, where it corrupts the require
 * chain.
 */

function inMemoryLifecycle() {
    const issues = new Map<string, ReviewIssueRow>();
    const episodes: Array<{ issueId: string; generation: number; status: string }> = [];
    let seq = 0;

    const client: ReviewIssueLifecycleClient = {
        reviewIssue: {
            async findUnique(args) {
                if ("id" in args.where) {
                    const { id } = args.where;
                    return [...issues.values()].find(row => row.id === id) ?? null;
                }
                const { targetType, targetKey } = args.where.targetType_targetKey;
                return issues.get(`${targetType}::${targetKey}`) ?? null;
            },
            async create(args) {
                const data = args.data as Record<string, unknown>;
                const key = `${data.targetType}::${data.targetKey}`;
                if (issues.has(key)) throw Object.assign(new Error("unique"), { code: "P2002" });
                const row: ReviewIssueRow = {
                    id: `ri-${++seq}`,
                    targetType: String(data.targetType),
                    targetKey: String(data.targetKey),
                    version: 1,
                    reasonCodes: String(data.reasonCodes),
                    reasonHash: String(data.reasonHash),
                    displayDetails: (data.displayDetails as string | null) ?? null,
                    acknowledgedCodes: String(data.acknowledgedCodes ?? "[]"),
                    acknowledgedAt: null,
                    firstObservedAt: data.firstObservedAt as Date,
                    clearedAt: null,
                    currentGeneration: Number(data.currentGeneration),
                };
                issues.set(key, row);
                return row;
            },
            async updateMany(args) {
                const row = [...issues.values()].find(r => r.id === args.where.id);
                if (!row || row.version !== args.where.version) return { count: 0 };
                for (const [field, value] of Object.entries(args.data)) {
                    if (field === "version" && typeof value === "object" && value !== null) {
                        row.version += Number((value as { increment: number }).increment);
                        continue;
                    }
                    (row as unknown as Record<string, unknown>)[field] = value;
                }
                return { count: 1 };
            },
        },
        reviewAlertEpisode: {
            async create(args) {
                const data = args.data as Record<string, unknown>;
                episodes.push({ issueId: String(data.issueId), generation: Number(data.generation), status: String(data.status) });
                return data;
            },
            async updateMany(args) {
                const where = args.where as { issueId?: string; generation?: number; status?: { in: string[] } };
                let count = 0;
                for (const episode of episodes) {
                    if (where.issueId && episode.issueId !== where.issueId) continue;
                    if (where.generation !== undefined && episode.generation !== where.generation) continue;
                    if (where.status?.in && !where.status.in.includes(episode.status)) continue;
                    episode.status = String((args.data as { status: string }).status);
                    count++;
                }
                return { count };
            },
        },
        async $transaction(fn) {
            return fn(client);
        },
    };

    return { client, issues, episodes };
}

const NOW = new Date("2026-08-20T09:00:00Z");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const LINES: ReceiptRequestBankLine[] = [
    { id: "bl-lowes", postedDate: "2026-08-16", amountCents: -12_345, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null },
    { id: "bl-depot", postedDate: "2026-08-15", amountCents: -8_900, rawDescriptor: "HOMEDEPOT.COM C#6098", checkNumber: null },
    { id: "bl-loan", postedDate: "2026-08-14", amountCents: -150_000, rawDescriptor: "INDIVIDUAL LOAN PAYMENTS", checkNumber: null },
];

function run(store: ReturnType<typeof inMemoryLifecycle>, expenses: ReceiptEvidenceExpense[]) {
    const openIssueKeys = [...store.issues.values()]
        .filter(row => row.targetType === RECEIPT_REQUEST_TARGET_TYPE && row.clearedAt === null)
        .map(row => row.targetKey);

    const plan = planReceiptRequests({ bankLines: LINES, expenses, intakes: [], openIssueKeys, now: NOW });

    return applyReceiptRequestPlan(plan, (targetKey, codes, displayDetails) =>
        evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, targetKey, codes, displayDetails, {
            episodeStatus: "SUPPRESSED",
            client: store.client,
            now: () => NOW,
        }));
}

test("two consecutive runs over identical input produce zero new issues and zero new episodes", async () => {
    const store = inMemoryLifecycle();

    const first = await run(store, []);
    assert.deepEqual(first, { opened: 2, closed: 0, touched: 0, skipped: 0, errors: 0, failedTargets: [] });
    assert.equal(store.issues.size, 2, "the exempt loan payment never opens an issue");
    assert.equal(store.episodes.length, 2);

    const second = await run(store, []);
    assert.equal(second.opened, 0, "nothing new opens on an unchanged night");
    assert.equal(second.closed, 0);
    assert.equal(second.touched, 2, "same hash, same displayDetails — a pure touch");
    assert.equal(store.issues.size, 2, "no duplicate issue for an already-open targetKey");
    assert.equal(store.episodes.length, 2, "no second episode, so no second card");
});

test("every episode ships SUPPRESSED — these never ride the per-issue drainer", async () => {
    const store = inMemoryLifecycle();
    await run(store, []);
    assert.ok(store.episodes.length > 0);
    assert.ok(store.episodes.every(e => e.status === "SUPPRESSED"));
});

test("the issues carry exactly ['MISSING_RECEIPT'] and survive a decode round-trip", async () => {
    const store = inMemoryLifecycle();
    await run(store, []);
    for (const row of store.issues.values()) {
        assert.deepEqual(decodeReasonCodes(row.reasonCodes), ["MISSING_RECEIPT"],
            "a code missing from KNOWN_CODES would decode to [] and self-destruct as 'cleared'");
    }
});

test("evidence appears → close; evidence disappears → reopen at the next generation, still one issue", async () => {
    const store = inMemoryLifecycle();
    await run(store, []);

    const matched: ReceiptEvidenceExpense[] = [{ id: "exp-1", hasReceipt: true, amountCents: 12_345, date: "2026-08-16", vendor: "Lowe's Home Improvement" }];
    const closing = await run(store, matched);
    assert.equal(closing.closed, 1);
    const lowes = store.issues.get(`${RECEIPT_REQUEST_TARGET_TYPE}::bl-lowes`)!;
    assert.notEqual(lowes.clearedAt, null);
    assert.equal(lowes.currentGeneration, 1);

    // Closing again is a no-op — never a second clear, never a new episode.
    const closingAgain = await run(store, matched);
    assert.equal(closingAgain.closed, 0);
    assert.equal(store.episodes.length, 2);

    // The expense is deleted; the chase must come back.
    const reopening = await run(store, []);
    assert.equal(reopening.opened, 1);
    assert.equal(store.issues.size, 2, "still ONE issue per bank line, not a second row");
    assert.equal(store.issues.get(`${RECEIPT_REQUEST_TARGET_TYPE}::bl-lowes`)!.currentGeneration, 2);
    assert.equal(store.episodes.length, 3);
    assert.ok(store.episodes.every(e => e.status === "SUPPRESSED"));
});

test("a corrected displayDetails reaches the row without opening a new generation", async () => {
    const store = inMemoryLifecycle();
    await run(store, []);
    const before = store.issues.get(`${RECEIPT_REQUEST_TARGET_TYPE}::bl-lowes`)!;
    const beforeGeneration = before.currentGeneration;

    const restated: ReceiptRequestBankLine[] = LINES.map(l =>
        l.id === "bl-lowes" ? { ...l, rawDescriptor: "LOWES #02516 STORE 4718 POS DEB C#8516" } : l);
    const plan = planReceiptRequests({ bankLines: restated, expenses: [], intakes: [], openIssueKeys: ["bl-lowes", "bl-depot"], now: NOW });
    await applyReceiptRequestPlan(plan, (targetKey, codes, displayDetails) =>
        evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, targetKey, codes, displayDetails, {
            episodeStatus: "SUPPRESSED", client: store.client, now: () => NOW,
        }));

    const after = store.issues.get(`${RECEIPT_REQUEST_TARGET_TYPE}::bl-lowes`)!;
    assert.equal(after.currentGeneration, beforeGeneration, "displayDetails is deliberately not hashed");
    assert.ok(after.displayDetails!.includes("STORE 4718"));
    assert.equal(store.episodes.length, 2, "no new episode for a display-only change");
});

test("a failing target is RETAINED as an error, and the rest still run", async () => {
    const plan = planReceiptRequests({ bankLines: LINES, expenses: [], intakes: [], openIssueKeys: [], now: NOW });
    const seen: string[] = [];
    const summary = await applyReceiptRequestPlan(plan, async targetKey => {
        seen.push(targetKey);
        if (targetKey === "bl-lowes") throw new Error("version conflict storm");
        return { decision: { step: 2, action: "create", canonicalCodes: ["MISSING_RECEIPT"], reasonHash: "x", openGeneration: 1 }, applied: true };
    });
    // Oldest charge first — the matcher's own deterministic order, not the
    // caller's input order (that is what makes evidence assignment stable).
    assert.deepEqual(seen, ["bl-depot", "bl-lowes"]);
    // A THROW is an error, not a skip. Folding the two together is how a night
    // where every write failed reported "0 errors, all quiet", and the caller
    // needs `failedTargets` to know not to advance its cursor past them.
    assert.deepEqual(summary, {
        opened: 1, closed: 0, touched: 0, skipped: 0, errors: 1, failedTargets: ["bl-lowes"],
    });
});

test("a memo signed DURING the sweep is not un-answered by it", async () => {
    // The sweep loads everything up front and then works through it. The
    // answers endpoint can write a resolution and clear an issue in that
    // window; a merge from the run-start snapshot would write the stale
    // details back over it and reopen something a human just answered.
    const store = inMemoryLifecycle();
    await run(store, []);
    const key = `${RECEIPT_REQUEST_TARGET_TYPE}::bl-lowes`;

    // Mid-run: the memo is signed. Resolution recorded, issue cleared.
    const signed = store.issues.get(key)!;
    signed.displayDetails = JSON.stringify({
        ...JSON.parse(signed.displayDetails!),
        resolution: "memo-signed",
        pdfUrl: "https://drive.example/memo.pdf",
    });
    signed.clearedAt = NOW;

    // The sweep's snapshot still says "open and unresolved", so it plans a
    // reopen. The per-issue FRESH READ is what must stop it.
    const plan = planReceiptRequests({ bankLines: LINES, expenses: [], intakes: [], openIssueKeys: [], resolvedIssueKeys: [], now: NOW });
    const summary = await applyReceiptRequestPlan(plan, async (targetKey, codes, displayDetails) => {
        const fresh = store.issues.get(`${RECEIPT_REQUEST_TARGET_TYPE}::${targetKey}`);
        const freshDetails = fresh?.displayDetails ? JSON.parse(fresh.displayDetails) : {};
        if (codes.length > 0 && hasResolution(freshDetails)) {
            return { decision: { step: 1, action: "noop", canonicalCodes: [], reasonHash: "" }, applied: false };
        }
        return evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, targetKey, codes,
            displayDetails ? mergeReceiptRequestDetails(freshDetails, displayDetails) : null,
            { episodeStatus: "SUPPRESSED", client: store.client, now: () => NOW });
    });

    assert.equal(summary.skipped, 1, "the resolved issue is skipped, not reopened");
    const after = store.issues.get(key)!;
    assert.notEqual(after.clearedAt, null, "it stays cleared");
    const details = JSON.parse(after.displayDetails!);
    assert.equal(details.resolution, "memo-signed", "and the answer survives");
    assert.equal(details.pdfUrl, "https://drive.example/memo.pdf");
});

test("the sweep's real apply path reads fresh, not from the run-start snapshot", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    // The apply path is per COMPONENT and inside its transaction now, so the
    // fresh read is on `tx` — same rule, one scope tighter.
    const applyAt = source.indexOf("const applied = await applyReceiptRequestPlan(");
    const freshReadAt = source.indexOf("const fresh = await tx.reviewIssue.findUnique(");
    assert.ok(applyAt > 0 && freshReadAt > applyAt, "the read must be INSIDE the per-issue callback");
    assert.match(source, /if \(codes\.length > 0 && hasResolution\(freshDetails\)\)/);
    assert.match(source, /mergeReceiptRequestDetails\(freshDetails, displayDetails\)/);
});

// ── Evidence bounds: a DATE column and a TIMESTAMP column are not the same ──

test("DB-level bounds: txnDate gets calendar days, Expense.date gets instants", () => {
    // ReceiptIntake.txnDate is `@db.Date` — a calendar day with no zone, which
    // Postgres hands back at UTC midnight. Expense.date is a TIMESTAMP, a real
    // instant whose day boundary is the company's midnight. ONE shared range
    // could not be right for both; it was simply wrong for one of them.
    const zone = "America/Los_Angeles";
    const bounds = evidenceBoundsFor("2026-08-16", "2026-08-18", zone);

    // Half-open at both ends: first allowed day in, day AFTER the last day out.
    assert.equal(bounds.calendar.gte.toISOString(), "2026-08-16T00:00:00.000Z");
    assert.equal(bounds.calendar.lt.toISOString(), "2026-08-19T00:00:00.000Z");
    // August = PDT = UTC-7.
    assert.equal(bounds.timestamp.gte.toISOString(), "2026-08-16T07:00:00.000Z");
    assert.equal(bounds.timestamp.lt.toISOString(), "2026-08-19T07:00:00.000Z");

    const inRange = (row: Date, r: { gte: Date; lt: Date }) => row >= r.gte && row < r.lt;

    // A DATE row on the FIRST allowed day. This is the row the shared range
    // dropped: 00:00Z is before Pacific midnight, so an intake filed on the
    // first day of the window was invisible and its charge got chased.
    const firstDayIntake = new Date("2026-08-16T00:00:00Z");
    assert.equal(inRange(firstDayIntake, bounds.calendar), true);
    assert.equal(inRange(firstDayIntake, bounds.timestamp), false, "the bug, in one line");

    // And the other end: a DATE row on the day AFTER the window was let IN.
    const dayAfterIntake = new Date("2026-08-19T00:00:00Z");
    assert.equal(inRange(dayAfterIntake, bounds.calendar), false);
    assert.equal(inRange(dayAfterIntake, bounds.timestamp), true, "off by one, both ways");

    // A TIMESTAMP expense filed at 5pm Pacific on the LAST allowed day still
    // counts — that is what the half-open upper bound bought.
    assert.equal(inRange(new Date("2026-08-19T00:00:00Z"), bounds.timestamp), true);
    // But one filed after Pacific midnight the next day does not.
    assert.equal(inRange(new Date("2026-08-19T08:00:00Z"), bounds.timestamp), false);
});

test("the sweep sends each bound to the column it belongs to", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-requests/route.ts"),
        "utf8",
    );
    assert.match(source, /where: \{ date: range\.timestamp \}/);
    assert.match(source, /where: \{ txnDate: range\.calendar, state:/);
    // BankLine.postedDate is `@db.Date` too — the component walk builds its own
    // calendar bounds from the same rule.
    assert.match(source, /gte: new Date\(`\$\{fromYmd\}T00:00:00Z`\),/);
    assert.doesNotMatch(source, /where: \{ date: range \}/, "one shared range is the bug");
});

// ── The run-phase marker (round-11 item 3) ─────────────────────────────────

test("budget spent right after the LAST open-issue page leaves phase 'lines'", () => {
    // THE BUG: both cursors are cleared the moment their pass completes, so a
    // run that finished the open-issue pass and then ran out of budget parked
    // NEITHER — `?continue=1` saw "nothing in progress", exited, and the line
    // half of the sweep waited for tomorrow's full sweep.
    const phase = sweepPhaseAfter({
        openExhausted: true, openErrors: 0,
        lineExhausted: false, lineErrors: 0,
    });
    assert.equal(phase, "lines");
    // With no cursor anywhere, the phase alone has to carry the resume.
    assert.equal(shouldResumeSweep(phase, null, null), true);
});

test("the phase says which half is unfinished, and errors keep it unfinished", () => {
    const at = (over: Partial<Parameters<typeof sweepPhaseAfter>[0]>) => sweepPhaseAfter({
        openExhausted: true, openErrors: 0, lineExhausted: true, lineErrors: 0, ...over,
    });
    assert.equal(at({}), "done");
    assert.equal(at({ openExhausted: false }), "open-issues");
    // A pass that errored parked its cursor on the failure; the phase must keep
    // pointing at it or the next resume steps over the row that failed.
    assert.equal(at({ openErrors: 1 }), "open-issues");
    assert.equal(at({ lineExhausted: false }), "lines");
    assert.equal(at({ lineErrors: 1 }), "lines");

    // A finished cycle is the ONLY thing a resume pass may skip.
    assert.equal(shouldResumeSweep("done", null, null), false);
    assert.equal(shouldResumeSweep("open-issues", null, null), true);
    // Cursors written before the phase marker existed still resume.
    assert.equal(shouldResumeSweep("done", "2026-08-01|bl-1", null), true);
    assert.equal(shouldResumeSweep("done", null, "ri-1"), true);
});

test("a resume already past the open pass does not redo it", () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src/app/api/cron/receipt-requests/route.ts"),
        "utf8",
    );
    // The pass is skipped, not merely fast: re-running it would eat the budget
    // the line pass has been waiting for.
    assert.match(source, /while \(startPhase !== "lines" && Date\.now\(\) - startedAt < RUN_BUDGET_MS\)/);
    assert.match(source, /let openExhausted = startPhase === "lines";/);
    // The phase is persisted from what actually happened, in one place.
    assert.match(source, /const phase = sweepPhaseAfter\(\{/);
    // It also stamps the completion the morning cards cron waits for.
    assert.match(source, /await writePhase\(phase, phase === "done" \? new Date\(\)\.toISOString\(\) : undefined\);/);
    // A scheduled (non-resume) run always starts a fresh cycle.
    assert.match(source, /runSweep\(now, continueOnly \? resumePhase : "open-issues"\)/);
});
