import test from "node:test";
import assert from "node:assert/strict";
import { bankLedgerReconcileHandlers } from "../src/app/api/integrations/bank-ledger/reconcile/route";

// Exercise the production adapter with transaction-local state; never connect to a database.
for (const kind of ["success", "stale", "failure"] as const) {
    test(`reconcile chunk epoch: ${kind}`, async () => {
        const globalDb = globalThis as any;
        const original = globalDb.prisma;
        const db: any = { bankLineObservation: {}, bankLine: {} };
        globalDb.prisma = db;
        const events: string[] = [];
        let epoch = 0, linked = false;
        const common = { account: "WTB-0723", postedDate: new Date("2026-08-11T00:00:00Z"), amountCents: -100, checkNumber: null };
        db.bankLineObservation.findMany = async () => [{ ...common, id: "obs", rawDescriptor: "QXO", bankLineId: null, sourceLineId: "123" }];
        db.bankLine.findMany = async () => [{ ...common, id: "line", normalizedPayee: "QXO" }];
        db.$transaction = async (body: (tx: any) => Promise<void>) => {
            const oldEpoch = epoch, oldLinked = linked;
            const tx = {
                $executeRaw: async () => { events.push("identity"); },
                $executeRawUnsafe: async (sql: string) => { events.push(sql.split(" ")[0]); },
                $queryRaw: async (strings: TemplateStringsArray) => {
                    const sql = strings.join("?");
                    if (sql.includes('INSERT INTO "AutomationSetting"')) { events.push("epoch"); epoch++; return [{ value: String(epoch) }]; }
                    if (sql.includes('FROM "BankLineObservation" WHERE "id"')) {
                        events.push("observation-lock");
                        return [{ ...common, postedDate: "2026-08-11", id: "obs", source: "QBO_REGISTER", bankLineId: null, rawDescriptor: kind === "stale" ? "Other" : "QXO" }];
                    }
                    if (sql.includes('FROM "BankLine" WHERE "id"')) { events.push("line-lock"); return [{ ...common, postedDate: "2026-08-11", id: "line", normalizedPayee: "QXO" }]; }
                    if (sql.includes('WHERE "bankLineId"')) return [];
                    throw new Error("unexpected SQL");
                },
                bankLineObservation: { updateMany: async () => { events.push("mutation"); linked = true; if (kind === "failure") throw new Error("simulated failure"); return { count: 1 }; } },
            };
            try { const result = await body(tx); events.push("commit"); return result; }
            catch (error) { epoch = oldEpoch; linked = oldLinked; events.push("rollback"); throw error; }
        };
        try {
            const result = await bankLedgerReconcileHandlers.runReconcile("WTB-0723", undefined, { since: "2026-08-01", window: null });
            assert.ok(events.indexOf("identity") < events.indexOf("epoch"));
            assert.ok(events.indexOf("epoch") < events.indexOf("observation-lock"));
            if (kind === "success") { assert.equal(epoch, 1); assert.equal(linked, true); assert.equal(result.linked, 1); }
            if (kind === "stale") { assert.equal(epoch, 1, "conservative invalidation on refused chunk"); assert.equal(linked, false); assert.equal(result.exceptions[0].reason, "stale-reconcile-plan"); }
            if (kind === "failure") { assert.equal(epoch, 0); assert.equal(linked, false); assert.equal(result.linked, 0); assert.equal(result.chunkErrors.length, 1); }
        } finally {
            globalDb.prisma = original;
        }
    });
}
