import assert from "node:assert/strict";
import test from "node:test";
import { buildDayStatements, REPOST_FLOOR, DAILY_CANONICAL_FROM } from "../scripts/parse-wtb-daily-csv.mjs";

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
) {
    return `${date},${ACCT},${desc},${bai},${amount},${status},,,${custRef},${detail},,`;
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
