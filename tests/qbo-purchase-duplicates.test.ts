import assert from "node:assert/strict";
import test from "node:test";
import { findPurchaseDuplicateCandidates, findRecentQboPurchaseDuplicates, type PurchaseQuery } from "../src/lib/qbo-purchase-duplicates";
const tokens = { accessToken: "test", refreshToken: "test", realmId: "test" };
const now = new Date("2026-09-09T12:00:00Z");
const row = (Id: string, TxnDate: string, TotalAmt: number, vendor: string, marker = true) =>
    ({ Id, TxnDate, TotalAmt, EntityRef: { name: vendor }, PrivateNote: marker ? `receipt [gtr-file:fixture-${Id}]` : "manual" });
export const cases = [
    { name: "Bigfoot vendor drift", input: { totalAmount: 575, date: "2026-09-03" }, purchase: row("6728", "2026-09-03", 575, "Bigfoot Concrete Pumping"), expected: ["6728"] },
    { name: "Bigfoot OCR year typo", input: { totalAmount: 575, date: "2024-09-08" }, purchase: row("6772", "2026-09-08", 575, "Bigfoot Construction"), expected: ["6772"] },
    { name: "Les Schwab 20-day gap is outside requested rule", input: { totalAmount: 1974.76, date: "2026-08-19" }, purchase: row("6555", "2026-07-30", 1974.76, "Les Schwab"), expected: [] },
    { name: "BIA vendor drift", input: { totalAmount: 585, date: "2026-08-19" }, purchase: row("6718", "2026-08-19", 585, "BIA of Clark County"), expected: ["6718"] },
];
function fake(rows: ReturnType<typeof row>[], queries: string[] = []): PurchaseQuery {
    return async <T,>(_tokens: typeof tokens, sql: string): Promise<T[]> => {
        queries.push(sql);
        assert.doesNotMatch(sql, /EntityRef|VendorRef|TotalAmt\s*=/i);
        const from = sql.match(/TxnDate >= '([^']+)'/)?.[1];
        const to = sql.match(/TxnDate <= '([^']+)'/)?.[1];
        assert.ok(from && to);
        const start = Number(sql.match(/STARTPOSITION (\d+)/)?.[1] ?? 1);
        const size = Number(sql.match(/MAXRESULTS (\d+)/)?.[1] ?? 1000);
        return rows.filter(r => r.TxnDate >= from && r.TxnDate <= to).slice(start - 1, start - 1 + size) as T[];
    };
}
for (const fixture of cases) test(fixture.name, async () => {
    const found = await findPurchaseDuplicateCandidates(tokens, fixture.input, fake([fixture.purchase]), now);
    assert.deepEqual(found.map(p => p.id), fixture.expected);
});
test("amount cents, inclusive 7 days, different vendor/manual purchase, three calendar years", async () => {
    const rows = [row("1", "2026-09-02", 575, "other", false), row("2", "2026-09-16", 575, "other"), row("3", "2026-09-17", 575, "other"), row("4", "2024-09-09", 575, "other"), row("5", "2023-09-09", 575, "other"), row("6", "2026-09-09", 575.01, "other")];
    const found = await findPurchaseDuplicateCandidates(tokens, { totalAmount: 575, date: "2026-09-09" }, fake(rows), now);
    assert.deepEqual(found.map(p => p.id).sort(), ["1", "2", "4"]);
});
test("query failure cannot mean no duplicates", async () => {
    await assert.rejects(findPurchaseDuplicateCandidates(tokens, { totalAmount: 575, date: "2026-09-09" }, async () => { throw new Error("outage"); }, now), /outage/);
});
test("guard reads subsequent pages", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(String(i + 100), "2026-09-08", 1, "other"));
    rows.push(row("6772", "2026-09-08", 575, "other"));
    assert.deepEqual((await findPurchaseDuplicateCandidates(tokens, {totalAmount:575, date:"2026-09-08"}, fake(rows), now)).map(p => p.id), ["6772"]);
});
test("health report includes recent/historical IDs, requires marker, deduplicates pairs", async () => {
    const rows = [row("6772", "2026-09-08", 575, "Bigfoot"), row("6761", "2024-09-08", 575, "other"), row("6718", "2026-08-19", 585, "BIA"), row("6717", "2026-08-19", 585, "BIA2"), row("9", "2026-09-08", 42, "a", false), row("10", "2026-09-09", 42, "b", false)];
    const pairs = await findRecentQboPurchaseDuplicates(tokens, fake(rows), now);
    assert.deepEqual(pairs.map(p => p.ids).sort(), [["6717","6718"],["6761","6772"]]);
});
test("health retains a partner just outside 45 days but not two old receipts", async () => {
    const rows = [row("1", "2026-07-20", 17, "A"), row("2", "2026-07-26", 17, "B"), row("3", "2026-07-19", 20, "A"), row("4", "2026-07-20", 20, "A")];
    assert.deepEqual((await findRecentQboPurchaseDuplicates(tokens, fake(rows), now)).map(p => p.ids), [["1","2"]]);
});
test("invalid dates fail closed and leap day never silently rolls into March", async () => {
    await assert.rejects(findPurchaseDuplicateCandidates(tokens, { totalAmount: 1, date: "2026-02-29" }, fake([]), now), /date/);
    const found = await findPurchaseDuplicateCandidates(tokens, {totalAmount: 1, date: "2024-02-29"}, fake([row("1", "2026-03-01", 1, "A")]), now);
    assert.deepEqual(found, []);
});
