/**
 * handleResendInvoiceTool (src/lib/resend-invoice-tool.ts) — the decision
 * logic behind the MCP resend_invoice tool, extracted from
 * src/app/api/mcp/[transport]/route.ts so it's testable without the route's
 * own module graph. Covers the two round-3 fixes: an empty recipient must
 * never reach resendInvoiceCore (same reasoning as the nothing-due case),
 * and the confirm token must actually gate every send.
 *
 * mintPreviewToken/verifyPreviewToken stay in route.ts (shared by several
 * other tools there) and are injected here as simple deterministic fakes —
 * the handler doesn't care about their cryptographic details, only that
 * mint/verify agree with each other for the same payload and disagree
 * otherwise. resendInvoiceCore/loadInvoiceAmountDue are injected fakes too,
 * so these tests exercise ONLY the routing/decision logic, never the real
 * DB-backed amount computation.
 *
 * Loads the REAL src/lib/resend-invoice-tool.ts (and, transitively,
 * src/lib/billing-core.ts for dueSnapshot/resendConfirmPayload) under the
 * same scoped require() patch as tests/invoice-send-amount-due.test.ts
 * (mock.module() is unusable here — CI pins Node 20), with only Prisma, the
 * email sender, and next/cache faked.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Row = Record<string, any>;

// ── Fake mint/verify: deterministic, no crypto/env needed. mint(payload) is
//    recognized by verify ONLY for that exact payload. ──────────────────────

function fakeMintPreviewToken(payload: string): string {
    return `token:${payload}`;
}
function fakeVerifyPreviewToken(token: string | undefined, payload: string): boolean {
    return token === fakeMintPreviewToken(payload);
}

// ── Fake Prisma (resend-invoice-tool.ts's own prisma.invoice.findUnique) ────

let invoiceRows: Record<string, Row> = {};
const fakePrisma = {
    invoice: {
        findUnique: async (args: Row) => invoiceRows[args.where.id] ?? null,
    },
};
async function fakeSendNotification() {
    return { success: true, id: "fake-email-id" };
}

beforeEach(() => {
    invoiceRows = {};
});

// ── Load resend-invoice-tool.ts (+ billing-core.ts for dueSnapshot/
//    resendConfirmPayload) under the patch ──────────────────────────────────

let handleResendInvoiceTool: (args: Row, deps: Row) => Promise<Row>;
let dueSnapshot: (due: Row) => Row;
let resendConfirmPayload: (args: Row) => string;

before(async () => {
    const originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") { patched.add(id); return { prisma: fakePrisma }; }
        if (id === "./email") { patched.add(id); return { sendNotification: fakeSendNotification }; }
        if (id === "next/cache") { patched.add(id); return { revalidatePath: () => {} }; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let toolMod: Row, billingCoreMod: Row;
    try {
        toolMod = await import("../src/lib/resend-invoice-tool");
        billingCoreMod = await import("../src/lib/billing-core");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["@/lib/prisma", "./email", "next/cache"]) {
        if (!patched.has(id)) throw new Error(`resend-invoice-tool.test.ts: the mock of "${id}" never applied — a real module would have been hit`);
    }
    handleResendInvoiceTool = toolMod.handleResendInvoiceTool;
    dueSnapshot = billingCoreMod.dueSnapshot;
    resendConfirmPayload = billingCoreMod.resendConfirmPayload;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeDue(items: Array<{ kind: "milestone" | "legacyInvoice"; id: string | null; label: string; cents: number }>): Row {
    return { dueCents: items.reduce((s, it) => s + it.cents, 0), items };
}

function makeInvoiceRow(overrides: Partial<Row> & { code: string }): Row {
    return {
        status: "Issued", totalAmount: "500.00", balanceDue: "500.00",
        client: { email: "client@example.test" },
        payments: [],
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("nothing due, even with a forged confirmToken, always returns the nothing-due preview and never calls the core", async () => {
    invoiceRows["inv-1"] = makeInvoiceRow({ code: "INV-1" });
    const resendCalls: Row[] = [];
    const deps = {
        mintPreviewToken: fakeMintPreviewToken,
        verifyPreviewToken: fakeVerifyPreviewToken,
        resendInvoiceCore: async (...args: Row[]) => { resendCalls.push(args); return { success: true }; },
        loadInvoiceAmountDue: async () => ({ invoice: invoiceRows["inv-1"], due: fakeDue([]) }),
    };

    const result = await handleResendInvoiceTool({ invoiceId: "inv-1", confirmToken: "forged-garbage-token" }, deps);

    assert.equal(result.preview, true);
    assert.equal(result.willSend, false);
    assert.match(result.reason, /Nothing on INV-1 is billed and unpaid/);
    assert.equal(result.confirmToken, undefined);
    assert.equal(resendCalls.length, 0);
});

test("nothing due + a token that WOULD verify for that state still returns the nothing-due preview, never calls the core", async () => {
    invoiceRows["inv-1"] = makeInvoiceRow({ code: "INV-1" });
    const dueEmpty = fakeDue([]);
    const resendCalls: Row[] = [];
    const deps = {
        mintPreviewToken: fakeMintPreviewToken,
        verifyPreviewToken: fakeVerifyPreviewToken,
        resendInvoiceCore: async (...args: Row[]) => { resendCalls.push(args); return { success: true }; },
        loadInvoiceAmountDue: async () => ({ invoice: invoiceRows["inv-1"], due: dueEmpty }),
    };
    // Proves the dueCents<=0 check runs BEFORE verify is ever consulted, not
    // merely that a random token fails: this token would actually verify.
    const wouldBeValidToken = fakeMintPreviewToken(resendConfirmPayload({ invoiceId: "inv-1", recipient: "client@example.test", due: dueEmpty }));

    const result = await handleResendInvoiceTool({ invoiceId: "inv-1", confirmToken: wouldBeValidToken }, deps);

    assert.equal(result.preview, true);
    assert.equal(result.willSend, false);
    assert.equal(resendCalls.length, 0);
});

test("empty recipient (no client email, no override) always returns the no-recipient preview, with or without a token", async () => {
    invoiceRows["inv-2"] = makeInvoiceRow({ code: "INV-2", client: { email: null } });
    const dueSome = fakeDue([{ kind: "milestone", id: "m1", label: "Deposit", cents: 50_000 }]);
    const resendCalls: Row[] = [];
    const deps = {
        mintPreviewToken: fakeMintPreviewToken,
        verifyPreviewToken: fakeVerifyPreviewToken,
        resendInvoiceCore: async (...args: Row[]) => { resendCalls.push(args); return { success: true }; },
        loadInvoiceAmountDue: async () => ({ invoice: invoiceRows["inv-2"], due: dueSome }),
    };

    for (const confirmToken of [undefined, "some-random-token", fakeMintPreviewToken(resendConfirmPayload({ invoiceId: "inv-2", recipient: "", due: dueSome }))]) {
        const result = await handleResendInvoiceTool({ invoiceId: "inv-2", confirmToken }, deps);
        assert.equal(result.preview, true);
        assert.equal(result.willSend, false);
        assert.match(result.reason, /No client email on file/);
        assert.equal(result.confirmToken, undefined);
    }
    assert.equal(resendCalls.length, 0);
});

test("a token verified against the current payload calls the core once with the exact recipient and expectedDue", async () => {
    invoiceRows["inv-3"] = makeInvoiceRow({ code: "INV-3" });
    const due = fakeDue([{ kind: "milestone", id: "m1", label: "Deposit", cents: 50_000 }]);
    const resendCalls: Row[] = [];
    const deps = {
        mintPreviewToken: fakeMintPreviewToken,
        verifyPreviewToken: fakeVerifyPreviewToken,
        resendInvoiceCore: async (...args: Row[]) => { resendCalls.push(args); return { success: true, sentTo: "client@example.test" }; },
        loadInvoiceAmountDue: async () => ({ invoice: invoiceRows["inv-3"], due }),
    };

    const preview = await handleResendInvoiceTool({ invoiceId: "inv-3" }, deps);
    assert.equal(preview.preview, true);
    const token = preview.confirmToken as string;
    assert.ok(token);

    const result = await handleResendInvoiceTool({ invoiceId: "inv-3", confirmToken: token }, deps);

    assert.equal(resendCalls.length, 1);
    assert.deepEqual(resendCalls[0], ["inv-3", "client@example.test", undefined, { expectedDue: dueSnapshot(due) }]);
    assert.equal(result.success, true);
});

test("a token minted for one recipient is rejected when confirmed with a different overrideEmail", async () => {
    invoiceRows["inv-4"] = makeInvoiceRow({ code: "INV-4", client: { email: "a@example.test" } });
    const due = fakeDue([{ kind: "milestone", id: "m1", label: "Deposit", cents: 50_000 }]);
    const resendCalls: Row[] = [];
    const deps = {
        mintPreviewToken: fakeMintPreviewToken,
        verifyPreviewToken: fakeVerifyPreviewToken,
        resendInvoiceCore: async (...args: Row[]) => { resendCalls.push(args); return { success: true }; },
        loadInvoiceAmountDue: async () => ({ invoice: invoiceRows["inv-4"], due }),
    };

    const preview = await handleResendInvoiceTool({ invoiceId: "inv-4" }, deps); // recipient resolves to a@example.test
    const token = preview.confirmToken as string;

    const result = await handleResendInvoiceTool({ invoiceId: "inv-4", overrideEmail: "b@example.test", confirmToken: token }, deps);

    assert.equal(result.preview, true);
    assert.ok(result.confirmToken, "a fresh token should be minted for the new recipient, proving this is the mismatch preview, not a send");
    assert.equal(resendCalls.length, 0);
});

test("a token minted before the billed set changed (same total, different milestone id) is rejected", async () => {
    invoiceRows["inv-5"] = makeInvoiceRow({ code: "INV-5" });
    const dueA = fakeDue([{ kind: "milestone", id: "ms-A", label: "A", cents: 50_000 }]);
    const dueB = fakeDue([{ kind: "milestone", id: "ms-B", label: "B", cents: 50_000 }]); // same total, different id
    let currentDue = dueA;
    const resendCalls: Row[] = [];
    const deps = {
        mintPreviewToken: fakeMintPreviewToken,
        verifyPreviewToken: fakeVerifyPreviewToken,
        resendInvoiceCore: async (...args: Row[]) => { resendCalls.push(args); return { success: true }; },
        loadInvoiceAmountDue: async () => ({ invoice: invoiceRows["inv-5"], due: currentDue }),
    };

    const preview = await handleResendInvoiceTool({ invoiceId: "inv-5" }, deps);
    const token = preview.confirmToken as string;

    currentDue = dueB; // the billed set changed between preview and confirm
    const result = await handleResendInvoiceTool({ invoiceId: "inv-5", confirmToken: token }, deps);

    assert.equal(result.preview, true);
    assert.ok(result.confirmToken, "a fresh token should be minted for the new billed set");
    assert.equal(resendCalls.length, 0);
});
