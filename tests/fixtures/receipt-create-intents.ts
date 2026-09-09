import type { ReceiptCreateIntentStore } from "../../src/lib/receipt-create-intents";
export function memoryCreateIntents(): ReceiptCreateIntentStore {
    const rows = new Map<string, {realm:string; fileId:string; date:string; amountCents:number}>();
    const key = (realm:string,file:string) => JSON.stringify([realm,file]);
    return {
        list:async realm => [...rows.values()].filter(r=>r.realm===realm).map(({realm:_,...r})=>({...r})),
        put:async(realm,intent)=>{const k=key(realm,intent.fileId);if(rows.has(k))return false;rows.set(k,{realm,...intent});return true},
        remove:async(realm,file)=>{rows.delete(key(realm,file))},
    };
}
