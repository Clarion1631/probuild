/**
 * `tagExpensesToChangeOrderCore` (src/lib/time-expense-core.ts) — a real,
 * behavioral proof that tagging a receipt-booked Expense to a change order
 * succeeds (Codex xhigh post-merge review of #534, §7.5).
 *
 * tests/time-expense-core-guards.test.ts already has
 * "tagging an expense to a change order carries no receipt-booked guard",
 * but that test only greps the function's source text for the ABSENCE of a
 * receipt-booked guard. It proves the guard isn't there; it does not prove a
 * real receipt-booked row can actually be tagged end to end. This file is
 * that proof: it drives the real function against a fake `@/lib/prisma`, the
 * same require-patch technique tests/estimate-delete-receipt-guard.test.ts
 * uses, and asserts on the write that actually lands.
 *
 * WHY ITS OWN FILE, not added alongside the source-scan test above:
 * time-expense-core-guards.test.ts already has a static top-level
 * `import { ... } from "../src/lib/time-expense-core"` for the tag-conflict
 * tests. Node's ESM loader caches a module by specifier the first time it is
 * reached, so a *dynamic* `import()` of the same specifier later in that
 * same process returns the SAME cached instance — whatever `@/lib/prisma`
 * resolved to at that first, unpatched import. Tried inline there first: it
 * fails with a real "DATABASE_URL is not set" from the genuine Prisma
 * client, because the fake below never got a chance to take. A dedicated
 * file with no other import of time-expense-core.ts has no such conflict —
 * this file's dynamic import is the FIRST (and only) time that module loads
 * in this process, so the patched require is the one it sees.
 *
 * Prisma and the Next.js modules time-expense-core.ts's import chain touches
 * are patched at require() time — same shape as
 * tests/estimate-delete-receipt-guard.test.ts. No mock.module: CI is Node 20.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

test("tagging a receipt-booked expense to a change order actually succeeds", async () => {
    const opLog: string[] = [];
    const updateManyArgs: unknown[] = [];

    // Native receipt-booked shape (isReceiptBookedExpense,
    // receipt-intake/booked-expense-rules.ts): qbPurchaseId null. The tag
    // path itself never reads `receiptIntake` at all -- that IS what "no
    // receipt-booked guard" means -- so the row does not need one to prove
    // the point; only assertExpenseMutableOutsideQbo (the QBO guard that IS
    // still there) cares about qbPurchaseId, and this passes it.
    const RECEIPT_ROW = {
        id: "exp-receipt-1",
        qbPurchaseId: null,
        projectId: "job-1",
        estimateId: "est-1",
        estimate: { projectId: "job-1" },
        invoiceId: null,
        invoicedAt: null,
    };
    const CHANGE_ORDER = {
        id: "co-1",
        projectId: "job-1",
        estimateId: "est-1",
        pricingType: "COST_PLUS",
        status: "Approved",
        code: "CO-001",
    };
    const fakeTx: any = {
        // lockReceiptEvidence / bumpReceiptEvidenceEpoch (PR #443 gate
        // rounds 42/45) and lockAttributionParents (phase-invariant.ts) all
        // run unmocked against this fake -- nothing here depends on their
        // result, only that they are answerable.
        $executeRaw: async () => { opLog.push("lock"); return 1; },
        $queryRaw: async () => { opLog.push("epoch-bump"); return [{ value: "1" }]; },
        $queryRawUnsafe: async () => { opLog.push("advisory-lock"); return []; },
        expense: {
            updateMany: async (args: unknown) => {
                updateManyArgs.push(args);
                opLog.push("expense.updateMany");
                return { count: 1 };
            },
        },
    };
    const fakePrisma: any = {
        changeOrder: { findUnique: async () => CHANGE_ORDER },
        expense: { findMany: async () => [RECEIPT_ROW] },
        $transaction: async (fn: any) => fn(fakeTx),
    };

    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma" || id === "./prisma") return { prisma: fakePrisma };
        if (id === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: any) => fn };
        if (id === "next/server") return { after: (fn: any) => fn() };
        if (id === "next-auth") return { getServerSession: async () => null };
        if (id === "next-auth/next") return { getServerSession: async () => null };
        if (id === "next/headers") return { headers: () => new Map() };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let tagExpensesToChangeOrderCore: (
        input: { ids: string[]; changeOrderId: string },
        actor: string,
    ) => Promise<{ updated: number }>;
    try {
        const mod: any = await import("../src/lib/time-expense-core");
        tagExpensesToChangeOrderCore = mod.tagExpensesToChangeOrderCore;
    } finally {
        Module.prototype.require = originalRequire;
    }
    assert.equal(typeof tagExpensesToChangeOrderCore, "function", "mocks did not apply / import failed");

    const result = await tagExpensesToChangeOrderCore({ ids: ["exp-receipt-1"], changeOrderId: "co-1" }, "staff-1");

    assert.deepEqual(result, { updated: 1 }, "tagging a receipt-booked row succeeds exactly like a manual one");
    assert.deepEqual((updateManyArgs[0] as any).where, {
        id: "exp-receipt-1",
        qbPurchaseId: null,
        invoiceId: null,
        invoicedAt: null,
        projectId: "job-1",
    });
    assert.deepEqual((updateManyArgs[0] as any).data, { changeOrderId: "co-1", isBillable: true });
});
