import assert from "node:assert/strict";
import test from "node:test";
import { fetchBankRegister } from "../src/lib/qbo-bank-register";

const tokens = async () => ({ accessToken: "fixture", refreshToken: "fixture", realmId: "fixture" });
function report(memo: string, general: boolean) {
    const keys = general ? ["tx_date", "txn_type", "doc_num", "name", "memo", "subt_nat_amount"] : ["txn_type"];
    return { Columns: { Column: keys.map(Value => ({ MetaData: [{ Name: "ColKey", Value }] })) }, Rows: { Row: general ? [{ ColData: [{ value: "2020-01-01" }, { value: "Expense", id: "1" }, { value: "" }, { value: "Uber" }, { value: memo }, { value: "-21.95" }] }] : [] } };
}

test("explicit fresh register read bypasses the ordinary two-minute descriptor cache", async () => {
    const original = globalThis.fetch;
    let memo = "old memo";
    let calls = 0;
    globalThis.fetch = (async input => { calls++; return new Response(JSON.stringify(report(memo, String(input).includes("GeneralLedger"))), { status: 200 }); }) as typeof fetch;
    try {
        const old = await fetchBankRegister(tokens, "2020-01-01", "2020-01-02");
        assert.equal(old.rows[0].memo, "old memo");
        memo = "current memo";
        const cached = await fetchBankRegister(tokens, "2020-01-01", "2020-01-02");
        assert.equal(cached.rows[0].memo, "old memo");
        assert.equal(calls, 4);
        const fresh = await fetchBankRegister(tokens, "2020-01-01", "2020-01-02", { fresh: true });
        assert.equal(fresh.rows[0].memo, "current memo");
        assert.equal(calls, 8);
    } finally { globalThis.fetch = original; }
});


test("explicit fresh register read does not join an older in-flight report", async () => {
    const original = globalThis.fetch;
    let releaseOld!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(r => { releaseOld = r; });
    const firstStarted = new Promise<void>(r => { started = r; });
    let generalCalls = 0;
    globalThis.fetch = (async input => {
        const general = String(input).includes("GeneralLedger");
        if (general && ++generalCalls === 1) { started(); await gate; return new Response(JSON.stringify(report("old pending", true))); }
        return new Response(JSON.stringify(report("current independent", general)));
    }) as typeof fetch;
    const old = fetchBankRegister(tokens, "2020-02-01", "2020-02-02");
    let fresh: ReturnType<typeof fetchBankRegister> | undefined;
    try {
        await firstStarted;
        fresh = fetchBankRegister(tokens, "2020-02-01", "2020-02-02", { fresh: true });
        await new Promise<void>(r => setImmediate(r));
        assert.equal(generalCalls, 2);
        assert.equal((await fresh).rows[0].memo, "current independent");
    } finally { releaseOld(); await old; if (fresh) await fresh; globalThis.fetch = original; }
});
