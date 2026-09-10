import test from "node:test";
import assert from "node:assert/strict";
import { receiptCreateIntentStore as store } from "../src/lib/receipt-create-intents";

test("durable acknowledgment is realm/source scoped, compare-and-set, and preserves unknown outcomes", async () => {
    const previous = (globalThis as any).prisma;
    const rows = new Map<string, string>();
    (globalThis as any).prisma = {automationSetting:{
        create:async({data}:any)=>{if(rows.has(data.key))throw {code:"P2002"};rows.set(data.key,data.value)},
        findMany:async({where}:any)=>[...rows].filter(([key])=>key.startsWith(where.key.startsWith)).map(([,value])=>({value})),
        updateMany:async({where,data}:any)=>{
            if(rows.get(where.key)!==where.value)return {count:0};
            rows.set(where.key,data.value);return {count:1};
        },
        deleteMany:async({where}:any)=>({count:rows.delete(where.key)?1:0}),
    }};
    try {
        const intent={fileId:"same-drive-id",date:"2026-09-08",amountCents:57500};
        await store.put("gtr",intent);await store.put("other-realm",intent);
        assert.equal(await store.put("gtr",{...intent,date:"2024-09-08"}),false);
        await assert.rejects(store.acknowledge("gtr",{...intent,date:"2024-09-08"},"9000"),/changed/);
        await assert.rejects(store.acknowledge("gtr",intent,""),/Missing/);
        assert.deepEqual(await store.list("gtr"),[intent]);
        await store.acknowledge("gtr",intent,"9000");
        assert.deepEqual(await store.list("gtr"),[{...intent,qbPurchaseId:"9000"}]);
        assert.deepEqual(await store.list("other-realm"),[intent]);
        await assert.rejects(store.acknowledge("gtr",intent,"9001"),/changed/);
        assert.equal((await store.list("gtr"))[0].qbPurchaseId,"9000");
        await store.remove("gtr",intent.fileId);
        assert.deepEqual(await store.list("other-realm"),[intent]);
    } finally {(globalThis as any).prisma=previous}
});

test("an unreadable acknowledged id fails closed while old unknown intents remain readable", async () => {
    const previous=(globalThis as any).prisma;
    const intent={fileId:"capture-A",date:"2026-09-08",amountCents:57500};
    let value=JSON.stringify(intent);
    (globalThis as any).prisma={automationSetting:{findMany:async()=>[{value}]}};
    try {
        assert.deepEqual(await store.list("gtr"),[intent]);
        for(const qbPurchaseId of [null,"", "  ",9000,{},[]]) {
            value=JSON.stringify({...intent,qbPurchaseId});
            await assert.rejects(store.list("gtr"),/Unreadable/);
        }
    } finally {(globalThis as any).prisma=previous}
});
