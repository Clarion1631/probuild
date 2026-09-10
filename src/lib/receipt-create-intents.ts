import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { QboRetryableError } from "./quickbooks";

export interface ReceiptCreateIntent {
    fileId: string;
    date: string;
    amountCents: number;
    /** Acknowledged by create, but not yet observed in a Purchase query. */
    qbPurchaseId?: string;
}
export interface ReceiptCreateIntentStore {
    list(realmId: string): Promise<ReceiptCreateIntent[]>;
    /** Insert only; false means an earlier attempt already owns this source. */
    put(realmId: string, intent: ReceiptCreateIntent): Promise<boolean>;
    acknowledge(realmId: string, intent: ReceiptCreateIntent, qbPurchaseId: string): Promise<void>;
    remove(realmId: string, fileId: string): Promise<void>;
}
const prefix = (realm: string) => `qbo-receipt-push.intent:${encodeURIComponent(realm)}:`;
const key = (realm: string, file: string) => prefix(realm) + createHash("sha256").update(file).digest("hex");

/** Durable intent, not an expiring lease: a lost response never proves no Purchase. */
export const receiptCreateIntentStore: ReceiptCreateIntentStore = {
    async list(realmId) {
        const rows = await prisma.automationSetting.findMany({where:{key:{startsWith:prefix(realmId)}},select:{value:true}});
        return rows.map(row => {
            let value: ReceiptCreateIntent;
            try { value = JSON.parse(row.value); } catch { throw new QboRetryableError("Unreadable receipt create intent"); }
            if (!value || typeof value.fileId !== "string" || !value.fileId ||
                typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
                !Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 ||
                (value.qbPurchaseId !== undefined && (typeof value.qbPurchaseId !== "string" || !value.qbPurchaseId.trim()))) {
                throw new QboRetryableError("Unreadable receipt create intent");
            }
            return value;
        });
    },
    async put(realmId, intent) {
        const data = {key:key(realmId,intent.fileId),value:JSON.stringify(intent)};
        try {
            await prisma.automationSetting.create({data});
            return true;
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && (error.code === "P2002" || error.code === "23505")) return false;
            throw error;
        }
    },
    async acknowledge(realmId, intent, qbPurchaseId) {
        if (!qbPurchaseId?.trim()) throw new QboRetryableError("Missing acknowledged receipt Purchase id");
        const result = await prisma.automationSetting.updateMany({
            where:{key:key(realmId,intent.fileId),value:JSON.stringify(intent)},
            data:{value:JSON.stringify({...intent,qbPurchaseId})},
        });
        // A failed compare-and-set must leave the earlier unknown intent intact.
        if (result.count !== 1) throw new QboRetryableError("Receipt create intent changed before acknowledgment");
    },
    async remove(realmId,fileId) {
        await prisma.automationSetting.deleteMany({where:{key:key(realmId,fileId)}});
    },
};
