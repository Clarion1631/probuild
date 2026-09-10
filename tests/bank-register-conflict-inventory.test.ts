import { describe, it } from "node:test";
import assert from "node:assert/strict";
function partial(actual: unknown, expected: unknown): void {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        assert.ok(actual && typeof actual === "object");
        for (const [key, value] of Object.entries(expected)) partial((actual as Record<string, unknown>)[key], value);
    } else assert.deepStrictEqual(actual, expected);
}
function expect(actual: unknown) { return {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toMatchObject: (expected: unknown) => partial(actual, expected),
    toMatch: (expected: RegExp) => assert.match(String(actual), expected),
    not: { toMatch: (expected: RegExp) => assert.doesNotMatch(String(actual), expected) },
}; }
import type { BankRegisterRowLike } from "@/lib/bank-register-pull";
import {
    MAX_GL_ROWS,
    MAX_STORED_ROWS,
    buildConflictInventory,
    createConflictInventoryHandlers,
    createStoredInventoryReader,
    freshGlIds,
    type RegisterSnapshot,
    type StoredInventoryRow,
} from "@/lib/bank-register-conflict-inventory";

const WINDOW = { startDate: "2026-07-13", endDate: "2026-09-10" };

function gl(over: Partial<BankRegisterRowLike> = {}): BankRegisterRowLike {
    return { date: "2026-09-01", qbType: "Expense", qbTxnId: "100", docNum: null, name: "LOWES", memo: "LOWES #02516 POS DEB C#8516", amountCents: -12345, ...over };
}

function st(over: Partial<StoredInventoryRow> = {}): StoredInventoryRow {
    return { id: "obs-100", sourceLineId: "100", postedDate: new Date("2026-09-01T00:00:00Z"), rawDescriptor: "LOWES #02516 POS DEB C#8516", amountCents: -12345, checkNumber: null, bankLineId: null, ...over };
}

function reg(rows: BankRegisterRowLike[], over: Partial<RegisterSnapshot> = {}): RegisterSnapshot {
    return { rows, stale: false, clearedProbeOk: true, fetchedAt: "2026-09-10T02:00:00.000Z", ...WINDOW, ...over };
}

describe("buildConflictInventory (pure)", () => {
    it("counts unchanged rows without returning them and reports scope/window/fetchedAt", () => {
        const body = buildConflictInventory(reg([gl()]), [st()]);
        if (body.status !== "ok") throw new Error("Expected available inventory");
        expect(body.status).toBe("ok");
        expect(body.counts).toMatchObject({ glRows: 1, storedRows: 1, unchanged: 1, changed: 0 });
        expect(body.window).toEqual(WINDOW);
        expect(body.fetchedAt).toBe("2026-09-10T02:00:00.000Z");
        expect(body.scope.sourceDocumentId).toBe("QBO_REGISTER");
        expect(body.note).toMatch(/No repair performed/);
        expect(JSON.stringify(body)).not.toMatch(/"(?:eligible|safe)":\s*true/);
    });

    it("fails closed on stale, incomplete source and overflow with null counts", () => {
        expect(buildConflictInventory(reg([gl()], { stale: true }), [st()])).toMatchObject({ status: "unavailable", reason: "stale-register", counts: null });
        expect(buildConflictInventory(reg([gl()], { clearedProbeOk: false }), [st()])).toMatchObject({ status: "unavailable", reason: "incomplete-source", counts: null });
        const manyGl = Array.from({ length: MAX_GL_ROWS + 1 }, (_, i) => gl({ qbTxnId: String(i) }));
        expect(buildConflictInventory(reg(manyGl), [])).toMatchObject({ status: "unavailable", reason: "gl-overflow", counts: null });
        const manyStored = Array.from({ length: MAX_STORED_ROWS + 1 }, (_, i) => st({ id: `o${i}`, sourceLineId: String(i) }));
        expect(buildConflictInventory(reg([gl()]), manyStored)).toMatchObject({ status: "unavailable", reason: "stored-overflow", counts: null });
    });

    it("classifies missing identity, missing stored, duplicate GL ids, duplicate stored ids and unconvertible rows", () => {
        const rows = [
            gl({ qbTxnId: null }),
            gl({ qbTxnId: "200", amountCents: -500, memo: "NEW ROW" }),
            gl({ qbTxnId: "300" }), gl({ qbTxnId: "300", qbType: "Deposit" }),
            gl({ qbTxnId: "400" }),
            gl({ qbTxnId: "500", memo: "", name: "  " }),
        ];
        const stored = [st({ id: "a", sourceLineId: "400" }), st({ id: "b", sourceLineId: "400" })];
        const body = buildConflictInventory(reg(rows), stored);
        if (body.status !== "ok") throw new Error("Expected available inventory");
        expect(body.counts?.missingIdentity).toBe(1);
        expect(body.missingStored).toEqual([{ qbTxnId: "200", qbType: "Expense", supportedType: true, postedDate: "2026-09-01", amountCents: -500, rawDescriptor: "NEW ROW", checkNumber: null }]);
        expect(body.duplicateGlIds).toEqual([{ qbTxnId: "300", count: 2, qbTypes: ["Expense", "Deposit"] }]);
        expect(body.duplicateStoredIds).toEqual([{ qbTxnId: "400", storedIds: ["a", "b"] }]);
        expect(body.unconvertible).toEqual([{ qbTxnId: "500", qbType: "Expense", date: "2026-09-01", amountCents: -12345 }]);
    });

    it("surfaces exact field diffs, splitting linked from unlinked rows", () => {
        const rows = [gl({ qbTxnId: "1", memo: "HOME DEPOT", amountCents: -999 }), gl({ qbTxnId: "2", date: "2026-09-03" })];
        const stored = [st({ id: "o1", sourceLineId: "1" }), st({ id: "o2", sourceLineId: "2", bankLineId: "bl-2" })];
        const body = buildConflictInventory(reg(rows), stored);
        if (body.status !== "ok") throw new Error("Expected available inventory");
        expect(body.changed).toEqual([{
            qbTxnId: "1", qbType: "Expense", supportedType: true, storedId: "o1", bankLineId: null, linked: false,
            diffs: [{ field: "amountCents", stored: -12345, fresh: -999 }, { field: "rawDescriptor", stored: "LOWES #02516 POS DEB C#8516", fresh: "HOME DEPOT" }],
        }]);
        expect(body.changedLinked).toEqual([{
            qbTxnId: "2", qbType: "Expense", supportedType: true, storedId: "o2", bankLineId: "bl-2", linked: true,
            diffs: [{ field: "postedDate", stored: "2026-09-01", fresh: "2026-09-03" }],
        }]);
        expect(body.counts).toMatchObject({ changed: 1, changedLinked: 1, unchanged: 0 });
    });

    it("surfaces unsupported types even when unchanged, and check-number diffs", () => {
        const rows = [gl({ qbTxnId: "7", qbType: "Check", docNum: "0102" }), gl({ qbTxnId: "8", qbType: "Check", docNum: "0103" }), gl({ qbTxnId: "9", qbType: "Transfer" })];
        const stored = [st({ id: "o7", sourceLineId: "7", checkNumber: "102" }), st({ id: "o8", sourceLineId: "8", checkNumber: "102" }), st({ id: "o9", sourceLineId: "9" })];
        const body = buildConflictInventory(reg(rows), stored);
        if (body.status !== "ok") throw new Error("Expected available inventory");
        expect(body.unsupportedUnchanged.map(e => e.qbTxnId)).toEqual(["7", "9"]);
        expect(body.changed).toEqual([{ qbTxnId: "8", qbType: "Check", supportedType: false, storedId: "o8", bankLineId: null, linked: false, diffs: [{ field: "checkNumber", stored: "102", fresh: "103" }] }]);
        expect(body.counts).toMatchObject({ unchanged: 2, unsupportedUnchanged: 2, changed: 1 });
    });

    it("reports stored-only rows inside the window as source-missing, ignores unmatched rows outside it", () => {
        const stored = [st({ id: "in", sourceLineId: "55", bankLineId: "bl" }), st({ id: "out", sourceLineId: "56", postedDate: "2026-01-01" })];
        const body = buildConflictInventory(reg([]), stored);
        if (body.status !== "ok") throw new Error("Expected available inventory");
        expect(body.sourceMissing).toEqual([{ storedId: "in", sourceLineId: "55", postedDate: "2026-09-01", amountCents: -12345, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null, bankLineId: "bl", linked: true }]);
        expect(body.counts?.sourceMissing).toBe(1);
    });
});

describe("stored reader scope", () => {
    it("queries the fixed source/account/document with window OR fresh ids and cap + 1", async () => {
        let captured: unknown;
        const client = { bankLineObservation: { findMany: async (input: unknown) => { captured = input; return []; } } };
        await createStoredInventoryReader(client)(WINDOW, ["1", "2"]);
        expect(captured).toMatchObject({
            where: { source: "QBO_REGISTER", account: "WTB-0723", sourceDocumentId: "QBO_REGISTER", OR: [{ postedDate: { gte: new Date("2026-07-13T00:00:00Z"), lte: new Date("2026-09-10T00:00:00Z") } }, { sourceLineId: { in: ["1", "2"] } }] },
            take: MAX_STORED_ROWS + 1,
        });
        expect(freshGlIds([gl({ qbTxnId: "1" }), gl({ qbTxnId: "1" }), gl({ qbTxnId: null })])).toEqual(["1"]);
    });
});

describe("GET handler (injected)", () => {
    function harness(register: RegisterSnapshot, stored: StoredInventoryRow[] = [], authorized = true) {
        const calls = { register: 0, stored: 0, ids: [] as string[] };
        const { GET } = createConflictInventoryHandlers({
            authorize: () => authorized,
            window: () => WINDOW,
            readRegister: async () => { calls.register++; return register; },
            readStored: async (_w, ids) => { calls.stored++; calls.ids = ids; return stored; },
        });
        return { GET, calls };
    }

    it("rejects unauthorized requests before any IO, with no-store", async () => {
        const { GET, calls } = harness(reg([gl()]), [], false);
        const res = await GET(new Request("http://x/api/integrations/bank-ledger/conflict-inventory"));
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(calls).toMatchObject({ register: 0, stored: 0 });
    });

    it("rejects any query parameter before IO", async () => {
        const { GET, calls } = harness(reg([gl()]));
        const res = await GET(new Request("http://x/api/integrations/bank-ledger/conflict-inventory?qbTxnId=1"));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ ok: false, reason: "invalid-query" });
        expect(calls).toMatchObject({ register: 0, stored: 0 });
    });

    it("skips the stored read on a stale or overflowing fetch and answers unavailable", async () => {
        const stale = harness(reg([gl()], { stale: true }));
        const res = await stale.GET(new Request("http://x/i"));
        expect(await res.json()).toMatchObject({ status: "unavailable", reason: "stale-register", counts: null });
        expect(stale.calls.stored).toBe(0);
        const big = harness(reg(Array.from({ length: MAX_GL_ROWS + 1 }, (_, i) => gl({ qbTxnId: String(i) }))));
        expect(await (await big.GET(new Request("http://x/i"))).json()).toMatchObject({ status: "unavailable", reason: "gl-overflow" });
        expect(big.calls.stored).toBe(0);
    });

    it("passes fresh ids to the stored read and returns the inventory with no-store", async () => {
        const { GET, calls } = harness(reg([gl({ qbTxnId: "1" }), gl({ qbTxnId: "2", amountCents: -1 })]), [st({ id: "o1", sourceLineId: "1" }), st({ id: "o2", sourceLineId: "2" })]);
        const res = await GET(new Request("http://x/i"));
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(calls.ids).toEqual(["1", "2"]);
        const body = await res.json();
        expect(body.status).toBe("ok");
        expect(body.counts).toMatchObject({ unchanged: 1, changed: 1 });
    });

    it("collapses upstream failures to a sanitized 503", async () => {
        const { GET } = createConflictInventoryHandlers({
            authorize: () => true, window: () => WINDOW,
            readRegister: async () => { throw new Error("secret detail"); },
            readStored: async () => [],
        });
        const res = await GET(new Request("http://x/i"));
        expect(res.status).toBe(503);
        expect(await res.text()).not.toMatch(/secret detail/);
        expect(res.headers.get("cache-control")).toBe("no-store");
    });
});
