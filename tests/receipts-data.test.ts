import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

// receipts-data.ts imports @/lib/prisma at module scope. Constructing a
// PrismaClient does not connect, and nothing below touches the database — only
// the pure helpers are exercised. Dynamic import (no top-level await: tsx
// transpiles this file as CJS).
const loadDataModule = () => import("../src/app/automation/receipts-data");

test("pacificDayStart is midnight in the CREW's timezone, not UTC's", async () => {
    const { pacificDayStart } = await loadDataModule();

    // PDT (UTC-7): 2026-08-20 09:00 UTC is 2026-08-20 02:00 Pacific.
    assert.equal(pacificDayStart(new Date("2026-08-20T09:00:00Z")).toISOString(), "2026-08-20T07:00:00.000Z");
    // Still the SAME Pacific day at 06:00 UTC (23:00 the previous evening
    // Pacific would be the day before — this one is 2026-08-20 late evening).
    assert.equal(pacificDayStart(new Date("2026-08-21T06:00:00Z")).toISOString(), "2026-08-20T07:00:00.000Z");
    // PST (UTC-8): the offset must follow the DATE, not be hardcoded.
    assert.equal(pacificDayStart(new Date("2026-01-15T18:00:00Z")).toISOString(), "2026-01-15T08:00:00.000Z");
});

test("parseMissingReceiptDetails never throws on a hostile or foreign blob", async () => {
    const { parseMissingReceiptDetails } = await loadDataModule();
    assert.deepEqual(parseMissingReceiptDetails(null), {});
    assert.deepEqual(parseMissingReceiptDetails(""), {});
    assert.deepEqual(parseMissingReceiptDetails("{not json"), {});
    assert.deepEqual(parseMissingReceiptDetails("[1,2,3]"), {}, "an array is not a details object");
    assert.deepEqual(parseMissingReceiptDetails('"a string"'), {});
    assert.deepEqual(parseMissingReceiptDetails('{"owner":"CJ"}'), { owner: "CJ" });
});

const issueRow = (over: Record<string, unknown> = {}) => ({
    id: "ri-1",
    targetKey: "bl-1",
    version: 3,
    reasonHash: "hash-1",
    reasonCodes: '["MISSING_RECEIPT"]',
    acknowledgedCodes: "[]",
    displayDetails: JSON.stringify({
        owner: "CJ",
        cardTail: "8516",
        postedDate: "2026-08-16",
        amountCents: -12_345,
        payee: "LOWES #02516",
        rawDescriptor: "LOWES #02516 POS DEB C#8516",
        fingerprint: "pb-bl-1",
    }),
    ...over,
});

test("toMissingReceiptRow carries the mark-reviewed contract verbatim", async () => {
    const { toMissingReceiptRow } = await loadDataModule();
    const row = toMissingReceiptRow(issueRow());
    // These three ARE the contract markReviewed conditionally updates by.
    assert.equal(row.id, "ri-1");
    assert.equal(row.version, 3);
    assert.equal(row.reasonHash, "hash-1");
    assert.equal(row.acknowledged, false);
    assert.equal(row.owner, "CJ");
    assert.equal(row.amountCents, -12_345);
    assert.equal(row.fingerprint, "pb-bl-1");
});

test("acknowledged mirrors decideLifecycle step 4 — every current code already acked", async () => {
    const { toMissingReceiptRow } = await loadDataModule();
    assert.equal(toMissingReceiptRow(issueRow({ acknowledgedCodes: '["MISSING_RECEIPT"]' })).acknowledged, true);
    assert.equal(toMissingReceiptRow(issueRow({ acknowledgedCodes: '["NO_RECEIPT"]' })).acknowledged, false,
        "acking a DIFFERENT code is not acking this one");
    assert.equal(toMissingReceiptRow(issueRow({ reasonCodes: "[]", acknowledgedCodes: "[]" })).acknowledged, false,
        "no codes is never 'acknowledged' — an empty set must not read as reviewed");
});

test("a corrupt details blob renders honest blanks, not a crash and not a guess", async () => {
    const { toMissingReceiptRow } = await loadDataModule();
    const row = toMissingReceiptRow(issueRow({ displayDetails: "{{{" }));
    assert.equal(row.owner, "unassigned");
    assert.equal(row.cardTail, null);
    assert.equal(row.postedDate, "");
    assert.equal(row.payee, "");
    assert.equal(row.amountCents, 0);
    assert.equal(row.fingerprint, "pb-bl-1", "the fingerprint is still derivable from the targetKey");
});

test("a wrong-typed amount is not coerced — a string never becomes a number", async () => {
    const { toMissingReceiptRow } = await loadDataModule();
    const row = toMissingReceiptRow(issueRow({ displayDetails: JSON.stringify({ amountCents: "-12345", owner: "CJ" }) }));
    assert.equal(row.amountCents, 0);
});

test("the Chat thread stamp is read from displayDetails.card", async () => {
    const { toMissingReceiptRow } = await loadDataModule();
    const withCard = toMissingReceiptRow(issueRow({
        displayDetails: JSON.stringify({
            owner: "CJ",
            card: { threadName: "spaces/AAQAKhvMYtg/threads/abc", messageName: "m/1", n: 2, date: "2026-08-20" },
            resolution: "memo-signed",
            pdfUrl: "https://drive.example/memo.pdf",
        }),
    }));
    assert.equal(withCard.threadName, "spaces/AAQAKhvMYtg/threads/abc");
    assert.equal(withCard.resolution, "memo-signed");
    assert.equal(withCard.pdfUrl, "https://drive.example/memo.pdf");
    assert.equal(toMissingReceiptRow(issueRow()).threadName, null);
});
