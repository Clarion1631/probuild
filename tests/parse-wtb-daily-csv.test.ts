import assert from "node:assert/strict";
import test from "node:test";
import {
    buildDayStatements,
    parseArgs,
    buildSweepPayload,
    canSweepDay,
    postSweep,
    resolveSweepSecret,
    sweepBatchFailed,
    sweepCreditLine,
    sweepCreditNeedsAttention,
    sweepSummaryLine,
    REPOST_FLOOR,
    DAILY_CANONICAL_FROM,
} from "../scripts/parse-wtb-daily-csv.mjs";

// Fixture note: none of this is real Golden Touch financial data. These are
// synthetic "Balances and Transactions" CSV rows built to the same column
// geometry the real Washington Trust Bank daily export emits, so the money
// gates can be exercised without touching a real statement.
//
// These cases encode the Codex round-2 review findings. Each one is a way
// wrong data could have reached the ledger; the parser must refuse.

const HEADER = "Post Date,Bank ID,Account Number,Account Name,Currency,Description,BAI Code,Amount,Status,Debit/Credit,Bank Reference,Customer Reference,Transaction Detail,Type,Image";
const ACCT = "125100089,1001780723,BUS CKG 0723,USD";

function row(
    date: string,
    desc: string,
    bai: string,
    amount: string,
    status = "",
    custRef = "",
    detail = "",
    bankRef = "",
) {
    return `${date},${ACCT},${desc},${bai},${amount},${status},,${bankRef},${custRef},${detail},,`;
}

function build(lines: string[]) {
    return buildDayStatements([HEADER, ...lines].join("\n"), "WTB-0723");
}

const OPEN = (d: string, amt: string) => row(d, "OPENING LEDGER", "010", amt);
const CLOSE = (d: string, amt: string) => row(d, "CLOSING LEDGER", "015", amt);

test("B-1: money-bearing rows cannot hide behind a blank Status", async t => {
    await t.test("an offsetting ghost PAIR is refused", () => {
        // The pair nets to zero, so opening+sum==closing still balances. Only
        // the BAI whitelist catches this — it was the round-2 blocker.
        assert.throws(
            () => build([
                OPEN("08/12/2026", "100.00"),
                CLOSE("08/12/2026", "90.00"),
                row("08/12/2026", "MISCELLANEOUS DEBIT REAL", "699", "-10.00", "Cleared"),
                row("08/12/2026", "GHOST OUT", "699", "-500.00"),
                row("08/12/2026", "GHOST IN", "699", "500.00"),
            ]),
            /unrecognized BAI code/,
        );
    });

    await t.test("genuine summary rows still skip cleanly", () => {
        const { complete } = build([
            OPEN("08/12/2026", "100.00"),
            CLOSE("08/12/2026", "90.00"),
            row("08/12/2026", "CURRENT LEDGER", "030", "90.00"),
            row("08/12/2026", "OPENING AVAILABLE", "040", "100.00"),
            row("08/12/2026", "CLOSING AVAILABLE", "045", "90.00"),
            row("08/12/2026", "CURRENT AVAILABLE", "060", "90.00"),
            row("08/12/2026", "1-DAY FLOAT", "072", "0"),
            row("08/12/2026", "2 OR MORE DAYS FLOAT", "074", "0"),
            row("08/12/2026", "MISCELLANEOUS DEBIT REAL", "699", "-10.00", "Cleared"),
        ]);
        assert.equal(complete.length, 1);
        assert.equal(complete[0].lines.length, 1);
    });
});

test("B-1: the bank's own credit/debit sub-totals are enforced", async t => {
    await t.test("credit mismatch is refused", () => {
        assert.throws(
            () => build([
                OPEN("08/12/2026", "100.00"),
                CLOSE("08/12/2026", "90.00"),
                row("08/12/2026", "TOTAL CREDITS", "100", "25.00"),
                row("08/12/2026", "MISCELLANEOUS DEBIT REAL", "699", "-10.00", "Cleared"),
            ]),
            /FAILS credit sub-total/,
        );
    });

    await t.test("debit mismatch is refused", () => {
        assert.throws(
            () => build([
                OPEN("08/12/2026", "100.00"),
                CLOSE("08/12/2026", "90.00"),
                row("08/12/2026", "TOTAL DEBITS", "400", "-99.00"),
                row("08/12/2026", "MISCELLANEOUS DEBIT REAL", "699", "-10.00", "Cleared"),
            ]),
            /FAILS debit sub-total/,
        );
    });

    await t.test("matching sub-totals pass", () => {
        const { complete } = build([
            OPEN("08/12/2026", "100.00"),
            CLOSE("08/12/2026", "115.00"),
            row("08/12/2026", "TOTAL CREDITS", "100", "25.00"),
            row("08/12/2026", "TOTAL DEBITS", "400", "-10.00"),
            row("08/12/2026", "MISCELLANEOUS DEBIT REAL", "699", "-10.00", "Cleared"),
            row("08/12/2026", "OTHER DEPOSITS", "165", "25.00", "Cleared"),
        ]);
        assert.equal(complete.length, 1);
        assert.equal(complete[0].lines.length, 2);
    });
});

test("B-2: the payload is content-addressed, not transport-order-addressed", () => {
    // WTB re-orders rows between pulls. Since the 7-day window re-posts each
    // completed day several times, an unsorted payload would turn a cosmetic
    // re-order into a 409 that stalls every later day.
    const txns = [
        row("08/12/2026", "MISCELLANEOUS DEBIT A", "699", "-10.00", "Cleared"),
        row("08/12/2026", "MISCELLANEOUS DEBIT B", "699", "-20.00", "Cleared"),
        row("08/12/2026", "OTHER DEPOSITS C", "165", "30.00", "Cleared"),
    ];
    const withOrder = (order: number[]) => JSON.stringify(
        build([OPEN("08/12/2026", "100.00"), CLOSE("08/12/2026", "100.00"), ...order.map(i => txns[i])]).complete,
    );

    const canonical = withOrder([0, 1, 2]);
    assert.equal(withOrder([2, 0, 1]), canonical);
    assert.equal(withOrder([1, 2, 0]), canonical);
    assert.equal(withOrder([2, 1, 0]), canonical);
});

test("S-1: descriptor whitespace is collapsed so cosmetic spacing never re-hashes", () => {
    const { complete } = build([
        OPEN("08/12/2026", "100.00"),
        CLOSE("08/12/2026", "90.00"),
        row("08/12/2026", "AUTOMATIC LOAN PAYMENT", "699", "-10.00", "Cleared", "", "Acct No.        350080610"),
    ]);
    const descriptor = complete[0].lines[0].rawDescriptor;
    assert.ok(!/ {2}/.test(descriptor), `expected collapsed whitespace, got ${JSON.stringify(descriptor)}`);
    assert.equal(descriptor, "AUTOMATIC LOAN PAYMENT Acct No. 350080610");
});

test("S-2: a ragged/truncated row is refused rather than silently reshaped", () => {
    assert.throws(
        () => build([
            OPEN("08/12/2026", "100.00"),
            CLOSE("08/12/2026", "90.00"),
            "08/12/2026,125100089,1001780723,BUS CKG 0723,USD,TRUNCATED,699,-10.00",
        ]),
        /ragged|truncated|column/i,
    );
});

test("S-4: check numbers are one identity across both parsers", async t => {
    await t.test("leading zeros are stripped", () => {
        const { complete } = build([
            OPEN("08/12/2026", "100.00"),
            CLOSE("08/12/2026", "90.00"),
            row("08/12/2026", "CHECK PAID", "475", "-10.00", "Cleared", "01027"),
        ]);
        assert.equal(complete[0].lines[0].checkNumber, "1027");
    });

    await t.test("a descriptor variant still yields the check number", () => {
        const { complete } = build([
            OPEN("08/12/2026", "100.00"),
            CLOSE("08/12/2026", "90.00"),
            row("08/12/2026", "CHECK PAID - RETURN", "475", "-10.00", "Cleared", "1027"),
        ]);
        assert.equal(complete[0].lines[0].checkNumber, "1027");
    });
});

test("control totals and continuity (round-1 regressions)", async t => {
    await t.test("a single dropped row fails the control total", () => {
        assert.throws(
            () => build([
                OPEN("08/12/2026", "100.00"),
                CLOSE("08/12/2026", "50.00"),
                row("08/12/2026", "MISCELLANEOUS DEBIT REAL", "699", "-10.00", "Cleared"),
            ]),
            /FAILS control total/,
        );
    });

    await t.test("a quiet day is skipped loudly, not posted empty", () => {
        const { complete, skipped } = build([OPEN("08/12/2026", "100.00"), CLOSE("08/12/2026", "100.00")]);
        assert.equal(complete.length, 0);
        assert.equal(skipped.length, 1);
        assert.match(skipped[0].reason, /no cleared transactions/);
    });

    await t.test("a balance discontinuity between days is refused", () => {
        assert.throws(
            () => build([
                OPEN("08/12/2026", "100.00"),
                CLOSE("08/12/2026", "90.00"),
                row("08/12/2026", "MISCELLANEOUS DEBIT A", "699", "-10.00", "Cleared"),
                OPEN("08/14/2026", "70.00"),
                CLOSE("08/14/2026", "60.00"),
                row("08/14/2026", "MISCELLANEOUS DEBIT B", "699", "-10.00", "Cleared"),
            ]),
            /continuity break/,
        );
    });

    await t.test("a weekend gap chains correctly", () => {
        const { complete } = build([
            OPEN("08/14/2026", "100.00"),
            CLOSE("08/14/2026", "90.00"),
            row("08/14/2026", "MISCELLANEOUS DEBIT FRI", "699", "-10.00", "Cleared"),
            OPEN("08/17/2026", "90.00"),
            CLOSE("08/17/2026", "80.00"),
            row("08/17/2026", "MISCELLANEOUS DEBIT MON", "699", "-10.00", "Cleared"),
        ]);
        assert.equal(complete.length, 2);
    });

    await t.test("pending rows are never ingested but are counted", () => {
        const { complete } = build([
            OPEN("08/12/2026", "100.00"),
            CLOSE("08/12/2026", "90.00"),
            row("08/12/2026", "MISCELLANEOUS DEBIT A", "699", "-10.00", "Cleared"),
            row("08/12/2026", "MISCELLANEOUS DEBIT P", "699", "-999.00", "Pending"),
        ]);
        assert.equal(complete[0].lines.length, 1);
        assert.equal(complete[0].pending, 1);
    });

    await t.test("days before the daily-canonical boundary are refused", () => {
        const { complete, skipped } = build([
            OPEN("08/01/2026", "100.00"),
            CLOSE("08/01/2026", "90.00"),
            row("08/01/2026", "MISCELLANEOUS DEBIT OLD", "699", "-10.00", "Cleared"),
        ]);
        assert.equal(complete.length, 0);
        assert.equal(skipped.length, 1);
        assert.match(skipped[0].reason, /before DAILY_CANONICAL_FROM/);
    });
});

test("money is integer cents only — no float, no coercion of odd formats", async t => {
    // Note: "1,090.00" is quoted so it stays ONE CSV field. Unquoted it would
    // split into an extra column and be caught by the S-2 ragged-row gate
    // instead, which would not actually exercise the cents parser.
    const bad = ['"1,090.00"', ".50", "+5", "abc", "10.005"];
    for (const amount of bad) {
        await t.test(`refuses Amount ${JSON.stringify(amount)}`, () => {
            assert.throws(
                () => build([
                    OPEN("08/12/2026", "100.00"),
                    CLOSE("08/12/2026", "90.00"),
                    row("08/12/2026", "MISCELLANEOUS DEBIT", "699", amount, "Cleared"),
                ]),
                /unparseable Amount|FAILS control total/,
            );
        });
    }

    await t.test("exact cents survive a round trip", () => {
        const { complete } = build([
            OPEN("08/12/2026", "46954.98"),
            CLOSE("08/12/2026", "46944.97"),
            row("08/12/2026", "MISCELLANEOUS DEBIT", "699", "-10.01", "Cleared"),
        ]);
        assert.equal(complete[0].openingCents, 4695498);
        assert.equal(complete[0].closingCents, 4694497);
        assert.equal(complete[0].lines[0].amountCents, -1001);
    });
});

test("the hash-format epoch is separate from the source-of-truth boundary", () => {
    // Conflating these would tell the monthly PDF parser it owns days the
    // daily ledger already holds — the double-minting DAILY_CANONICAL_FROM
    // exists to prevent.
    assert.notEqual(REPOST_FLOOR, DAILY_CANONICAL_FROM);
    assert.ok(REPOST_FLOOR > DAILY_CANONICAL_FROM);
});

// ── Deposit sweep (--sweep): the trigger this script carries for the daily
//    bank-credit auto-apply. See docs/plans/DEPOSIT-SWEEP-PLAN.md.

/** The real Washington Trust shape for a customer deposit: BAI 174 /
 *  OTHER DEPOSITS, with the Transaction Detail saying how it arrived. */
const CREDIT = (d: string, amt: string, bankRef: string, detail = "DEPOSIT - DDA/MMKT", desc = "OTHER DEPOSITS", bai = "174") =>
    row(d, desc, bai, amt, "Cleared", "", detail, bankRef);

test("sweep: a day carries its CREDIT rows, keyed by the bank reference", () => {
    const { complete } = build([
        OPEN("08/24/2026", "100.00"),
        CLOSE("08/24/2026", "13537.68"),
        row("08/24/2026", "TOTAL CREDITS", "100", "13447.68"),
        row("08/24/2026", "TOTAL DEBITS", "400", "-10.00"),
        CREDIT("08/24/2026", "13447.68", "26236015002406"),
        row("08/24/2026", "MISCELLANEOUS DEBIT", "699", "-10.00", "Cleared"),
    ]);

    assert.equal(complete.length, 1);
    const day = complete[0];
    assert.equal(day.credits.length, 1, "only money IN is a credit");
    // The three class fields stay SEPARATE and unmerged: the endpoint's
    // allowlist reads them independently, and the ledger's combined descriptor
    // is no use for deciding whether this is a customer payment at all.
    assert.deepEqual(day.credits[0], {
        bankReference: "26236015002406",
        amount: 13447.68,
        amountCents: 1344768,
        baiCode: "174",
        description: "OTHER DEPOSITS",
        transactionDetail: "DEPOSIT - DDA/MMKT",
        customerReference: null,
    });
    assert.equal(day.totalCreditsCents, 1344768);

    // The sweep fields must never ride along on a LEDGER line: the statement
    // route content-addresses those objects, so an extra key would re-hash
    // every stored day and 409 the whole pipeline.
    for (const line of day.lines) {
        assert.deepEqual(Object.keys(line).sort(), ["amountCents", "checkNumber", "postedDate", "rawDescriptor"]);
    }
});

test("sweep: the payload carries the BANK's own control totals", () => {
    const { complete } = build([
        OPEN("08/24/2026", "0.00"),
        CLOSE("08/24/2026", "1500.00"),
        row("08/24/2026", "TOTAL CREDITS", "100", "1500.00"),
        CREDIT("08/24/2026", "500.00", "REF-A"),
        CREDIT("08/24/2026", "1000.00", "REF-B"),
    ]);

    const payload = buildSweepPayload(complete[0]);
    assert.equal(payload.source, "bank");
    assert.equal(payload.postDate, "2026-08-24");
    assert.equal(payload.creditCount, 2);
    assert.equal(payload.creditSum, 1500);
    assert.deepEqual(payload.credits.map((c: any) => c.bankReference), ["REF-A", "REF-B"]);
    // Exactly the fields the endpoint reads — amountCents stays internal.
    assert.deepEqual(
        Object.keys(payload.credits[0]).sort(),
        ["amount", "baiCode", "bankReference", "customerReference", "description", "transactionDetail"],
    );
    assert.equal("dryRun" in payload, false, "a live sweep sends no dryRun flag at all");
    assert.equal(buildSweepPayload(complete[0], { dryRun: true }).dryRun, true);
});

test("sweep: a credit-bearing day with NO independent TOTAL CREDITS row is not swept", async t => {
    const withoutControlRow = build([
        OPEN("08/24/2026", "0.00"),
        CLOSE("08/24/2026", "750.25"),
        CREDIT("08/24/2026", "750.25", "REF-SOLO"),
    ]).complete[0];

    await t.test("canSweepDay refuses it, and calls it a job failure", () => {
        // Deriving creditSum from the rows it is meant to check makes the
        // endpoint's control total a tautology: a day whose export silently
        // dropped a deposit would post a sum matching the rows perfectly.
        const verdict = canSweepDay(withoutControlRow);
        assert.equal(verdict.ok, false);
        assert.equal(verdict.failure, true);
        assert.match(verdict.reason, /no TOTAL CREDITS control row, sweep skipped/);
    });

    await t.test("and buildSweepPayload refuses to invent one", () => {
        assert.throws(() => buildSweepPayload(withoutControlRow), /no TOTAL CREDITS control row/);
    });

    await t.test("a day with the control row sweeps normally", () => {
        const withControlRow = build([
            OPEN("08/24/2026", "0.00"),
            CLOSE("08/24/2026", "750.25"),
            row("08/24/2026", "TOTAL CREDITS", "100", "750.25"),
            CREDIT("08/24/2026", "750.25", "REF-SOLO"),
        ]).complete[0];
        assert.equal(canSweepDay(withControlRow).ok, true);
        assert.equal(buildSweepPayload(withControlRow).creditSum, 750.25);
    });

    await t.test("a day with NO credits needs no control row and is not a failure", () => {
        const quiet = build([
            OPEN("08/24/2026", "100.00"),
            CLOSE("08/24/2026", "90.00"),
            row("08/24/2026", "MISCELLANEOUS DEBIT", "699", "-10.00", "Cleared"),
        ]).complete[0];
        const verdict = canSweepDay(quiet);
        assert.equal(verdict.ok, false);
        assert.equal(verdict.failure, false, "nothing to sweep is not a failure");
    });
});

test("sweep: a debit-only day has nothing to sweep", () => {
    const { complete } = build([
        OPEN("08/24/2026", "100.00"),
        CLOSE("08/24/2026", "90.00"),
        row("08/24/2026", "MISCELLANEOUS DEBIT", "699", "-10.00", "Cleared"),
    ]);
    assert.deepEqual(complete[0].credits, []);
});

test("sweep: the secret comes from the environment, and its absence fails BEFORE any network call", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; return new Response("{}"); }) as typeof fetch;
    try {
        assert.throws(() => resolveSweepSecret({} as unknown as NodeJS.ProcessEnv), /DEPOSIT_INGEST_SECRET/);
        assert.throws(() => resolveSweepSecret({ DEPOSIT_INGEST_SECRET: "" } as unknown as NodeJS.ProcessEnv), /DEPOSIT_INGEST_SECRET/);
        assert.equal(resolveSweepSecret({ DEPOSIT_INGEST_SECRET: "s3cret" } as unknown as NodeJS.ProcessEnv), "s3cret");
        assert.equal(fetches, 0, "an unconfigured sweep must not have talked to the network");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("sweep: the POST goes to the deposit endpoint as a bearer, with the day's batch as its body", async () => {
    const { complete } = build([
        OPEN("08/24/2026", "0.00"),
        CLOSE("08/24/2026", "1500.00"),
        row("08/24/2026", "TOTAL CREDITS", "100", "1500.00"),
        CREDIT("08/24/2026", "1500.00", "REF-POST"),
    ]);

    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify({
            ok: true, source: "bank", postDate: "2026-08-24",
            counts: { credits: 1, applied: 1, proposed: 0, unmatched: 0, reconcile: 0, failed: 0, qboUnknown: 0, unresolved: 0, replay: 0 },
            credits: [{ bankReference: "REF-POST", status: "applied", replay: false }],
        }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        const result = await postSweep("https://probuild.example", "s3cret", complete[0], { dryRun: true });
        assert.equal(result.status, 200);
        assert.equal(result.body.counts.applied, 1);
        assert.equal(sweepBatchFailed(result.body, new Set(["REF-POST"])), false, "a well-formed answer passes every check");

        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, "https://probuild.example/api/payments/deposit-ingest");
        assert.equal(seen[0].init.headers.authorization, "Bearer s3cret");
        const sent = JSON.parse(seen[0].init.body);
        assert.equal(sent.source, "bank");
        assert.equal(sent.postDate, "2026-08-24");
        assert.equal(sent.creditCount, 1);
        assert.equal(sent.creditSum, 1500);
        assert.equal(sent.dryRun, true);
        assert.deepEqual(sent.credits[0].bankReference, "REF-POST");
        // The secret travels in the header only — never in the URL or the body.
        assert.equal(seen[0].url.includes("s3cret"), false);
        assert.equal(seen[0].init.body.includes("s3cret"), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("sweep: the Bot Health line reports every outcome bucket", () => {
    const clean = { credits: 4, applied: 1, proposed: 1, unmatched: 2, reconcile: 0, failed: 0, qboUnknown: 0, unresolved: 0, replay: 3 };
    assert.equal(
        sweepSummaryLine("2026-08-24", clean),
        "sweep 2026-08-24: 4 credits, 1 applied, 2 need-human, 1 proposed, 3 replay",
    );
    // A day that hit a QuickBooks outage must not read like a quiet day.
    assert.equal(
        sweepSummaryLine("2026-08-24", { ...clean, failed: 2, qboUnknown: 1 }),
        "sweep 2026-08-24: 4 credits, 1 applied, 2 need-human, 1 proposed, 3 replay, 2 failed, 1 qbo-unknown",
    );
    // …nor may a credit stuck mid-flight (a created QuickBooks payment whose
    // settle threw) hide inside a line that mentions no such thing.
    assert.equal(
        sweepSummaryLine("2026-08-24", { ...clean, unresolved: 1 }),
        "sweep 2026-08-24: 4 credits, 1 applied, 2 need-human, 1 proposed, 3 replay, 0 failed, 0 qbo-unknown, 1 unresolved",
    );
});

test("sweep: unresolved credits are a JOB FAILURE, so the watchdog fires", async t => {
    const counts = (over: Record<string, number> = {}) => ({
        credits: 1, applied: 1, proposed: 0, unmatched: 0, reconcile: 0, failed: 0, qboUnknown: 0, unresolved: 0, replay: 0, ...over,
    });
    /** A well-formed answer: the counts AND a per-credit line for each one. */
    const answer = (status: string, over: Record<string, number> = {}) => ({
        ok: true,
        counts: counts({ applied: status === "applied" ? 1 : 0, [status]: 1, ...over }),
        credits: [{ bankReference: "A", status }],
    });

    await t.test("a clean day is not a failure", () => {
        assert.equal(sweepBatchFailed(answer("applied")), false);
    });

    await t.test("credits sent to a HUMAN are not a failure — that is the sweep working", () => {
        assert.equal(sweepBatchFailed(answer("unmatched")), false);
    });

    await t.test("failed / qbo_unknown / reconcile are", () => {
        for (const bucket of ["failed", "qboUnknown", "reconcile"]) {
            const status = bucket === "qboUnknown" ? "qbo_unknown" : bucket;
            // Well-formed in every other respect: the bucket alone fails it.
            assert.equal(
                sweepBatchFailed({
                    ok: true,
                    counts: counts({ applied: 0, [bucket]: 1 }),
                    credits: [{ bankReference: "A", status }],
                }),
                true,
                `${bucket} must fail the run`,
            );
        }
    });

    await t.test("the endpoint's own ok:false is authority, whatever the counts say", () => {
        assert.equal(sweepBatchFailed({ ok: false, counts: counts() }), true);
    });

    await t.test("a MISSING ok is not a pass — 'I could not tell' is never success", () => {
        assert.equal(sweepBatchFailed({ counts: counts(), credits: [{ bankReference: "A", status: "applied" }] }), true);
        assert.equal(sweepBatchFailed({ ok: "true", counts: counts(), credits: [{ bankReference: "A", status: "applied" }] }), true);
    });

    await t.test("the response must account for every credit, one by one", () => {
        // An empty array with healthy counts would otherwise read as a clean
        // day for credits nobody can prove were ever seen.
        assert.equal(sweepBatchFailed({ ok: true, counts: counts(), credits: [] }), true);
        assert.equal(sweepBatchFailed({ ok: true, counts: counts() }), true, "no credits array at all");
        assert.equal(sweepBatchFailed({ ok: true, counts: counts({ credits: 2, applied: 2 }), credits: [{ bankReference: "A", status: "applied" }] }), true, "short array");
    });

    await t.test("…and they must be the SAME credits that were submitted", () => {
        const submitted = new Set(["A", "B"]);
        const body = (refs: string[]) => ({
            ok: true,
            counts: counts({ credits: refs.length, applied: refs.length }),
            credits: refs.map(r => ({ bankReference: r, status: "applied" })),
        });
        assert.equal(sweepBatchFailed(body(["A", "B"]), submitted), false);
        assert.equal(sweepBatchFailed(body(["A", "C"]), submitted), true, "a substituted reference");
        assert.equal(sweepBatchFailed(body(["A", "A"]), submitted), true, "a duplicated reference");
        assert.equal(sweepBatchFailed(body(["A"]), new Set(["A", "B"])), true, "another day's answer");
    });

    await t.test("counts alone still catch it if a deployment answers without the flag", () => {
        assert.equal(sweepBatchFailed({ counts: counts({ applied: 0, failed: 1 }) }), true);
    });

    await t.test("the catch-all bucket fails even a well-formed answer", () => {
        assert.equal(
            sweepBatchFailed({
                ok: true,
                counts: counts({ applied: 0, unresolved: 1 }),
                credits: [{ bankReference: "A", status: "qbo_created" }],
            }),
            true,
        );
    });

    await t.test("a missing or non-object body is a failure, never a silent pass", () => {
        assert.equal(sweepBatchFailed(null), true);
        assert.equal(sweepBatchFailed(undefined), true);
        assert.equal(sweepBatchFailed("nope"), true);
        assert.equal(sweepBatchFailed({ ok: true }), true, "no counts at all is not a clean day");
    });

    await t.test("the catch-all bucket fails the run", () => {
        assert.equal(sweepBatchFailed({ ok: true, counts: counts({ applied: 0, unresolved: 1 }) }), true);
    });

    await t.test("buckets that do not add up to the credit count are a failure", () => {
        // Some outcome went uncounted — an older deployment, or a status added
        // since. Reporting success off an incomplete tally is the exact bug.
        assert.equal(sweepBatchFailed({ ok: true, counts: counts({ credits: 3 }) }), true);
        assert.equal(sweepBatchFailed({ ok: true, counts: counts({ credits: 2, applied: 3 }) }), true);
    });

    await t.test("a per-credit status outside the clean set fails, whatever the counts claim", () => {
        // The round-2 residual, seen from the runner: an endpoint that tallies
        // qbo_created as nothing would still be caught here, on the RAW result.
        assert.equal(
            sweepBatchFailed({ ok: true, counts: counts(), credits: [{ bankReference: "A", status: "qbo_created" }] }),
            true,
        );
        assert.equal(
            sweepBatchFailed({ ok: true, counts: counts(), credits: [{ bankReference: "A", status: "something-new" }] }),
            true,
        );
        for (const status of ["applied", "proposed", "unmatched"]) {
            assert.equal(
                sweepBatchFailed({ ok: true, counts: counts(), credits: [{ bankReference: "A", status }] }),
                false,
                `${status} is a clean outcome`,
            );
        }
    });
});

test("sweep: a non-deposit credit is SENT, with the class fields the endpoint judges it by", () => {
    // The runner does not decide what is a customer payment — it reports what
    // the bank said and lets the endpoint's allowlist rule. Filtering here
    // would hide an interest or transfer credit from the audit trail entirely,
    // and would put the money rule in the browser-automation script instead of
    // the server that owns every other money rule.
    const { complete } = build([
        OPEN("08/24/2026", "0.00"),
        CLOSE("08/24/2026", "1503.17"),
        row("08/24/2026", "TOTAL CREDITS", "100", "1503.17"),
        CREDIT("08/24/2026", "1500.00", "REF-DEP"),
        CREDIT("08/24/2026", "3.17", "REF-INT", "INTEREST", "INTEREST PAID", "165"),
    ]);

    const payload = buildSweepPayload(complete[0]);
    assert.equal(payload.creditCount, 2, "both credits are posted");
    const interest = payload.credits.find((c: any) => c.bankReference === "REF-INT");
    assert.deepEqual(interest, {
        bankReference: "REF-INT",
        amount: 3.17,
        baiCode: "165",
        description: "INTEREST PAID",
        transactionDetail: "INTEREST",
        customerReference: null,
    });
});

test("sweep: every credit a human must look at gets its own line, with the money on it", async t => {
    await t.test("unmatched is printed even though the batch is clean", () => {
        // `unmatched` is a clean batch outcome, so it is not a failure — but it
        // IS the thing a human is being asked to act on, and a count in a
        // summary line is not a worklist.
        assert.equal(sweepCreditNeedsAttention({ status: "unmatched" }), true);
        assert.equal(sweepCreditNeedsAttention({ status: "reconcile" }), true);
        assert.equal(sweepCreditNeedsAttention({ status: "failed" }), true);
        assert.equal(sweepCreditNeedsAttention({ status: "qbo_created" }), true, "and anything unknown");
        assert.equal(sweepCreditNeedsAttention({ status: "applied" }), false);
        // Suggest-only mode has no confirm button yet (Phase C), so this log
        // line IS the operator's worklist.
        assert.equal(sweepCreditNeedsAttention({ status: "proposed" }), true);
    });

    await t.test("a proposed credit is named with its candidate milestone", () => {
        // The endpoint's own reason already carries the candidate, so the
        // operator gets reference, money, state and "would apply to …" on one
        // line without the runner having to know anything about milestones.
        assert.equal(
            sweepCreditLine({
                bankReference: "26236015002406",
                status: "proposed",
                reason: 'suggest-only: ... would apply to "Rough In complete" (Hoppe Hall Bath, INV-00173)',
            }, 13447.68),
            '26236015002406 $13447.68: proposed — suggest-only: ... would apply to "Rough In complete" (Hoppe Hall Bath, INV-00173)',
        );
    });

    await t.test("the line carries reference, amount and reason", () => {
        assert.equal(
            sweepCreditLine({ bankReference: "26236015002406", status: "unmatched", reason: "3 milestones match" }, 13447.68),
            "26236015002406 $13447.68: unmatched — 3 milestones match",
        );
        // A reference the batch cannot price is still named, not dropped.
        assert.equal(
            sweepCreditLine({ bankReference: "REF-X", status: "reconcile", reason: null }, undefined),
            "REF-X unknown amount: reconcile — ",
        );
    });
});

test("args: an unknown flag stops the run before anything is posted", async t => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; return new Response("{}"); }) as typeof fetch;
    try {
        await t.test("a typo'd flag is refused, not ignored", () => {
            // The dangerous direction: `--sweep-dryrun` silently dropped meant
            // the cron POSTed a LIVE batch believing it was shadowing.
            assert.throws(() => parseArgs(["daily.csv", "--sweep-dryrun"]), /unknown flag --sweep-dryrun/);
            assert.throws(() => parseArgs(["daily.csv", "--dryrun"]), /unknown flag --dryrun/);
            assert.throws(() => parseArgs(["daily.csv", "--sweep", "--nope"]), /unknown flag --nope/);
        });

        await t.test("a stray positional argument is refused too", () => {
            assert.throws(() => parseArgs(["daily.csv", "other.csv"]), /unexpected argument other\.csv/);
        });

        await t.test("the real flags still parse", () => {
            const args = parseArgs(["daily.csv", "--sweep-dry-run", "--post", "https://probuild.example", "--account", "WTB-0723"]);
            assert.equal(args.csvPath, "daily.csv");
            assert.equal(args.sweep, true);
            assert.equal(args.sweepDryRun, true);
            assert.equal(args.post, "https://probuild.example");
            assert.equal(parseArgs(["daily.csv", "--dry-run"]).dryRun, true);
            assert.equal(parseArgs(["daily.csv", "--sweep"]).sweepDryRun, false);
        });

        assert.equal(fetches, 0, "argument parsing never touches the network");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
