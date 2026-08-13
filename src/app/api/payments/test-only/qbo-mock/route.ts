import { NextResponse } from "next/server";
import {
    isE2eQboMockEnabled,
    resetMockQbo,
    setMockQboInvoice,
    getMockQboCallCounts,
    getMockQboPaymentCreateCalls,
} from "@/lib/quickbooks-mock";

export const dynamic = "force-dynamic";

/**
 * Test-only seam for e2e/deposit-ingest.spec.ts's QuickBooks mock
 * (E2E_QBO_MOCK — see src/lib/quickbooks-mock.ts). The spec drives
 * /api/payments/deposit-ingest over real HTTP against the Playwright
 * webServer, a SEPARATE Node process from the test runner, so it can't
 * import quickbooks-mock.ts and read its module-level state directly (that
 * would be a different module instance). This route reads/seeds/resets that
 * state FROM INSIDE the server process instead.
 *
 * Gated by the exact same isE2eQboMockEnabled() triple-gate as the mock
 * itself (E2E_QBO_MOCK=1, off Vercel, PLAYWRIGHT_TEST_SECRET set) — that
 * combination can never hold on a real deploy (Vercel always sets VERCEL=1),
 * so this 404s everywhere except a Playwright e2e run. Reachable without a
 * staff session because it lives under /api/payments/, already in the proxy's
 * generic bypass (src/proxy.ts) — safe because the in-handler gate above is
 * the real lock, exactly like /api/payments/deposit-ingest's own Bearer check.
 */
function guard(): NextResponse | null {
    if (!isE2eQboMockEnabled()) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return null;
}

export async function GET() {
    const blocked = guard();
    if (blocked) return blocked;
    return NextResponse.json({
        ok: true,
        calls: getMockQboCallCounts(),
        paymentCreateCalls: getMockQboPaymentCreateCalls(),
    });
}

export async function POST(req: Request) {
    const blocked = guard();
    if (blocked) return blocked;

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
    }

    if (body?.action === "reset") {
        resetMockQbo();
        return NextResponse.json({ ok: true });
    }

    if (body?.action === "seedInvoice") {
        const { qbInvoiceId, balance, customerId } = body as { qbInvoiceId?: unknown; balance?: unknown; customerId?: unknown };
        if (typeof qbInvoiceId !== "string" || typeof balance !== "number" || typeof customerId !== "string") {
            return NextResponse.json({ ok: false, error: "qbInvoiceId (string), balance (number), customerId (string) required" }, { status: 400 });
        }
        setMockQboInvoice(qbInvoiceId, { balance, customerId });
        return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
