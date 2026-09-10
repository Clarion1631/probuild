import test from "node:test";
import assert from "node:assert/strict";
import { bankLedgerIngestHandlers } from "../src/app/api/integrations/bank-ledger/ingest/route";

// Exercise the production adapter with an isolated transaction fake, never a database.
for (const mode of ["insert", "identical-race", "conflict", "failure"] as const) {
    test(`QBO observation creation fences lineage: ${mode}`, async () => {
        const globals = globalThis as any;
        const original = globals.prisma;
        const events: string[] = [];
        let epoch = 0;
        let inserted = 0;
        const row = { qbTxnId: "555", postedDate: "2026-08-12", amountCents: -133029, rawDescriptor: "QXO", checkNumber: null, clearedStatus: "Cleared" };
        globals.prisma = {
            bankLineObservation: { findMany: async () => [] },
            $transaction: async (body: (tx: any) => Promise<unknown>) => {
                const before = { epoch, inserted };
                const tx = {
                    $executeRaw: async (sql: TemplateStringsArray) => {
                        assert.match(sql.join("?"), /pg_advisory_xact_lock/);
                        events.push("identity");
                    },
                    $queryRaw: async (sql: TemplateStringsArray) => {
                        assert.match(sql.join("?"), /INSERT INTO "AutomationSetting"/);
                        events.push("epoch");
                        return [{ value: String(++epoch) }];
                    },
                    bankLineObservation: {
                        createMany: async () => {
                            events.push("insert");
                            if (mode === "failure") throw new Error("simulated insert failure");
                            inserted = mode === "insert" ? 1 : 0;
                            return { count: inserted };
                        },
                        findMany: async () => [{ ...row, sourceLineId: row.qbTxnId, postedDate: new Date(row.postedDate), rawDescriptor: mode === "conflict" ? "Other receipt" : row.rawDescriptor }],
                    },
                };
                try { const result = await body(tx); events.push("commit"); return result; }
                catch (error) { epoch = before.epoch; inserted = before.inserted; events.push("rollback"); throw error; }
            },
        };
        try {
            if (mode === "failure") {
                await assert.rejects(bankLedgerIngestHandlers.handleQboRegister("WTB-0723", [row]), /simulated insert failure/);
            } else {
                const response = await bankLedgerIngestHandlers.handleQboRegister("WTB-0723", [row]);
                assert.equal(response.status, mode === "conflict" ? 409 : 200);
            }
            assert.deepEqual(events.slice(0, 3), ["identity", "epoch", "insert"]);
            assert.equal(epoch, mode === "conflict" || mode === "failure" ? 0 : 1);
            assert.equal(inserted, mode === "insert" ? 1 : 0);
            assert.equal(events.at(-1), mode === "conflict" || mode === "failure" ? "rollback" : "commit");
        } finally {
            globals.prisma = original;
        }
    });
}
