import test from "node:test";
import assert from "node:assert/strict";
import {
    RECEIPT_OWNER_EPOCH_KEY,
    RECEIPT_EVIDENCE_EPOCH_ZERO,
    bumpReceiptOwnerEpoch,
    readReceiptOwnerEpoch,
    type EvidenceEpochClient,
} from "../src/lib/receipt-evidence-lock";

/**
 * cheap-sweep-restart-spec.md §14.1: the owner epoch is the same shape as the
 * receipt-evidence epoch, targeting a different `AutomationSetting` key. This
 * is a fake `$queryRaw` that records the SQL text and the interpolated
 * parameters of every call, so the assertions below read what was actually
 * sent rather than trusting the helper's own claim.
 */
function fakeEpochClient(rows: Array<{ value: string }>): EvidenceEpochClient & { calls: Array<{ sql: string; values: unknown[] }> } {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    return {
        calls,
        async $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> {
            calls.push({ sql: query.join("?"), values });
            return rows as unknown as T;
        },
    };
}

test("bumpReceiptOwnerEpoch targets receiptOwnerEpoch with the increment expression", async () => {
    const client = fakeEpochClient([{ value: "1" }]);
    await bumpReceiptOwnerEpoch(client);

    assert.equal(client.calls.length, 1);
    const { sql, values } = client.calls[0];
    assert.match(sql, /INSERT INTO "AutomationSetting"/);
    assert.match(sql, /ON CONFLICT \("key"\) DO UPDATE/);
    assert.match(sql, /::bigint \+ 1\)::text/);
    // The key is interpolated, not spelled inline in the SQL text.
    assert.equal(values[0], RECEIPT_OWNER_EPOCH_KEY);
    assert.equal(RECEIPT_OWNER_EPOCH_KEY, "receiptOwnerEpoch");
});

test("readReceiptOwnerEpoch with no row returns \"0\"", async () => {
    const client = fakeEpochClient([]);
    const value = await readReceiptOwnerEpoch(client);

    assert.equal(value, "0");
    assert.equal(value, RECEIPT_EVIDENCE_EPOCH_ZERO);
    assert.equal(client.calls.length, 1);
    const { sql, values } = client.calls[0];
    assert.match(sql, /SELECT "value" FROM "AutomationSetting" WHERE "key" = /);
    assert.equal(values[0], RECEIPT_OWNER_EPOCH_KEY);
});

test("readReceiptOwnerEpoch returns the stored value when a row exists", async () => {
    const client = fakeEpochClient([{ value: "7" }]);
    assert.equal(await readReceiptOwnerEpoch(client), "7");
});
