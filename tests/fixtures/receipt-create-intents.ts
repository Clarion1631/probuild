import type { ReceiptCreateIntent, ReceiptCreateIntentStore } from "../../src/lib/receipt-create-intents";
export function memoryCreateIntents(): ReceiptCreateIntentStore {
    const rows = new Map<string, ReceiptCreateIntent & {realm:string}>();
    const key = (realm:string,file:string) => JSON.stringify([realm,file]);
    return {
        list:async realm => [...rows.values()].filter(r=>r.realm===realm).map(({realm:_,...r})=>({...r})),
        put:async(realm,intent)=>{const k=key(realm,intent.fileId);if(rows.has(k))return false;rows.set(k,{realm,...intent});return true},
        acknowledge:async(realm,intent,qbPurchaseId)=>{
            const k=key(realm,intent.fileId), row=rows.get(k);
            if(!row)throw new Error("intent missing");
            const {realm:_,...current}=row;
            if(JSON.stringify(current)!==JSON.stringify(intent))throw new Error("intent changed");
            rows.set(k,{realm,...intent,qbPurchaseId});
        },
        remove:async(realm,file)=>{rows.delete(key(realm,file))},
    };
}
