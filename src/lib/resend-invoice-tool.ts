/**
 * Decision logic for the MCP `resend_invoice` tool, split out of
 * src/app/api/mcp/[transport]/route.ts so it's unit-testable without the
 * route's own module graph (mcp-handler, every other tool's imports, etc.)
 * and without moving the payroll-writer-manifest's pinned line number in
 * billing-core.ts.
 *
 * mintPreviewToken/verifyPreviewToken stay defined in route.ts (shared by
 * several other tools there) and are passed in as deps rather than imported.
 * resendInvoiceCore/loadInvoiceAmountDue default to the real billing-core
 * functions but can be overridden for tests.
 */

import { prisma } from "@/lib/prisma";
import {
    resendInvoiceCore as realResendInvoiceCore,
    loadInvoiceAmountDue as realLoadInvoiceAmountDue,
    dueSnapshot,
    resendConfirmPayload,
} from "./billing-core";

export interface ResendInvoiceToolDeps {
    mintPreviewToken: (payload: string) => string;
    verifyPreviewToken: (token: string | undefined, payload: string) => boolean;
    resendInvoiceCore?: typeof realResendInvoiceCore;
    loadInvoiceAmountDue?: typeof realLoadInvoiceAmountDue;
}

export type ResendInvoiceToolResult = Record<string, unknown> & { isError?: boolean };

export async function handleResendInvoiceTool(
    args: { invoiceId: string; overrideEmail?: string; confirmToken?: string },
    deps: ResendInvoiceToolDeps,
): Promise<ResendInvoiceToolResult> {
    const { invoiceId, overrideEmail, confirmToken } = args;
    const resendInvoiceCore = deps.resendInvoiceCore ?? realResendInvoiceCore;
    const loadInvoiceAmountDue = deps.loadInvoiceAmountDue ?? realLoadInvoiceAmountDue;

    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { client: true, payments: { select: { name: true, amount: true, status: true, qbSyncError: true } } },
    });
    if (!invoice) return { error: "Invoice not found", isError: true };
    const recipient = (overrideEmail || invoice.client?.email || "").trim();

    const loaded = await loadInvoiceAmountDue(invoiceId);
    if (!loaded) return { error: "Invoice not found", isError: true };
    const { due } = loaded;
    const milestonesPreview = invoice.payments.map(p => ({ name: p.name, amount: Number(p.amount), status: p.status, staleLink: !!p.qbSyncError }));

    if (due.dueCents <= 0) {
        // ALWAYS the nothing-due preview here, whatever confirmToken was
        // supplied — never fall through to resendInvoiceCore. A forged or
        // stale token must never reach the core: if a milestone got billed
        // in the race window between this read and the core's own fresh
        // read, the core would find something due and send it, with no
        // token ever actually verified.
        return {
            preview: true,
            willSend: false,
            reason: `Nothing on ${invoice.code} is billed and unpaid, so there is nothing to ask the client for. To ask for a payment, use the send_milestone_invoice tool.`,
            invoice: { code: invoice.code, status: invoice.status, total: Number(invoice.totalAmount), balanceDue: Number(invoice.balanceDue) },
            milestones: milestonesPreview,
        };
    }

    if (!recipient) {
        // No client email on file and no overrideEmail given — there is
        // nothing to mint a token FOR. Always this preview, whatever
        // confirmToken was supplied: never fall through to resendInvoiceCore,
        // which would otherwise resolve the send address from a FRESH
        // client.email read (e.g. one added between preview and confirm)
        // that nobody actually approved.
        return {
            preview: true,
            willSend: false,
            reason: "No client email on file. Call again with overrideEmail.",
            invoice: { code: invoice.code, status: invoice.status, total: Number(invoice.totalAmount), balanceDue: Number(invoice.balanceDue) },
            amountDue: due.dueCents / 100,
            dueNow: due.items.map(it => ({ name: it.label, amount: it.cents / 100 })),
            milestones: milestonesPreview,
        };
    }

    // The token binds the recipient AND the exact billed set (not just its
    // dollar total) — a milestone swapped for an equal-priced one between
    // preview and confirm must not ride the old approval.
    const payload = resendConfirmPayload({ invoiceId, recipient, due });
    if (!deps.verifyPreviewToken(confirmToken, payload)) {
        return {
            preview: true,
            invoice: {
                code: invoice.code, status: invoice.status, total: Number(invoice.totalAmount), balanceDue: Number(invoice.balanceDue),
                note: "balanceDue is the whole remaining contract. The email asks only for amountDue: milestones already billed and unpaid.",
            },
            amountDue: due.dueCents / 100,
            dueNow: due.items.map(it => ({ name: it.label, amount: it.cents / 100 })),
            milestones: milestonesPreview,
            recipient,
            confirmToken: deps.mintPreviewToken(payload),
            instruction: "Show this to the user. Call again with this confirmToken ONLY after they explicitly approve.",
        };
    }
    try {
        // recipient (not the raw overrideEmail) is what's bound into the
        // now-verified token, so the email goes to exactly the approved
        // address; expectedDue re-pins the approved billed set so the send
        // refuses if it drifted after this preview was shown. recipient is
        // guaranteed non-empty here (the empty-recipient branch above
        // already returned), so no `|| undefined` fallback is needed.
        const result = await resendInvoiceCore(invoiceId, recipient, undefined, { expectedDue: dueSnapshot(due) });
        return result;
    } catch (err: any) {
        return { error: err?.message || "Resend failed", isError: true };
    }
}
