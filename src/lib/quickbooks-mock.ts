// Test-only QuickBooks mock — engages ONLY when E2E_QBO_MOCK=1, mirroring the
// existing triple-gate convention (see isE2eStorageMockEnabled() in
// supabase.ts): an explicit opt-in flag, off Vercel (a real deploy always
// sets VERCEL=1, so this combination can never hold there), AND the
// Playwright test-auth secret present. This is a money-path mock (fake
// QuickBooks Payment creates), so it uses the STRICTEST existing gate — the
// storage mock's three-condition bar — not the single-flag SELECTION_AI_MOCK
// gate.
//
// Call sites (each checks isE2eQboMockEnabled() first and, when true, returns
// a canned result with NO network I/O):
//   - quickbooks-payments.ts: getFreshQBTokens()
//   - quickbooks.ts: buildQBPaymentRequest() (skips the readQBInvoice() call
//     it would otherwise make), sendQBPaymentCreateRequest()
//
// Cross-process visibility: e2e/deposit-ingest.spec.ts drives the deposit-
// ingest endpoint over real HTTP against the Playwright webServer — a
// SEPARATE Node process from the test runner — so the spec can't just import
// this module and read its state directly (that would be a different module
// instance in a different process). src/app/api/payments/test-only/qbo-mock/
// route.ts, gated by the same isE2eQboMockEnabled() check, is the seam: it
// reads/seeds/resets this state FROM INSIDE the server process, and the spec
// drives it over HTTP like any other endpoint.
import type { QBTokens } from "./quickbooks";

export function isE2eQboMockEnabled(): boolean {
    return (
        process.env.E2E_QBO_MOCK === "1" &&
        !process.env.VERCEL &&
        !!process.env.PLAYWRIGHT_TEST_SECRET
    );
}

export const MOCK_QB_TOKENS: QBTokens = {
    accessToken: "e2e-mock-qb-access-token",
    refreshToken: "e2e-mock-qb-refresh-token",
    realmId: "e2e-mock-realm",
};

export interface MockQboInvoiceState {
    balance: number;
    customerId: string;
}

export interface CapturedReadInvoiceCall {
    qbInvoiceId: string;
    at: number;
}

export interface CapturedPaymentCreateCall {
    requestBody: string;
    requestId: string;
    at: number;
}

// globalThis-cached, same pattern as supabase-storage-mock.ts's object Map —
// Next.js can reload route modules between requests in dev; the underlying
// Node process (and this state) does not change.
const globalCache = globalThis as unknown as {
    __e2eQboMock?: {
        invoices: Map<string, MockQboInvoiceState>;
        readInvoiceCalls: CapturedReadInvoiceCall[];
        paymentCreateCalls: CapturedPaymentCreateCall[];
        paymentByRequestId: Map<string, { paymentId: string; amount: number }>;
        paymentIdSeq: number;
    };
};

function state() {
    globalCache.__e2eQboMock ??= {
        invoices: new Map(),
        readInvoiceCalls: [],
        paymentCreateCalls: [],
        paymentByRequestId: new Map(),
        paymentIdSeq: 0,
    };
    return globalCache.__e2eQboMock;
}

export function resetMockQbo(): void {
    const s = state();
    s.invoices.clear();
    s.readInvoiceCalls.length = 0;
    s.paymentCreateCalls.length = 0;
    s.paymentByRequestId.clear();
    s.paymentIdSeq = 0;
}

export function setMockQboInvoice(qbInvoiceId: string, invoiceState: MockQboInvoiceState): void {
    state().invoices.set(qbInvoiceId, invoiceState);
}

export function getMockQboInvoice(qbInvoiceId: string): MockQboInvoiceState | undefined {
    return state().invoices.get(qbInvoiceId);
}

export function recordMockReadInvoiceCall(qbInvoiceId: string): void {
    state().readInvoiceCalls.push({ qbInvoiceId, at: Date.now() });
}

/** Mirrors QBO's real `requestid` create-idempotency: the SAME requestId
 *  always returns the SAME payment instead of creating a duplicate — exactly
 *  the behavior the deposit-ingest endpoint's qbo_unknown replay path
 *  depends on (see sendQBPaymentCreateRequest's doc comment). */
export function mockSendQBPaymentCreate(requestBody: string, requestId: string): { paymentId: string; amount: number } {
    const s = state();
    s.paymentCreateCalls.push({ requestBody, requestId, at: Date.now() });
    const existing = s.paymentByRequestId.get(requestId);
    if (existing) return existing;
    s.paymentIdSeq += 1;
    const parsed = JSON.parse(requestBody) as { TotalAmt?: number };
    const result = { paymentId: `e2e-mock-qb-payment-${s.paymentIdSeq}`, amount: Number(parsed.TotalAmt ?? 0) };
    s.paymentByRequestId.set(requestId, result);
    return result;
}

export function getMockQboCallCounts(): { readInvoice: number; paymentCreate: number } {
    const s = state();
    return { readInvoice: s.readInvoiceCalls.length, paymentCreate: s.paymentCreateCalls.length };
}

export function getMockQboPaymentCreateCalls(): CapturedPaymentCreateCall[] {
    return [...state().paymentCreateCalls];
}
