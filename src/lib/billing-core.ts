import { revalidatePath as nextRevalidatePath } from "next/cache";
import { createHash, randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";

// Cache revalidation is best-effort: it throws outside a Next request context
// (e.g. verification scripts), and a stale cache page is never worth failing a
// billing operation that already sent/persisted.
function revalidatePath(path: string) {
    try {
        nextRevalidatePath(path);
    } catch {
        /* not in a request context */
    }
}
import { prisma } from "@/lib/prisma";
import { withTxRetry, lockMoneyParents } from "./tx-retry";
import {
    isBlockedByAmbiguousCreate,
    isQboInvoiceLinkedOrPending,
    pendingCreateMarkerWhere,
    QBResolveRequiredError,
} from "./qbo-create-markers";
import {
    createRouteDeadline,
    isBudgetExhausted,
    isQBBudgetExhaustedError,
    isQboConnectionFailure,
    isQBTimeoutError,
    isQBTokenStrandedError,
    type RouteDeadline,
} from "./quickbooks";

/**
 * Whole-call budget for the QuickBooks-heavy billing paths, under the 60s
 * server-action ceiling and leaving room to return a result.
 *
 * Each of these functions walks a LIST of milestones doing several serial QBO
 * calls each. Bounding the individual calls is not enough: during the
 * 2026-09-01 outage every row burned a fresh 20s deadline against the same
 * wall, so the SUM still ran to the platform ceiling and the action was killed
 * with nothing reported. One budget, created at the entry, threaded through
 * every call — and the loops stop on a connection-level failure instead of
 * proving it once per row.
 */
export const BILLING_QBO_BUDGET_MS = 45_000;

/**
 * Is this the shared wall — the failure the NEXT row would hit identically?
 *
 * A business refusal ("this milestone is already paid") is per row and the loop
 * carries on past it. A timeout, a 429/5xx, a 401/403 or a stranded token is
 * the connection, and every remaining row would spend its own full deadline
 * rediscovering that.
 */
export function isSharedQboWall(error: unknown): boolean {
    return isQBBudgetExhaustedError(error) || isQboConnectionFailure(error) || isQBTokenStrandedError(error);
}

/** What to tell the user about a row we never got to. */
export function outageNote(error: unknown): string {
    return isQBTimeoutError(error)
        ? "QuickBooks stopped responding — not attempted. Try again in a few minutes."
        : "QuickBooks is unavailable — not attempted. Try again in a few minutes.";
}
import { sendNotification } from "./email";
import { formatCurrency } from "./utils";
import { coTaxRate, coTaxLabel, coLineCents, billableCoItems, coSectionRowError, coSectionRowNames } from "./co-tax";
import { deriveInvoiceTaxFields, toNum } from "./prisma-helpers";
import { dateInputInTimeZone, endOfDateInTimeZone, resolveCompanyTimeZone } from "./company-timezone";

// Session-free cores of the billing flows, shared by the permission-gated server
// actions in actions.ts and the MCP connector (whose auth is the shared secret at
// the transport). actions.ts is "use server", so every export there is a remotely
// invokable endpoint — auth-free logic must live here, NOT there.
//
// The bodies of sendInvoiceToClientCore / sendMilestoneInvoicesCore are moved
// verbatim from actions.ts; behavior is unchanged for the UI paths.

// Copy of actions.ts's local buildCc (it can't be exported from a "use server"
// module because only async functions may be exported there).
function buildCc(primaryEmail: string, ...candidates: (string | null | undefined)[]): string[] | undefined {
    const primary = (primaryEmail || "").trim().toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of candidates) {
        const e = c?.trim();
        if (!e) continue;
        const key = e.toLowerCase();
        if (key === primary || seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    return out.length ? out : undefined;
}

async function logActivityLazy(entry: Parameters<typeof import("./activity-log").logActivity>[0]) {
    const { logActivity } = await import("./activity-log");
    return logActivity(entry);
}

// Shared HTML-escaping for values interpolated into email templates below —
// titles, names, and project names are user/AI supplied and must not be able
// to inject markup into an email we control the "from" address of.
function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Read: everything ChatGPT needs to find the right invoice/milestone for a job.
// ─────────────────────────────────────────────────────────────────────────────

export async function getProjectBilling(projectId: string) {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            name: true,
            status: true,
            client: { select: { name: true, email: true, additionalEmail: true } },
            estimates: {
                where: { archivedAt: null },
                orderBy: { createdAt: "desc" },
                select: { id: true, code: true, title: true, status: true, totalAmount: true },
            },
            invoices: {
                orderBy: { createdAt: "desc" },
                select: {
                    id: true, code: true, status: true, totalAmount: true, balanceDue: true,
                    issueDate: true, sentAt: true,
                    payments: {
                        orderBy: { createdAt: "asc" },
                        select: {
                            id: true, name: true, amount: true, status: true, dueDate: true, paidAt: true,
                            qbInvoiceId: true, qbInvoiceLink: true, qbInvoiceSentAt: true, qbSyncError: true,
                        },
                    },
                },
            },
        },
    });
    if (!project) return null;

    return {
        project: { id: project.id, name: project.name, status: project.status },
        client: project.client ? { name: project.client.name, email: project.client.email } : null,
        estimates: project.estimates.map(e => ({
            id: e.id, code: e.code, title: e.title, status: e.status, total: Number(e.totalAmount),
        })),
        changeOrders: (await prisma.changeOrder.findMany({
            where: { projectId },
            orderBy: { createdAt: "desc" },
            select: { id: true, code: true, title: true, status: true, totalAmount: true, approvedAt: true, sentAt: true },
        })).map(co => ({
            id: co.id, code: co.code, title: co.title, status: co.status,
            total: Number(co.totalAmount), approvedAt: co.approvedAt, sentAt: co.sentAt,
        })),
        invoices: project.invoices.map(inv => ({
            id: inv.id, code: inv.code, status: inv.status,
            total: Number(inv.totalAmount), balanceDue: Number(inv.balanceDue),
            sentAt: inv.sentAt, issueDate: inv.issueDate,
            milestones: inv.payments.map(p => ({
                id: p.id, name: p.name, amount: Number(p.amount), status: p.status,
                dueDate: p.dueDate, paidAt: p.paidAt,
                inQuickBooks: !!p.qbInvoiceId,
                lastEmailedAt: p.qbInvoiceSentAt,
                paymentLinkStale: !!p.qbSyncError || (!!p.qbInvoiceId && !p.qbInvoiceLink),
                qbSyncError: p.qbSyncError,
            })),
        })),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts receivable: every invoice still owed money, across all projects.
// ─────────────────────────────────────────────────────────────────────────────

export async function listReceivables() {
    const now = Date.now();
    const invoices = await prisma.invoice.findMany({
        where: { balanceDue: { gt: 0 }, status: { notIn: ["Draft"] } },
        orderBy: { issueDate: "asc" },
        select: {
            id: true, code: true, status: true, totalAmount: true, balanceDue: true,
            issueDate: true, sentAt: true, createdAt: true,
            project: { select: { id: true, name: true } },
            client: { select: { name: true, email: true } },
            payments: {
                where: { status: "Pending" },
                orderBy: { createdAt: "asc" },
                select: { id: true, name: true, amount: true, dueDate: true, qbInvoiceSentAt: true, qbSyncError: true },
            },
        },
    });

    const rows = invoices.map(inv => {
        const anchor = inv.issueDate ?? inv.sentAt ?? inv.createdAt;
        const ageDays = Math.floor((now - anchor.getTime()) / 86_400_000);
        // Due dates are business dates: a milestone isn't "past due" until the
        // whole due day has elapsed (24h grace covers timezone-of-storage skew).
        const pastDue = inv.payments.some(p => p.dueDate && p.dueDate.getTime() + 86_400_000 < now);
        return {
            invoiceId: inv.id,
            code: inv.code,
            status: inv.status,
            project: inv.project?.name ?? null,
            projectId: inv.project?.id ?? null,
            client: inv.client?.name ?? null,
            balanceDue: Number(inv.balanceDue),
            total: Number(inv.totalAmount),
            ageDays,
            overdue: pastDue || ageDays > 30,
            unpaidMilestones: inv.payments.map(p => ({
                id: p.id, name: p.name, amount: Number(p.amount), dueDate: p.dueDate,
                lastEmailedAt: p.qbInvoiceSentAt, paymentLinkStale: !!p.qbSyncError,
            })),
        };
    });

    return {
        totalOutstanding: Math.round(rows.reduce((s, r) => s + r.balanceDue, 0) * 100) / 100,
        overdueOutstanding: Math.round(rows.filter(r => r.overdue).reduce((s, r) => s + r.balanceDue, 0) * 100) / 100,
        invoiceCount: rows.length,
        invoices: rows,
    };
}

/**
 * Weekly AR digest to the team (System Notification Email). Returns the summary
 * so the cron response is inspectable; sends nothing when nothing is owed.
 */
export async function sendArDigest() {
    const ar = await listReceivables();
    if (ar.invoiceCount === 0) return { sent: false, reason: "nothing outstanding", ...ar };

    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { notificationEmail: true, email: true, companyName: true } });
    const to = settings?.notificationEmail?.trim() || settings?.email?.trim();
    if (!to) return { sent: false, reason: "no notification email configured", ...ar };

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const row = (r: (typeof ar.invoices)[number]) => `
        <tr style="${r.overdue ? "background:#fef2f2;" : ""}">
            <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(r.code)}${r.overdue ? " ⚠️" : ""}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(r.project ?? "—")}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(r.client ?? "—")}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${formatCurrency(r.balanceDue)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${r.ageDays}d</td>
        </tr>`;

    const sendResult = await sendNotification(
        to,
        `AR digest — ${formatCurrency(ar.totalOutstanding)} outstanding across ${ar.invoiceCount} invoice${ar.invoiceCount === 1 ? "" : "s"}${ar.overdueOutstanding > 0 ? ` (${formatCurrency(ar.overdueOutstanding)} overdue)` : ""}`,
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #333;">
            <h2 style="font-size:18px;">Accounts receivable</h2>
            <p><strong>${formatCurrency(ar.totalOutstanding)}</strong> outstanding · <strong style="color:#b91c1c;">${formatCurrency(ar.overdueOutstanding)}</strong> overdue (30+ days or past due date)</p>
            <table style="border-collapse:collapse;width:100%;font-size:13px;">
                <tr style="text-align:left;color:#64748b;"><th style="padding:6px 10px;">Invoice</th><th style="padding:6px 10px;">Project</th><th style="padding:6px 10px;">Client</th><th style="padding:6px 10px;text-align:right;">Balance</th><th style="padding:6px 10px;text-align:right;">Age</th></tr>
                ${ar.invoices.map(row).join("")}
            </table>
            <p style="color:#64748b;font-size:12px;margin-top:16px;">Ask ChatGPT "who owes us money?" for the live view, or "resend the invoice on [project]" to nudge with a fresh payment link.</p>
        </div>`,
        undefined,
        { fromName: settings?.companyName || "ProBuild" },
    );
    if (!sendResult.success) return { sent: false, reason: "email send failed", ...ar };
    return { sent: true, ...ar };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice creation from a signed estimate. The core is intentionally kept in
// this non-Server-Action module so authenticated machine callers do not have to
// bypass the staff-session guard on actions.ts's public wrapper.
// ─────────────────────────────────────────────────────────────────────────────

async function getDefaultSalesTaxRate(): Promise<number> {
    const settings = await prisma.companySettings.findUnique({
        where: { id: "singleton" },
        select: { salesTaxes: true },
    });
    if (!settings?.salesTaxes) return 0;
    try {
        const taxes = JSON.parse(settings.salesTaxes) as Array<{ rate?: number; isDefault?: boolean }>;
        if (!Array.isArray(taxes) || taxes.length === 0) return 0;
        const selected = taxes.find((tax) => tax.isDefault) || taxes[0];
        return typeof selected.rate === "number" ? selected.rate : 0;
    } catch {
        return 0;
    }
}

export async function createInvoiceFromEstimateCore(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) throw new Error("Estimate not found");

    const project = await prisma.project.findUnique({ where: { id: estimate.projectId! } });
    if (!project) throw new Error("Project not found");

    const total = toNum(estimate.totalAmount || 0);
    const rate = estimate.taxRatePercent != null
        ? Number(estimate.taxRatePercent)
        : await getDefaultSalesTaxRate();
    const tax = deriveInvoiceTaxFields(total, rate, !!estimate.taxExempt);

    const invoice = await prisma.invoice.create({
        data: {
            code: "INV-TEMP",
            projectId: estimate.projectId!,
            clientId: project.clientId,
            estimateId: estimate.id,
            status: "Draft",
            totalAmount: total,
            balanceDue: total,
            subtotal: tax.subtotal,
            taxRate: tax.taxRate,
            taxAmount: tax.taxAmount,
        },
    });

    // Named immediately, outside the clone transaction. Folding this into that
    // transaction briefly made a retryable or terminal failure leave the
    // already-visible invoice reading "INV-TEMP", which
    // createInvoiceFromEstimateGuarded would later mistake for a finished
    // conversion (Codex round 3). The orphan-invoice failure mode is
    // pre-existing; this keeps it no worse than it was.
    const invoiceCode = `INV-${String(invoice.number).padStart(5, "0")}`;
    await prisma.invoice.update({ where: { id: invoice.id }, data: { code: invoiceCode } });

    // Clone the estimate's milestones into invoice-side PaymentSchedules. The
    // source read, the clone inserts AND the resulting balance/status write run
    // in ONE transaction that takes the same Project row lock setProjectStartDate
    // uses: a start-date move can then never slip between our read of the source
    // dueDates and the clone inserts (which would leave the new clones on
    // pre-shift dates while their EPS rows and the project's tasks moved -- a
    // partially shifted mirror group). withTxRetry covers residual serialization
    // failures.
    // (Lock + scheduleTaskId propagation ported from c250526 during the
    // feat/company-pipeline-dashboard merge.)
    await withTxRetry(() => prisma.$transaction(async (tx) => {
        // Estimate FIRST, then Project. This clone copies each milestone's
        // status AND its stripePaymentIntentId, so without the Estimate lock a
        // conversion could insert a fresh Paid clone of a charge that a
        // `charge.refunded` unwind had already resolved and was about to
        // release -- the new clone would keep the refunded money and leave its
        // invoice a zero balance. Sharing the lock forces the two to order:
        // convert-then-refund (the clone is seen and released) or
        // refund-then-convert (the milestone is already Pending when cloned).
        // See lib/refund-group.ts.
        //
        // The order is Estimate -> Project, NOT the reverse:
        // restoreEstimateItemAssociations in actions.ts holds one transaction
        // spanning PurchaseOrder -> Estimate -> EstimateItem -> Project, so
        // taking Project first here would let that flow hold Estimate while
        // waiting on Project and this one hold Project while waiting on
        // Estimate (Codex round 2). Holding both across the read+insert is what
        // the Project lock was for, and that is unchanged by the reorder.
        //
        // The INVOICE is deliberately not locked here. It was, briefly, and that
        // put Invoice before Project -- which deadlocks against deleteProjects,
        // whose `onDelete: Cascade` locks Project and then its Invoice children
        // (and which is not retry-wrapped; Codex round 3). It buys nothing
        // either: this invoice was created moments ago and the only way another
        // flow can reach it is through a clone, and clones are inserted under
        // the Estimate lock. The implicit row lock from the update below lands
        // after Project, giving Estimate -> Project -> Invoice, which agrees
        // with deleteProjects' Project -> Invoice.
        await lockMoneyParents(tx, { estimateId });
        // Lead-owned estimates (no projectId) need no Project lock -- start-date
        // moves only target projects.
        if (estimate.projectId) {
            await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${estimate.projectId} FOR UPDATE`;
        }

        const schedules = await tx.estimatePaymentSchedule.findMany({
            where: { estimateId },
            orderBy: { order: "asc" },
        });

        let paidAmount = 0;
        if (schedules.length > 0) {
            for (const schedule of schedules) {
                if (schedule.status === "Paid") paidAmount += toNum(schedule.amount);
                await tx.paymentSchedule.create({
                    data: {
                        invoiceId: invoice.id,
                        sourceScheduleId: schedule.id,
                        // Keep the schedule-task link on the invoice-side clone so
                        // start-date moves can shift both milestone mirrors together.
                        scheduleTaskId: schedule.scheduleTaskId || null,
                        name: schedule.name,
                        amount: schedule.amount,
                        status: schedule.status,
                        dueDate: schedule.dueDate || null,
                        paymentDate: schedule.paymentDate || null,
                        paidAt: schedule.paidAt || null,
                        stripeSessionId: schedule.stripeSessionId || null,
                        stripePaymentIntentId: schedule.stripePaymentIntentId || null,
                        paymentMethod: schedule.paymentMethod || null,
                        referenceNumber: schedule.referenceNumber || null,
                        notes: schedule.notes || null,
                    },
                });
            }
        } else {
            await tx.paymentSchedule.create({
                data: {
                    invoiceId: invoice.id,
                    name: "Initial Payment",
                    amount: estimate.totalAmount || 0,
                    status: "Pending",
                },
            });
        }
        // The derived balance/status is written INSIDE this transaction, under
        // the same Estimate+Invoice locks the clone inserts hold. It used to
        // run after the commit, which let a `charge.refunded` unwind slip in
        // between: the refund would reset the just-cloned Paid milestone and
        // recompute the invoice to Issued, and this write would then overwrite
        // it back to Paid/zero-balance from a paidAmount that was already
        // stale. Rows Pending, invoice claiming nothing was owed (Codex
        // round 2).
        const newBalanceDue = Math.max(0, total - paidAmount);
        const invoiceStatus = paidAmount > 0
            ? (newBalanceDue <= 0 ? "Paid" : "Partially Paid")
            : "Draft";
        await tx.invoice.update({
            where: { id: invoice.id },
            data: { balanceDue: newBalanceDue, status: invoiceStatus },
        });
        return paidAmount;
    }));

    revalidatePath(`/projects/${estimate.projectId}/invoices`);
    return { id: invoice.id, projectId: estimate.projectId };
}

export async function createInvoiceFromEstimateGuarded(estimateId: string) {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { id: true, code: true, title: true, projectId: true, totalAmount: true },
    });
    if (!estimate) return { ok: false as const, error: "Estimate not found" };
    if (!estimate.projectId) return { ok: false as const, error: `Estimate ${estimate.code} is attached to a lead, not a project — convert the lead to a project first.` };

    const existing = await prisma.invoice.findFirst({
        where: { estimateId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], // same tie-break as the post-create branch
        select: { id: true, code: true, status: true, balanceDue: true },
    });
    if (existing) {
        return {
            ok: true as const,
            alreadyExisted: true,
            invoiceId: existing.id,
            invoiceCode: existing.code,
            status: existing.status,
            balanceDue: Number(existing.balanceDue),
            note: "This estimate already has an invoice — no new one created.",
        };
    }

    // Invoice.estimateId has no unique constraint (prod carries one legacy
    // duplicate, so one can't be added yet) — compensate instead of lock: if a
    // concurrent call created an invoice first, delete ours (untouched, seconds
    // old, milestones cascade) and return the winner. Deterministic: earliest
    // createdAt wins, id breaks ties.
    const created = await createInvoiceFromEstimateCore(estimateId);

    const all = await prisma.invoice.findMany({
        where: { estimateId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, code: true, status: true, balanceDue: true },
    });
    const winner = all[0];
    if (winner && winner.id !== created.id) {
        // Conditional delete: only remove OUR seconds-old invoice if it's still an
        // untouched draft. If anything already interacted with it, keep both and
        // let the duplicate surface for human review rather than destroy state.
        const removed = await prisma.invoice.deleteMany({
            where: { id: created.id, estimateId, status: "Draft", sentAt: null },
        });
        if (removed.count === 1) {
            return {
                ok: true as const,
                alreadyExisted: true,
                invoiceId: winner.id,
                invoiceCode: winner.code,
                status: winner.status,
                balanceDue: Number(winner.balanceDue),
                note: "A concurrent request created this estimate's invoice first — returning that one.",
            };
        }
    }

    const invoice = await prisma.invoice.findUnique({ where: { id: created.id }, select: { code: true, status: true, balanceDue: true } });
    return {
        ok: true as const,
        alreadyExisted: false,
        invoiceId: created.id,
        invoiceCode: invoice?.code ?? "",
        status: invoice?.status ?? "Draft",
        balanceDue: Number(invoice?.balanceDue ?? 0),
        note: `Invoice ${invoice?.code} created from estimate ${estimate.code} with its payment milestones. Use send_milestone_invoice or resend_invoice to send it.`,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice email (ProBuild-native portal link). Moved verbatim from actions.ts.
// ─────────────────────────────────────────────────────────────────────────────

export async function sendInvoiceToClientCore(invoiceId: string, overrideEmail?: string) {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            project: { include: { client: true } },
            client: true,
        },
    });
    if (!invoice) throw new Error("Invoice not found");

    const recipientEmail = overrideEmail || invoice.client?.email;
    if (!recipientEmail) throw new Error("No email address provided");

    if (invoice.status === "Draft") {
        await prisma.invoice.update({
            where: { id: invoiceId },
            data: { status: "Issued", issueDate: new Date(), sentAt: new Date() },
        });
    } else {
        await prisma.invoice.update({
            where: { id: invoiceId },
            data: { sentAt: new Date() },
        });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const clientId = invoice.clientId || invoice.project?.clientId;
    let portalUrl: string;
    if (clientId) {
        const { signClientPortalToken } = await import("./client-portal-auth");
        const token = await signClientPortalToken(clientId, recipientEmail.toLowerCase());
        portalUrl = `${appUrl}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(`/portal/invoices/${invoiceId}`)}`;
    } else {
        portalUrl = `${appUrl}/portal/invoices/${invoiceId}`;
    }
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    const invoiceAdditionalEmail = invoice.client?.additionalEmail || invoice.project?.client?.additionalEmail || null;
    const invoiceCc = buildCc(recipientEmail, invoiceAdditionalEmail);
    const emailResult = await sendNotification(
        recipientEmail,
        `${companyName} sent you an invoice — ${invoice.code}`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
            </div>
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Invoice ${invoice.code}</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${invoice.client?.name || 'there'},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${companyName} has sent you an invoice for <strong>${formatCurrency(invoice.totalAmount)}</strong>.
                    Please click the button below to view the details and make a payment.
                </p>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        View & Pay Invoice
                    </a>
                </div>
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center;">
                    <div style="color: #666; font-size: 13px; margin-bottom: 4px;">Amount Due</div>
                    <div style="font-size: 24px; font-weight: 700; color: #111;">${formatCurrency(invoice.balanceDue)}</div>
                </div>
                <p style="color: #999; font-size: 13px; text-align: center; margin-top: 16px;">
                    Or copy this link: ${portalUrl}
                </p>
            </div>
            <p style="text-align: center; color: #aaa; font-size: 12px; margin-top: 32px;">
                Sent via ProBuild • ${companyName}
            </p>
        </body>
        </html>`,
        undefined,
        { fromName: companyName, replyTo: settings?.email || undefined, cc: invoiceCc, copyToInternal: true }
    );

    // Requested-marker stamp, gated on the email actually going out — a failed
    // send must never leave the portal claiming a payment is due.
    if (!emailResult?.success) {
        return { success: false as const, error: "The invoice email could not be sent — please try again.", sentTo: undefined };
    }

    // A whole-invoice email asks the client for everything unpaid, so every
    // Pending milestone becomes "requested". qbInvoiceSentAt doubles as the
    // rail-neutral request marker: the portal only shows Pay buttons and due
    // amounts for requested milestones. (Covers resendInvoiceCore too — it
    // delegates here after refreshing QBO links.) Delivered-but-not-recorded
    // must not read as a send failure — the email DID go out, and reporting
    // failure here would invite a duplicate send — so the stamp is fail-soft
    // and loud, same pattern as the milestone path.
    try {
        await prisma.paymentSchedule.updateMany({
            where: { invoiceId, status: "Pending" },
            data: { qbInvoiceSentAt: new Date() },
        });
    } catch (stampErr) {
        console.error(`[sendInvoiceToClientCore] Email sent but the request stamp failed for invoice ${invoice.code} — portal will show nothing due until a resend:`, stampErr);
    }

    // Log to activity feed (project-scoped only)
    if (invoice.projectId) {
        await logActivityLazy({
            projectId: invoice.projectId,
            actorType: "TEAM",
            actorName: companyName,
            action: "sent_invoice",
            entityType: "invoice",
            entityId: invoiceId,
            entityName: `Invoice ${invoice.code}`,
        });
    }

    if (invoice.projectId) {
        revalidatePath(`/projects/${invoice.projectId}/invoices`);
        revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
    }
    revalidatePath(`/invoices`);
    return { success: true as const, sentTo: recipientEmail };
}

/**
 * Resend an invoice whose QuickBooks payment links may have gone stale: refresh
 * each milestone's QBO link (re-pushing clears "voided"/"notFound" flags where
 * possible), then send the ProBuild invoice email with its always-current portal
 * link. QuickBooks being disconnected downgrades to a plain resend, not a failure.
 */
export async function resendInvoiceCore(invoiceId: string, overrideEmail?: string, deadline?: RouteDeadline) {
    const qbDeadline = deadline ?? createRouteDeadline(BILLING_QBO_BUDGET_MS);
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: { select: { id: true, name: true, qbInvoiceId: true, status: true } } },
    });
    if (!invoice) return { success: false as const, error: "Invoice not found" };

    const linkRefresh: Array<{ milestone: string; refreshed: boolean; payLink?: string; error?: string }> = [];
    const qbMilestones = invoice.payments.filter(p => p.qbInvoiceId && p.status !== "Paid" && p.status !== "Canceled");
    if (qbMilestones.length > 0) {
        try {
            const { getFreshQBTokens, pushMilestoneToQuickBooks } = await import("./quickbooks-payments");
            const { getQBInvoicePaymentLink } = await import("./quickbooks");
            const tokens = await getFreshQBTokens(qbDeadline);
            for (const [index, m] of qbMilestones.entries()) {
                if (isBudgetExhausted(qbDeadline)) {
                    for (const rest of qbMilestones.slice(index)) {
                        linkRefresh.push({ milestone: rest.name, refreshed: false, error: "Out of time — link not refreshed (the portal link still works)." });
                    }
                    break;
                }
                try {
                    // pushMilestoneToQuickBooks repairs voided/notFound state but reuses a
                    // stored link when one exists — fetch the CURRENT link from QBO so a
                    // stale stored value can't be handed back as "refreshed".
                    const res = await pushMilestoneToQuickBooks(m.id, tokens, qbDeadline);
                    let payLink = res.payLink || undefined;
                    if (res.qbInvoiceId) {
                        const liveLink = await getQBInvoicePaymentLink(tokens, res.qbInvoiceId, qbDeadline);
                        if (liveLink) {
                            if (liveLink !== payLink) {
                                await prisma.paymentSchedule.update({ where: { id: m.id }, data: { qbInvoiceLink: liveLink } });
                            }
                            payLink = liveLink;
                        }
                    }
                    linkRefresh.push({ milestone: m.name, refreshed: true, payLink });
                } catch (err: any) {
                    linkRefresh.push({ milestone: m.name, refreshed: false, error: err?.message || "refresh failed" });
                    // The wall is shared: every remaining milestone would spend
                    // another full deadline discovering the same thing.
                    if (isSharedQboWall(err)) {
                        for (const rest of qbMilestones.slice(index + 1)) {
                            linkRefresh.push({ milestone: rest.name, refreshed: false, error: outageNote(err) });
                        }
                        break;
                    }
                }
            }
        } catch {
            linkRefresh.push({ milestone: "(all)", refreshed: false, error: "QuickBooks not connected — portal link still works" });
        }
    }

    const sent = await sendInvoiceToClientCore(invoiceId, overrideEmail);
    return { ...sent, linkRefresh };
}

// ─────────────────────────────────────────────────────────────────────────────
// Milestone-scoped payment request email. The client is asked for EXACTLY the
// listed milestones — the whole-invoice total/balance never appears in the
// email — and the portal link opens the invoice focused on just those payments
// (/portal/invoices/<id>?milestone=<ids>), where views are first-class events.
//
// Composition (buildMilestoneRequestEmail) is a pure exported function so the
// e2e regression net can pin the milestone-only totals, HTML escaping, and
// header sanitization without a mail provider.
// ─────────────────────────────────────────────────────────────────────────────

// Header-injection guard for values that end up in the Subject/From headers.
function sanitizeHeaderValue(s: string): string {
    return s.replace(/[\r\n]+/g, " ").trim();
}

export function buildMilestoneRequestEmail(input: {
    companyName: string;
    clientName: string | null | undefined;
    projectName: string | null | undefined;
    invoiceCode: string;
    milestones: Array<{ name: string; amount: number }>;
    portalUrl: string;
}): { subject: string; html: string } {
    const company = escapeHtml(input.companyName);
    const total = input.milestones.reduce((sum, m) => sum + m.amount, 0);
    const single = input.milestones.length === 1;
    const projectName = input.projectName || "project";
    const milestoneRows = input.milestones.map(m => `
                    <tr>
                        <td style="padding: 10px 0; color: #333; border-bottom: 1px solid #f0f0f0;">${escapeHtml(m.name)}</td>
                        <td style="padding: 10px 0; color: #111; font-weight: 600; text-align: right; border-bottom: 1px solid #f0f0f0;">${formatCurrency(m.amount)}</td>
                    </tr>`).join("");

    const subject = sanitizeHeaderValue(
        `${input.companyName} — payment request: ${formatCurrency(total)} due${single ? ` for ${input.milestones[0].name}` : ""}`
    );

    const html = `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${company}</h1>
            </div>
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Payment Requested</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${escapeHtml(input.clientName || 'there')},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${company} is requesting ${single ? "a progress payment" : "payment"} for your ${escapeHtml(projectName)}:
                </p>
                <table style="width: 100%; border-collapse: collapse; margin: 8px 0 0;">
                    ${milestoneRows}
                </table>
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center; margin-top: 24px;">
                    <div style="color: #666; font-size: 13px; margin-bottom: 4px;">Amount Due Now</div>
                    <div style="font-size: 24px; font-weight: 700; color: #111;">${formatCurrency(total)}</div>
                </div>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${escapeHtml(input.portalUrl)}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        View &amp; Pay ${formatCurrency(total)}
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; text-align: center; margin-top: 16px;">
                    Reference: Invoice ${escapeHtml(input.invoiceCode)}. Only the payment${single ? "" : "s"} above ${single ? "is" : "are"} due now — your full invoice is available at the same link for reference.
                </p>
                <p style="color: #999; font-size: 13px; text-align: center; margin-top: 8px;">
                    Or copy this link: ${escapeHtml(input.portalUrl)}
                </p>
            </div>
            <p style="text-align: center; color: #aaa; font-size: 12px; margin-top: 32px;">
                Sent via ProBuild • ${company}
            </p>
        </body>
        </html>`;

    return { subject, html };
}

async function sendMilestoneRequestEmail(
    invoice: {
        id: string;
        code: string;
        clientId: string | null;
        client: { name: string | null; email: string | null; additionalEmail: string | null } | null;
        project: { name: string; clientId: string | null; client: { additionalEmail: string | null } | null } | null;
    },
    milestones: Array<{ id: string; name: string; amount: number }>,
    recipient: string,
    companyName: string,
): Promise<void> {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const clientId = invoice.clientId || invoice.project?.clientId;
    const nextPath = `/portal/invoices/${invoice.id}?milestone=${milestones.map(m => m.id).join(",")}`;
    let portalUrl: string;
    if (clientId) {
        const { signClientPortalToken } = await import("./client-portal-auth");
        const token = await signClientPortalToken(clientId, recipient.toLowerCase());
        portalUrl = `${appUrl}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(nextPath)}`;
    } else {
        portalUrl = `${appUrl}${nextPath}`;
    }

    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const { subject, html } = buildMilestoneRequestEmail({
        companyName,
        clientName: invoice.client?.name,
        projectName: invoice.project?.name,
        invoiceCode: invoice.code,
        milestones,
        portalUrl,
    });

    const result = await sendNotification(
        recipient,
        subject,
        html,
        undefined,
        {
            fromName: sanitizeHeaderValue(companyName),
            replyTo: settings?.email || undefined,
            cc: buildCc(recipient, invoice.client?.additionalEmail || invoice.project?.client?.additionalEmail || null),
            copyToInternal: true,
        }
    );
    // sendNotification reports provider/network failure as { success: false }
    // rather than throwing — escalate it so no milestone is stamped "sent"
    // when no email actually left.
    if (!result.success) {
        throw new Error("Email provider failed to send the payment request");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Milestone send: QBO stays the money rail (push + Drift Guard per milestone),
// but the client-facing email is ProBuild's milestone-scoped request above.
// Moved from actions.ts; the actor's display name is a parameter instead of
// coming from the session.
// ─────────────────────────────────────────────────────────────────────────────

export async function sendMilestoneInvoicesCore(
    invoiceId: string,
    paymentScheduleIds: string[],
    overrideEmail: string | undefined,
    // Per-milestone reconcile intents the user explicitly confirmed in the review
    // step: scheduleId -> the QBO total they saw and approved. Doubles as an
    // optimistic-lock token (we only reconcile if the live QBO total still matches).
    opts: { reconcile?: Record<string, number> } | undefined,
    actorName: string,
    deadline?: RouteDeadline,
): Promise<{
    success: boolean;
    sent: number;
    failed: number;
    skipped: number;
    // True when one or more selected milestones drifted from QBO and were NOT sent;
    // the modal flips into the side-by-side review step using driftReview.
    needsReview?: boolean;
    driftReview?: Array<{ id: string; name: string; probuildAmount: number; qbTotal: number; direction: "higher" | "lower" }>;
    results: Array<{ id: string; name: string; status: "sent" | "skipped" | "failed" | "reconciled"; error?: string; sentTo?: string }>;
    error?: string;
}> {
    try {
        const invoice = await prisma.invoice.findUnique({
            where: { id: invoiceId },
            include: {
                project: { include: { client: true } },
                client: true,
                payments: true,
            },
        });
        if (!invoice) return { success: false, sent: 0, failed: 0, skipped: 0, results: [], error: "Invoice not found" };

        const allPayments = invoice.payments;
        const selectedPayments = allPayments.filter(p => paymentScheduleIds.includes(p.id));
        if (selectedPayments.length === 0) {
            return { success: false, sent: 0, failed: 0, skipped: 0, results: [], error: "No milestones selected" };
        }

        const { getFreshQBTokens, pushMilestoneToQuickBooks, reconcileMilestoneToQbo } = await import("./quickbooks-payments");
        const { getQBInvoiceStatus, getQBInvoicePaymentLink } = await import("./quickbooks");

        // ONE budget for the whole send, whatever it turns out to touch.
        const sendDeadline = deadline ?? createRouteDeadline(BILLING_QBO_BUDGET_MS);
        let tokens;
        try {
            tokens = await getFreshQBTokens(sendDeadline);
        } catch (qbErr: any) {
            return {
                success: false,
                sent: 0,
                failed: 0,
                skipped: 0,
                results: [],
                error: qbErr instanceof Error ? qbErr.message : "QuickBooks is not connected.",
            };
        }

        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Your Contractor";

        let sentCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        let reconciledEstimate = false;
        const results: Array<{ id: string; name: string; status: "sent" | "skipped" | "failed" | "reconciled"; error?: string; sentTo?: string }> = [];
        const driftReview: Array<{ id: string; name: string; probuildAmount: number; qbTotal: number; direction: "higher" | "lower" }> = [];
        // Milestones that cleared every guard, queued for the single request email
        // that goes out after the loop (one email per batch, not one per milestone).
        // effectiveAmount is the verified QuickBooks total — after a reconcile this
        // is the NEW amount, so the email never quotes the stale pre-reconcile one.
        const sendable: Array<{ schedule: (typeof selectedPayments)[number]; wasReconciled: boolean; effectiveAmount: number }> = [];

        // Set when the loop hits the shared wall: every row after it is
        // reported as not attempted rather than spending its own deadline.
        let qboWall: unknown = null;
        for (const schedule of selectedPayments) {
            if (qboWall) {
                skippedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "skipped", error: outageNote(qboWall) });
                continue;
            }
            if (isBudgetExhausted(sendDeadline)) {
                skippedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "skipped", error: "Out of time — not attempted. Send the rest in a second batch." });
                continue;
            }
            if (schedule.status === "Paid" || schedule.status === "Canceled") {
                skippedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "skipped", error: "Milestone is already paid or canceled" });
                continue;
            }

            const recipient = (overrideEmail || invoice.client?.email || invoice.project?.client?.email || "").trim();
            if (!recipient) {
                skippedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "skipped", error: "Client has no email on file" });
                continue;
            }

            try {
                let qbInvoiceId = schedule.qbInvoiceId;
                let qbTotal: number | undefined;

                if (qbInvoiceId) {
                    const status = await getQBInvoiceStatus(tokens, qbInvoiceId, sendDeadline);
                    qbTotal = status?.total;
                } else {
                    const pushRes = await pushMilestoneToQuickBooks(schedule.id, tokens, sendDeadline);
                    qbInvoiceId = pushRes.qbInvoiceId;
                    qbTotal = pushRes.qbTotal;
                }

                if (!qbInvoiceId) {
                    failedCount++;
                    results.push({ id: schedule.id, name: schedule.name, status: "failed", error: "Failed to create QuickBooks invoice" });
                    continue;
                }

                // Fail closed if we couldn't read the QBO total — the Drift Guard can't
                // vouch for the amount, so don't send an unverified invoice (a transient
                // QBO read failure must not bypass the guard).
                if (qbTotal == null) {
                    failedCount++;
                    results.push({ id: schedule.id, name: schedule.name, status: "failed", error: "Couldn't read the QuickBooks total to verify the amount — please try again." });
                    continue;
                }
                // A $0/negative QBO total means the invoice is voided or deleted.
                if (qbTotal <= 0) {
                    failedCount++;
                    results.push({ id: schedule.id, name: schedule.name, status: "failed", error: "QuickBooks shows $0.00 for this invoice (it may be voided or deleted) — re-push before sending." });
                    continue;
                }

                // Drift Guard: QBO is the system of record for what the client is
                // charged. If it has drifted from the ProBuild milestone, do not send
                // until the user reviews and explicitly approves reconciling ProBuild
                // to the QBO total (optimistic-locked to the exact qbTotal they saw).
                if (Math.abs(qbTotal - Number(schedule.amount)) > 0.05) {
                    const approved = opts?.reconcile?.[schedule.id];
                    // Cent-exact match: only reconcile the precise total the user approved.
                    const userApprovedThisTotal = approved != null && Math.abs(approved - qbTotal) <= 0.005;

                    if (!userApprovedThisTotal) {
                        // Phase 1 (or a stale confirmation): surface for review, do NOT send.
                        driftReview.push({
                            id: schedule.id,
                            name: schedule.name,
                            probuildAmount: Number(schedule.amount),
                            qbTotal,
                            direction: qbTotal > Number(schedule.amount) ? "higher" : "lower",
                        });
                        skippedCount++;
                        results.push({
                            id: schedule.id,
                            name: schedule.name,
                            status: "skipped",
                            error: `QuickBooks total $${qbTotal.toFixed(2)} ≠ milestone $${Number(schedule.amount).toFixed(2)} — review before sending`,
                        });
                        continue;
                    }

                    // Phase 2: authorized + confirmed + still current → reconcile ProBuild to QBO.
                    const recon = await reconcileMilestoneToQbo(schedule.id, qbTotal);
                    if (!recon.ok) {
                        failedCount++;
                        results.push({ id: schedule.id, name: schedule.name, status: "failed", error: recon.error || "Failed to reconcile milestone" });
                        continue;
                    }
                    if (recon.estimateTouched) reconciledEstimate = true;

                    if (invoice.projectId) {
                        await logActivityLazy({
                            projectId: invoice.projectId,
                            actorType: "TEAM",
                            actorName: actorName || companyName,
                            action: "reconciled_milestone_amount",
                            entityType: "invoice",
                            entityId: invoiceId,
                            entityName: `Invoice ${invoice.code}`,
                            metadata: { milestone: schedule.name, from: recon.oldAmount, to: recon.newAmount, source: "quickbooks" },
                        });
                    }
                    // schedule.amount is now stale in memory; the QBO total matches the
                    // reconciled amount, so fall through to send. Mark the result below.
                }

                const approvedTotal = opts?.reconcile?.[schedule.id];
                const wasReconciled = Math.abs(qbTotal - Number(schedule.amount)) > 0.05
                    && approvedTotal != null
                    && Math.abs(approvedTotal - qbTotal) <= 0.005;

                // Amount verified. Queue for the ProBuild-branded request email sent
                // after the loop, instead of Intuit's own invoice email — the client
                // is asked for exactly these milestone amounts (never the whole
                // invoice balance) and the view is tracked on the ProBuild portal.
                sendable.push({ schedule, wasReconciled, effectiveAmount: qbTotal });
            } catch (err: any) {
                failedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "failed", error: err?.message || "Unexpected error during send" });
                // Connection-level: stop. Continuing spends a fresh deadline per
                // row against the same wall — six of those was the whole outage.
                if (isSharedQboWall(err)) qboWall = err;
            }
        }

        // One client email per send batch, listing only the milestones that passed
        // the guards, with a portal link focused on them. If the email itself fails,
        // every queued milestone is marked failed (nothing was communicated), and
        // nothing is stamped as sent.
        if (sendable.length > 0) {
            const recipient = (overrideEmail || invoice.client?.email || invoice.project?.client?.email || "").trim();

            // Refresh each milestone's live QBO pay link so the portal Pay Now
            // never hands the client a stale link (best-effort — the portal
            // still works when a link can't be fetched).
            for (const { schedule } of sendable) {
                if (!schedule.qbInvoiceId) continue;
                if (isBudgetExhausted(sendDeadline)) break;
                try {
                    const liveLink = await getQBInvoicePaymentLink(tokens, schedule.qbInvoiceId, sendDeadline);
                    if (liveLink && liveLink !== schedule.qbInvoiceLink) {
                        await prisma.paymentSchedule.update({ where: { id: schedule.id }, data: { qbInvoiceLink: liveLink } });
                    }
                } catch (err) {
                    // Best-effort, but not blindly: on the shared wall the rest
                    // of this loop is pure cost, and the email still goes out.
                    if (isSharedQboWall(err)) break;
                }
            }

            let emailFailed = false;
            try {
                await sendMilestoneRequestEmail(
                    invoice,
                    sendable.map(s => ({ id: s.schedule.id, name: s.schedule.name, amount: s.effectiveAmount })),
                    recipient,
                    companyName,
                );
            } catch (emailErr: any) {
                emailFailed = true;
                for (const { schedule } of sendable) {
                    failedCount++;
                    results.push({ id: schedule.id, name: schedule.name, status: "failed", error: emailErr?.message || "Failed to send request email" });
                }
            }

            // The email left — from here on a failure is a BOOKKEEPING failure and
            // must never be reported as a send failure (that would invite a
            // duplicate resend to the client). Stamp the batch atomically; if the
            // stamp fails, milestones still report "sent" with the recording error
            // attached so staff know to verify, not resend.
            if (!emailFailed) {
                const stampedAt = new Date();
                let stampError: string | null = null;
                try {
                    await prisma.$transaction(
                        sendable.map(({ schedule }) =>
                            prisma.paymentSchedule.update({ where: { id: schedule.id }, data: { qbInvoiceSentAt: stampedAt } })
                        )
                    );
                } catch (e: any) {
                    stampError = e?.message || "unknown error";
                    console.error("[sendMilestoneInvoices] email delivered but recording the send failed:", e);
                }
                for (const { schedule, wasReconciled } of sendable) {
                    sentCount++;
                    results.push({
                        id: schedule.id,
                        name: schedule.name,
                        status: wasReconciled ? "reconciled" : "sent",
                        sentTo: recipient,
                        ...(stampError ? { error: `Email delivered, but recording the send failed (${stampError}) — verify in QuickBooks before resending` } : {}),
                    });

                    // Log activity per sent milestone (best-effort — never flips a
                    // delivered send to "failed")
                    if (invoice.projectId) {
                        try {
                            await logActivityLazy({
                                projectId: invoice.projectId,
                                actorType: "TEAM",
                                actorName: companyName,
                                action: "sent_invoice",
                                entityType: "invoice",
                                entityId: invoiceId,
                                entityName: `Invoice ${invoice.code}`,
                                metadata: { milestone: schedule.name, sentTo: recipient },
                            });
                        } catch (e) {
                            console.error("[sendMilestoneInvoices] activity log failed for", schedule.name, e);
                        }
                    }
                }
            }
        }

        // If >= 1 successfully sent and invoice is Draft, flip to Issued.
        // Post-delivery bookkeeping: a failure here must NOT fall into the
        // global catch and report success:false for an email the client
        // already received — log it and let the sent results stand.
        if (sentCount > 0 && invoice.status === "Draft") {
            try {
                await prisma.invoice.update({
                    where: { id: invoiceId },
                    data: { status: "Issued", issueDate: new Date() },
                });
            } catch (e) {
                console.error("[sendMilestoneInvoices] email delivered but Draft→Issued flip failed:", e);
            }
        }

        if (invoice.projectId) {
            revalidatePath(`/projects/${invoice.projectId}/invoices`);
            revalidatePath(`/projects/${invoice.projectId}/invoices/${invoiceId}`);
            // A reconcile rewrites the linked estimate + its totals — refresh those views too.
            if (reconciledEstimate) {
                revalidatePath(`/projects/${invoice.projectId}/estimates`);
                if (invoice.estimateId) revalidatePath(`/projects/${invoice.projectId}/estimates/${invoice.estimateId}`);
            }
        }
        revalidatePath(`/invoices`);
        revalidatePath(`/portal`);
        if (reconciledEstimate) {
            revalidatePath(`/estimates`);
            revalidatePath(`/reports/sales-tax`);
        }

        return {
            success: sentCount > 0,
            sent: sentCount,
            failed: failedCount,
            skipped: skippedCount,
            needsReview: driftReview.length > 0,
            driftReview: driftReview.length > 0 ? driftReview : undefined,
            results,
        };
    } catch (globalErr: any) {
        return {
            success: false,
            sent: 0,
            failed: 0,
            skipped: 0,
            results: [],
            error: globalErr?.message || "An unexpected error occurred",
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bill an APPROVED change order: add it as a milestone on the project's invoice
// (mirrors addInvoiceMilestone's totals math) so the existing QB milestone-send
// rail can take it from there. Never bills the same CO twice.
// ─────────────────────────────────────────────────────────────────────────────

type CoInvoiceTarget = { id: string; code: string; status: string };

async function findChangeOrderInvoice(
    tx: Prisma.TransactionClient,
    co: { estimateId: string; projectId: string },
): Promise<CoInvoiceTarget | null> {
    return (await tx.invoice.findFirst({
        where: { estimateId: co.estimateId },
        orderBy: { createdAt: "desc" },
        select: { id: true, code: true, status: true },
    })) ?? (await tx.invoice.findFirst({
        where: { projectId: co.projectId },
        orderBy: { createdAt: "desc" },
        select: { id: true, code: true, status: true },
    }));
}

type CostPlusActuals = {
    laborCents: number;
    expenseCents: number;
    markupCents: number;
    taxCents: number;
    pretaxCents: number;
    totalCents: number;
    fingerprint: string;
    timeEntries: Array<{
        id: string;
        name: string;
        date: string;
        hours: number;
        notes: string | null;
        laborCents: number;
        burdenCents: number;
        totalCents: number;
    }>;
    expenses: Array<{
        id: string;
        date: string;
        vendor: string | null;
        description: string | null;
        receiptUrl: string | null;
        amountCents: number;
    }>;
};

async function loadCostPlusActuals(
    tx: Prisma.TransactionClient,
    changeOrderId: string,
    endAt: Date,
    markupPercent: number,
    taxRate: number,
    lockRows = false,
): Promise<CostPlusActuals> {
    let lockedTimeIds: string[] | null = null;
    let lockedExpenseIds: string[] | null = null;
    if (lockRows) {
        // Stable child order after canonical parent locks: TimeEntry → Expense,
        // each ordered by id. This freezes amounts/tags/dates through snapshot + stamp.
        const timeLocks = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "TimeEntry"
            WHERE "changeOrderId" = ${changeOrderId}
              AND "isBillable" = true
              AND "invoiceId" IS NULL
              AND "invoicedAt" IS NULL
              AND "startTime" <= ${endAt}
            ORDER BY "id" FOR UPDATE`;
        const expenseLocks = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Expense"
            WHERE "changeOrderId" = ${changeOrderId}
              AND "isBillable" = true
              AND "invoiceId" IS NULL
              AND "invoicedAt" IS NULL
              AND COALESCE("date", "createdAt") <= ${endAt}
            ORDER BY "id" FOR UPDATE`;
        lockedTimeIds = timeLocks.map((row) => row.id);
        lockedExpenseIds = expenseLocks.map((row) => row.id);
    }
    const [timeRows, expenseRows] = await Promise.all([
        tx.timeEntry.findMany({
            where: lockRows
                ? { id: { in: lockedTimeIds ?? [] }, invoiceId: null, invoicedAt: null }
                : { changeOrderId, isBillable: true, invoiceId: null, invoicedAt: null, startTime: { lte: endAt } },
            select: {
                id: true,
                startTime: true,
                durationHours: true,
                laborCost: true,
                burdenCost: true,
                notes: true,
                user: { select: { name: true, email: true } },
            },
            orderBy: { id: "asc" },
        }),
        tx.expense.findMany({
            where: lockRows
                ? { id: { in: lockedExpenseIds ?? [] }, invoiceId: null, invoicedAt: null }
                : {
                    changeOrderId,
                    isBillable: true,
                    invoiceId: null,
                    invoicedAt: null,
                    OR: [{ date: { lte: endAt } }, { date: null, createdAt: { lte: endAt } }],
                },
            select: { id: true, date: true, createdAt: true, amount: true, vendor: true, description: true, receiptUrl: true },
            orderBy: { id: "asc" },
        }),
    ]);

    const timeEntries = timeRows.map((row) => {
        const laborCents = Math.round(toNum(row.laborCost) * 100);
        const burdenCents = Math.round(toNum(row.burdenCost) * 100);
        return {
            id: row.id,
            name: row.user.name || row.user.email,
            date: row.startTime.toISOString(),
            hours: row.durationHours ?? 0,
            notes: row.notes,
            laborCents,
            burdenCents,
            totalCents: laborCents + burdenCents,
        };
    });
    const expenses = expenseRows.map((row) => ({
        id: row.id,
        date: (row.date ?? row.createdAt).toISOString(),
        vendor: row.vendor,
        description: row.description,
        receiptUrl: row.receiptUrl,
        amountCents: Math.round(toNum(row.amount) * 100),
    }));
    const laborCents = timeEntries.reduce((sum, row) => sum + row.totalCents, 0);
    const expenseCents = expenses.reduce((sum, row) => sum + row.amountCents, 0);
    const markupCents = Math.round((laborCents + expenseCents) * markupPercent / 100);
    const pretaxCents = laborCents + expenseCents + markupCents;
    const taxCents = Math.round(pretaxCents * taxRate);
    const fingerprintRows = [
        ...timeEntries.map((row) => `time:${row.id}:${row.totalCents}`),
        ...expenses.map((row) => `expense:${row.id}:${row.amountCents}`),
    ].sort();
    return {
        laborCents,
        expenseCents,
        markupCents,
        taxCents,
        pretaxCents,
        totalCents: pretaxCents + taxCents,
        fingerprint: createHash("sha256").update(fingerprintRows.join("|")).digest("hex"),
        timeEntries,
        expenses,
    };
}

export async function previewCostPlusChangeOrderCore(
    changeOrderId: string,
    input: { throughDate: string },
) {
    const timeZone = await resolveCompanyTimeZone();
    const endAt = endOfDateInTimeZone(input.throughDate, timeZone);
    const co = await prisma.changeOrder.findUnique({
        where: { id: changeOrderId },
        select: {
            id: true, code: true, title: true, status: true, pricingType: true, markupPercent: true,
            projectId: true, estimateId: true,
            estimate: { select: { taxExempt: true, taxRatePercent: true, taxRateName: true } },
        },
    });
    if (!co) throw new Error("Change order not found");
    if (co.pricingType !== "COST_PLUS") throw new Error(`${co.code} is not a cost-plus change order`);
    if (co.status !== "Approved") throw new Error(`${co.code} must be Approved before actuals can be billed`);
    const invoice = await prisma.$transaction((tx) => findChangeOrderInvoice(tx, co));
    if (!invoice) throw new Error("This project has no invoice yet — create the invoice first, then bill actuals.");
    const markupPercent = co.markupPercent ?? 10;
    const taxRate = coTaxRate(co.estimate);
    const actuals = await prisma.$transaction((tx) => loadCostPlusActuals(tx, co.id, endAt, markupPercent, taxRate));
    return {
        ...actuals,
        changeOrderId: co.id,
        code: co.code,
        title: co.title,
        throughDate: input.throughDate,
        throughDateEnd: endAt,
        timeZone,
        invoiceId: invoice.id,
        invoiceCode: invoice.code,
        markupPercent,
        taxRate,
        taxLabel: coTaxLabel(co.estimate),
    };
}

export async function billCostPlusChangeOrderCore(
    changeOrderId: string,
    input: {
        throughDate: string;
        actor: string;
        expectedFingerprint?: string;
        expectedInvoiceId?: string;
        expectedMarkupPercent?: number;
        expectedTaxRate?: number;
    },
) {
    const timeZone = await resolveCompanyTimeZone();
    const endAt = endOfDateInTimeZone(input.throughDate, timeZone);
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{
            id: string; code: string; title: string; status: string; pricingType: string;
            markupPercent: number | null; projectId: string; estimateId: string;
        }>>`
            SELECT "id", "code", "title", "status", "pricingType", "markupPercent", "projectId", "estimateId"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) throw new Error("Change order not found");
        if (co.pricingType !== "COST_PLUS") throw new Error(`${co.code} is fixed price — use bill_change_order`);
        if (co.status !== "Approved") throw new Error(`${co.code} must be Approved before actuals can be billed`);
        const estimateTax = await tx.estimate.findUnique({
            where: { id: co.estimateId },
            select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
        });
        const invoice = await findChangeOrderInvoice(tx, co);
        if (!invoice) throw new Error("This project has no invoice yet — create the invoice first, then bill actuals.");
        await lockMoneyParents(tx, { estimateId: co.estimateId, invoiceId: invoice.id });
        const markupPercent = co.markupPercent ?? 10;
        const taxRate = coTaxRate(estimateTax);
        if ((input.expectedInvoiceId && input.expectedInvoiceId !== invoice.id)
            || (input.expectedMarkupPercent != null && input.expectedMarkupPercent !== markupPercent)
            || (input.expectedTaxRate != null && Math.abs(input.expectedTaxRate - taxRate) > 0.0000001)) {
            throw new Error("Billing terms changed since the preview — review the refreshed invoice, markup, and tax before confirming.");
        }
        const actuals = await loadCostPlusActuals(tx, co.id, endAt, markupPercent, taxRate, true);
        if (input.expectedFingerprint && input.expectedFingerprint !== actuals.fingerprint) {
            throw new Error("Billable time or expenses changed since the preview — review the refreshed totals before confirming.");
        }
        if (actuals.timeEntries.length === 0 && actuals.expenses.length === 0) {
            throw new Error(`Nothing to bill through ${input.throughDate}`);
        }
        if (actuals.pretaxCents <= 0 || actuals.totalCents <= 0) {
            throw new Error("Billable actuals must produce a positive invoice total");
        }

        const milestoneName = `${co.code} — ${co.title} (T&M through ${input.throughDate})`.slice(0, 300);
        const milestone = await tx.paymentSchedule.create({
            data: {
                invoiceId: invoice.id,
                name: milestoneName,
                amount: actuals.totalCents / 100,
                pretaxAmount: actuals.pretaxCents / 100,
                taxAmount: actuals.taxCents / 100,
                sourceChangeOrderId: co.id,
                status: "Pending",
            },
        });
        const billing = await tx.changeOrderBilling.create({
            data: {
                changeOrderId: co.id,
                paymentScheduleId: milestone.id,
                label: `T&M through ${input.throughDate}`,
                laborCents: actuals.laborCents,
                expenseCents: actuals.expenseCents,
                markupCents: actuals.markupCents,
                taxCents: actuals.taxCents,
                totalCents: actuals.totalCents,
                snapshot: { timeEntries: actuals.timeEntries, expenses: actuals.expenses },
                createdBy: input.actor,
            },
        });
        const billedAt = new Date();
        if (actuals.timeEntries.length) {
            const stamped = await tx.timeEntry.updateMany({
                where: {
                    id: { in: actuals.timeEntries.map((row) => row.id) },
                    changeOrderId: co.id,
                    isBillable: true,
                    invoiceId: null,
                    invoicedAt: null,
                    startTime: { lte: endAt },
                },
                data: { invoiceId: invoice.id, invoicedAt: billedAt },
            });
            if (stamped.count !== actuals.timeEntries.length) throw new Error("Time entries changed while billing; retry from a fresh preview");
        }
        if (actuals.expenses.length) {
            const stamped = await tx.expense.updateMany({
                where: {
                    id: { in: actuals.expenses.map((row) => row.id) },
                    changeOrderId: co.id,
                    isBillable: true,
                    invoiceId: null,
                    invoicedAt: null,
                    OR: [{ date: { lte: endAt } }, { date: null, createdAt: { lte: endAt } }],
                },
                data: { invoiceId: invoice.id, invoicedAt: billedAt },
            });
            if (stamped.count !== actuals.expenses.length) throw new Error("Expenses changed while billing; retry from a fresh preview");
        }
        const lockedInvoice = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { status: true } });
        await tx.invoice.update({
            where: { id: invoice.id },
            data: {
                subtotal: { increment: actuals.pretaxCents / 100 },
                taxAmount: { increment: actuals.taxCents / 100 },
                totalAmount: { increment: actuals.totalCents / 100 },
                balanceDue: { increment: actuals.totalCents / 100 },
                ...(lockedInvoice?.status === "Paid" ? { status: "Partially Paid" } : {}),
            },
        });
        return {
            ...actuals,
            billingId: billing.id,
            milestoneId: milestone.id,
            milestoneName,
            invoiceId: invoice.id,
            invoiceCode: invoice.code,
            throughDate: input.throughDate,
            timeZone,
        };
    }, { timeout: 15_000 }));
}

type LegacyBillChangeOrderOutcome =
    | { kind: "error"; error: string }
    | { kind: "duplicate"; dup: { id: string; name: string; amount: number; status: string; invoiceId: string; invoiceCode: string } }
    | { kind: "created"; milestoneId: string; milestoneName: string; amount: number; subtotal: number; taxAmount: number; taxLabel: string; invoiceId: string; invoiceCode: string; projectId: string; coCode: string };

async function billChangeOrderCoreLegacy(changeOrderId: string) {
    // Everything — status check, idempotency check, invoice pick, create,
    // totals bump — runs inside ONE transaction that takes a row lock on the
    // CO (SELECT ... FOR UPDATE): concurrent bill calls serialize on the row,
    // and concurrent status writers (approve/decline use plain updates) block
    // until this transaction commits, so a just-declined CO can't be billed.
    const outcome = await withTxRetry(() => prisma.$transaction(async (tx): Promise<LegacyBillChangeOrderOutcome> => {
        const locked = await tx.$queryRaw<Array<{ id: string; code: string; title: string; status: string; totalAmount: unknown; projectId: string; estimateId: string }>>`
            SELECT "id", "code", "title", "status", "totalAmount", "projectId", "estimateId"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) return { kind: "error", error: "Change order not found" };
        if (co.status !== "Approved") {
            return { kind: "error", error: `Change order ${co.code} is "${co.status}" — only Approved change orders can be billed. Send it for customer signature first.` };
        }
        // Bill the amount the customer signed: subtotal + tax ("Revised Amount"
        // on the signature page). The rate comes from the CO's estimate — a
        // tax-exempt customer (per the estimate / their QuickBooks setup) adds no tax.
        const estimateTax = await tx.estimate.findUnique({
            where: { id: co.estimateId },
            select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
        });
        const subtotal = Math.round(Number(co.totalAmount) * 100) / 100;
        const taxAmount = Math.round(subtotal * coTaxRate(estimateTax) * 100) / 100;
        const amount = Math.round((subtotal + taxAmount) * 100) / 100;
        if (!(amount > 0)) return { kind: "error", error: `Change order ${co.code} has a $0 total — nothing to bill.` };

        // Idempotency: a milestone named after this CO on any of the project's
        // invoices means it's already billed (unless canceled). Name-prefix match
        // is the only available link, so an amount mismatch is surfaced for human
        // review instead of being silently treated as already-billed.
        const milestoneName = `${co.code} — ${co.title}`.slice(0, 300);
        const existing = await tx.paymentSchedule.findFirst({
            where: {
                name: { startsWith: `${co.code} — ` },
                status: { not: "Canceled" },
                invoice: { projectId: co.projectId },
            },
            select: { id: true, name: true, amount: true, status: true, invoiceId: true, invoice: { select: { code: true } } },
        });
        if (existing) {
            if (Math.abs(Number(existing.amount) - amount) > 0.005) {
                return {
                    kind: "error",
                    error: `A milestone "${existing.name}" ($${Number(existing.amount).toFixed(2)}) already exists on invoice ${existing.invoice.code} but doesn't match this change order's total ($${amount.toFixed(2)}). Review it in ProBuild before billing.`,
                };
            }
            return { kind: "duplicate", dup: { id: existing.id, name: existing.name, amount: Number(existing.amount), status: existing.status, invoiceId: existing.invoiceId, invoiceCode: existing.invoice.code } };
        }

        // Target invoice: prefer the one generated from the CO's estimate, else the
        // project's most recent. No invoice at all -> tell the user to create one
        // (invoices are auto-created when an estimate is signed) rather than
        // inventing financial records implicitly.
        const invoice =
            (await tx.invoice.findFirst({ where: { estimateId: co.estimateId }, orderBy: { createdAt: "desc" }, select: { id: true, code: true, status: true } })) ??
            (await tx.invoice.findFirst({ where: { projectId: co.projectId }, orderBy: { createdAt: "desc" }, select: { id: true, code: true, status: true } }));
        if (!invoice) {
            return { kind: "error", error: "This project has no invoice yet — create the invoice from the signed estimate in ProBuild first, then bill the change order." };
        }

        // Lock the target invoice (canonical order: this tx already holds the ChangeOrder row lock,
        // now takes the Invoice row) and re-read its status under the lock. Totals move via atomic
        // increments (concurrency-safe on their own), but `status` was read via the non-locking
        // findFirst above — a concurrent settle could otherwise leave it "Paid" with a positive
        // balanceDue after this bump. Reading it under the lock closes that window.
        await lockMoneyParents(tx, { invoiceId: invoice.id });
        const lockedInvoice = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { status: true } });
        const curStatus = lockedInvoice?.status ?? invoice.status;

        const created = await tx.paymentSchedule.create({
            data: { invoiceId: invoice.id, name: milestoneName, amount, status: "Pending" },
        });
        // Same totals math as addInvoiceMilestone: bump invoice totals; a fully
        // Paid invoice becomes Partially Paid when new work lands on it.
        const nextStatus = curStatus === "Paid" ? "Partially Paid" : curStatus;
        await tx.invoice.update({
            where: { id: invoice.id },
            data: {
                totalAmount: { increment: amount },
                balanceDue: { increment: amount },
                ...(nextStatus !== curStatus ? { status: nextStatus } : {}),
            },
        });
        return { kind: "created", milestoneId: created.id, milestoneName, amount, subtotal, taxAmount, taxLabel: coTaxLabel(estimateTax), invoiceId: invoice.id, invoiceCode: invoice.code, projectId: co.projectId, coCode: co.code };
    }, { timeout: 15_000 }));

    if (outcome.kind === "error") return { ok: false as const, error: outcome.error };
    if (outcome.kind === "duplicate") {
        return {
            ok: true as const,
            alreadyBilled: true,
            invoiceId: outcome.dup.invoiceId,
            invoiceCode: outcome.dup.invoiceCode,
            milestoneId: outcome.dup.id,
            milestoneName: outcome.dup.name,
            amount: outcome.dup.amount,
            milestoneStatus: outcome.dup.status,
            note: "This change order is already on the invoice — use send_milestone_invoice if it still needs to go out.",
        };
    }

    // Best-effort: the billing transaction is already committed — a logging
    // hiccup must not make the caller believe the bill failed.
    try {
        await logActivityLazy({
            projectId: outcome.projectId,
            actorType: "TEAM",
            actorName: "ChatGPT connector",
            action: "billed_change_order",
            entityType: "invoice",
            entityId: outcome.invoiceId,
            entityName: `Invoice ${outcome.invoiceCode}`,
            metadata: { changeOrder: outcome.coCode, milestone: outcome.milestoneName, amount: outcome.amount },
        });
    } catch { /* activity feed only */ }

    revalidatePath(`/projects/${outcome.projectId}/invoices`);
    revalidatePath(`/projects/${outcome.projectId}/invoices/${outcome.invoiceId}`);
    revalidatePath(`/invoices`);

    return {
        ok: true as const,
        alreadyBilled: false,
        invoiceId: outcome.invoiceId,
        invoiceCode: outcome.invoiceCode,
        milestoneId: outcome.milestoneId,
        milestoneName: outcome.milestoneName,
        amount: outcome.amount,
        subtotal: outcome.subtotal,
        taxAmount: outcome.taxAmount,
        taxLabel: outcome.taxLabel,
        milestoneStatus: "Pending",
        note: outcome.taxAmount > 0
            ? `Milestone added for the signed Revised Amount: ${formatCurrency(outcome.subtotal)} + ${formatCurrency(outcome.taxAmount)} tax (${outcome.taxLabel}) = ${formatCurrency(outcome.amount)}. Use send_milestone_invoice (preview -> user approval -> confirm) to email the customer the QuickBooks payment link.`
            : `Milestone added for ${formatCurrency(outcome.amount)} (${outcome.taxLabel} — no tax). Use send_milestone_invoice (preview -> user approval -> confirm) to email the customer the QuickBooks payment link.`,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-approval automation: when the customer signs a change order, bill it onto
// the invoice and send them the payment link immediately — their signature on
// the exact amount IS the approval. The team is notified either way; any hiccup
// (no invoice yet, QuickBooks down) turns into an ACTION-NEEDED alert instead of
// a silent stall. Never throws: the customer's approval must stand regardless.
// ─────────────────────────────────────────────────────────────────────────────

export async function billChangeOrderCore(
    changeOrderId: string,
    dependencies: { logActivity?: typeof logActivityLazy; revalidatePath?: typeof revalidatePath } = {},
) {
    const outcome = await withTxRetry(() => prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{
            id: string; code: string; title: string; status: string; pricingType: string;
            totalAmount: unknown; projectId: string; estimateId: string;
        }>>`
            SELECT "id", "code", "title", "status", "pricingType", "totalAmount", "projectId", "estimateId"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) return { ok: false as const, error: "Change order not found" };
        if (co.status !== "Approved") {
            return { ok: false as const, error: `Change order ${co.code} must be Approved before it can be billed.` };
        }
        if (co.pricingType === "COST_PLUS") {
            return { ok: false as const, error: `${co.code} is cost plus — use bill_cost_plus_change_order with a through date.` };
        }
        // Billing invoices the stored totalAmount and never re-derives it from items, so the
        // send and approval guards do not protect a CO that reached Approved before those
        // guards existed. Re-check the one condition that makes the stored total untrustworthy
        // rather than revalidating the whole subtotal — an Approved CO is a signed number, and
        // failing it on ordinary drift would block legitimate billing.
        const billItems = await tx.changeOrderItem.findMany({
            where: { changeOrderId },
            select: { name: true, type: true },
        });
        const sectionRows = coSectionRowNames(billItems);
        if (sectionRows.length > 0) return { ok: false as const, error: coSectionRowError(co.code, sectionRows) };

        const subtotalCents = Math.round(Number(co.totalAmount) * 100);
        if (subtotalCents <= 0) return { ok: false as const, error: `Change order ${co.code} has a $0 total — nothing to bill.` };
        const estimateTax = await tx.estimate.findUnique({
            where: { id: co.estimateId },
            select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
        });
        const rate = coTaxRate(estimateTax);
        const totalTaxCents = Math.round(subtotalCents * rate);
        const invoice = await findChangeOrderInvoice(tx, co);
        if (!invoice) return { ok: false as const, error: "This project has no invoice yet — create the invoice first, then bill the change order." };
        await lockMoneyParents(tx, { estimateId: co.estimateId, invoiceId: invoice.id });
        const lockedInvoice = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { status: true } });

        const schedules = await tx.changeOrderPaymentSchedule.findMany({
            where: { changeOrderId },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        });
        if (schedules.length === 1) return { ok: false as const, error: "Fixed change-order splits require at least two schedule rows" };
        if (schedules.some((row) => Math.round(Number(row.amount) * 100) <= 0)) {
            return { ok: false as const, error: "Every fixed change-order schedule amount must be greater than zero" };
        }
        const priorCents = schedules.slice(0, -1).reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
        const pretaxPlans = schedules.length
            ? schedules.map((row, index) => ({
                sourceCoScheduleId: row.id as string | null,
                name: `${co.code} — ${row.name}`.slice(0, 300),
                dueDate: row.dueDate,
                pretaxCents: index === schedules.length - 1 ? subtotalCents - priorCents : Math.round(Number(row.amount) * 100),
            }))
            : [{ sourceCoScheduleId: null as string | null, name: `${co.code} — ${co.title}`.slice(0, 300), dueDate: null as Date | null, pretaxCents: subtotalCents }];
        if (pretaxPlans.some((plan) => plan.pretaxCents <= 0)) {
            return { ok: false as const, error: "Fixed change-order schedule rows reach or exceed the subtotal before the final remainder" };
        }
        if (schedules.length) {
            const storedCents = schedules.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
            if (storedCents !== subtotalCents) return { ok: false as const, error: "Change-order schedule amounts are out of sync with the signed subtotal" };
        }

        let allocatedTaxCents = 0;
        const plans = pretaxPlans.map((plan, index) => {
            const taxCents = index === pretaxPlans.length - 1
                ? totalTaxCents - allocatedTaxCents
                : Math.round(plan.pretaxCents * rate);
            allocatedTaxCents += taxCents;
            return { ...plan, taxCents, totalCents: plan.pretaxCents + taxCents };
        });
        const existing = await tx.paymentSchedule.findMany({
            where: {
                invoice: { projectId: co.projectId },
                status: { not: "Canceled" },
                OR: [{ sourceChangeOrderId: co.id }, { name: { startsWith: `${co.code} — ` } }],
            },
        });
        const milestones: Array<{
            id: string; name: string; amount: number; pretaxAmount: number; taxAmount: number;
            status: string; created: boolean;
        }> = [];
        let newPretaxCents = 0;
        let newTaxCents = 0;
        let newTotalCents = 0;
        for (const plan of plans) {
            const prior = plan.sourceCoScheduleId
                ? existing.find((row) => row.sourceCoScheduleId === plan.sourceCoScheduleId || row.name === plan.name)
                : existing.find((row) => !row.sourceCoScheduleId);
            if (prior) {
                if (Math.round(Number(prior.amount) * 100) !== plan.totalCents) {
                    return { ok: false as const, error: `Existing milestone "${prior.name}" does not match the signed change-order amount` };
                }
                milestones.push({
                    id: prior.id,
                    name: prior.name,
                    amount: Number(prior.amount),
                    pretaxAmount: Number(prior.pretaxAmount ?? plan.pretaxCents / 100),
                    taxAmount: Number(prior.taxAmount ?? plan.taxCents / 100),
                    status: prior.status,
                    created: false,
                });
                continue;
            }
            const created = await tx.paymentSchedule.create({
                data: {
                    invoiceId: invoice.id,
                    name: plan.name,
                    amount: plan.totalCents / 100,
                    pretaxAmount: plan.pretaxCents / 100,
                    taxAmount: plan.taxCents / 100,
                    sourceChangeOrderId: co.id,
                    sourceCoScheduleId: plan.sourceCoScheduleId,
                    dueDate: plan.dueDate,
                    status: "Pending",
                },
            });
            newPretaxCents += plan.pretaxCents;
            newTaxCents += plan.taxCents;
            newTotalCents += plan.totalCents;
            milestones.push({
                id: created.id,
                name: created.name,
                amount: plan.totalCents / 100,
                pretaxAmount: plan.pretaxCents / 100,
                taxAmount: plan.taxCents / 100,
                status: created.status,
                created: true,
            });
        }
        if (newTotalCents > 0) {
            await tx.invoice.update({
                where: { id: invoice.id },
                data: {
                    subtotal: { increment: newPretaxCents / 100 },
                    taxAmount: { increment: newTaxCents / 100 },
                    totalAmount: { increment: newTotalCents / 100 },
                    balanceDue: { increment: newTotalCents / 100 },
                    ...(lockedInvoice?.status === "Paid" ? { status: "Partially Paid" } : {}),
                },
            });
        }
        return {
            ok: true as const,
            alreadyBilled: milestones.every((row) => !row.created),
            milestones,
            subtotal: subtotalCents / 100,
            taxAmount: totalTaxCents / 100,
            amount: (subtotalCents + totalTaxCents) / 100,
            taxLabel: coTaxLabel(estimateTax),
            invoiceId: invoice.id,
            invoiceCode: invoice.code,
            projectId: co.projectId,
            coCode: co.code,
        };
    }, { timeout: 15_000 }));

    if (!outcome.ok) return outcome;
    try {
        await (dependencies.logActivity ?? logActivityLazy)({
            projectId: outcome.projectId,
            actorType: "TEAM",
            actorName: "ChatGPT connector",
            action: "billed_change_order",
            entityType: "invoice",
            entityId: outcome.invoiceId,
            entityName: `Invoice ${outcome.invoiceCode}`,
            metadata: { changeOrder: outcome.coCode, milestones: outcome.milestones.map((row) => row.name), amount: outcome.amount },
        });
    } catch { /* activity feed only */ }
    (dependencies.revalidatePath ?? revalidatePath)(`/projects/${outcome.projectId}/invoices`);
    (dependencies.revalidatePath ?? revalidatePath)(`/projects/${outcome.projectId}/invoices/${outcome.invoiceId}`);
    (dependencies.revalidatePath ?? revalidatePath)("/invoices");
    const first = outcome.milestones[0];
    return {
        ok: true as const,
        alreadyBilled: outcome.alreadyBilled,
        invoiceId: outcome.invoiceId,
        invoiceCode: outcome.invoiceCode,
        milestoneId: first.id,
        milestoneName: first.name,
        milestones: outcome.milestones,
        amount: outcome.amount,
        subtotal: outcome.subtotal,
        taxAmount: outcome.taxAmount,
        taxLabel: outcome.taxLabel,
        milestoneStatus: first.status,
        note: outcome.alreadyBilled
            ? "This change order is already on the invoice — use send_milestone_invoice if it still needs to go out."
            : `Added ${outcome.milestones.length} milestone${outcome.milestones.length === 1 ? "" : "s"} for ${formatCurrency(outcome.amount)}.`,
    };
}

export async function handleChangeOrderApproved(
    changeOrderId: string,
    opts?: { notify?: boolean; freshlyApproved?: boolean },
): Promise<{ billed: boolean; sent: boolean; issues: string[]; awaitingActuals?: boolean }> {
    const summary: { billed: boolean; sent: boolean; issues: string[]; awaitingActuals?: boolean } = { billed: false, sent: false, issues: [] };
    let coLabel = changeOrderId;
    let amountLabel = "";
    let projectName = "";
    let sentTo = "";

    try {
        const co = await prisma.changeOrder.findUnique({
            where: { id: changeOrderId },
            select: { code: true, title: true, totalAmount: true, pricingType: true, markupPercent: true, approvedBy: true, project: { select: { name: true } } },
        });
        if (co) {
            coLabel = `${co.code} — ${co.title}`;
            amountLabel = formatCurrency(co.totalAmount);
            projectName = co.project?.name ?? "";
        }

        if (co?.pricingType === "COST_PLUS") {
            summary.awaitingActuals = true;
            amountLabel = `cost + ${co.markupPercent ?? 10}% + tax`;
        } else {
            const bill = await billChangeOrderCore(changeOrderId);
            if (bill.ok) {
            // Show the customer's true charge (subtotal + tax) in the team alert.
            amountLabel = "alreadyBilled" in bill && !bill.alreadyBilled && "subtotal" in bill
                ? `${formatCurrency(bill.amount)} = ${formatCurrency(bill.subtotal)} + ${formatCurrency(bill.taxAmount)} tax`
                : formatCurrency(bill.amount);
            }
            if (!bill.ok) {
                summary.issues.push(bill.error);
            } else if (bill.alreadyBilled) {
            // Only the call that FRESHLY billed the CO may auto-send — this makes a
            // concurrent/replayed approval a no-op instead of a duplicate payment
            // email (billChangeOrderCore's row lock guarantees exactly one fresh bill).
                summary.billed = true;
                summary.issues.push(`Already on invoice ${bill.invoiceCode} as "${bill.milestoneName}" — no new payment email sent (it may have gone out earlier; check before resending).`);
            } else {
                summary.billed = true;
                const freshIds = bill.milestones.filter((row) => row.created).map((row) => row.id);
                const send = await sendMilestoneInvoicesCore(bill.invoiceId, freshIds, undefined, undefined, "Auto (change-order approval)");
                const resultIssues = send.results.map(r => r.error).filter((e): e is string => !!e);
                summary.sent = send.results.some(r => !!r.sentTo);
                if (resultIssues.length) summary.issues.push(...resultIssues);
                if (!summary.sent && !resultIssues.length) summary.issues.push(send.error || "QuickBooks send failed");
                sentTo = send.results.find(r => r.sentTo)?.sentTo ?? "";
            }
        }
    } catch (err: any) {
        summary.issues.push(err?.message || "Unexpected error during auto-billing");
    }

    // Only the request that actually transitioned the CO to Approved invokes
    // the schedule hook. It is post-billing and best-effort so money-path state
    // can never be unwound by scheduling.
    if (opts?.freshlyApproved) {
        let PreconditionError: (new (...args: any[]) => Error) | null = null;
        try {
            const { applyChangeOrderToSchedule, CoSchedulePreconditionError } = await import("./schedule-core");
            PreconditionError = CoSchedulePreconditionError;
            await applyChangeOrderToSchedule({
                changeOrderId,
                mode: "merge",
                actor: { type: "SYSTEM", name: "system" },
            });
        } catch (error: any) {
            if (!PreconditionError || !(error instanceof PreconditionError)) {
                summary.issues.push(`Schedule update failed (billing unaffected): ${error?.message ?? error}`);
            }
        }
    }

    // Team notification (System Notification Email in Settings → Company).
    if (opts?.notify === false) return summary;
    try {
        const esc = escapeHtml;
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { notificationEmail: true, companyName: true, email: true } });
        const to = settings?.notificationEmail?.trim() || settings?.email?.trim();
        if (to) {
            const ok = summary.sent;
            const subject = summary.awaitingActuals
                ? `Change order approved — awaiting actuals — ${coLabel} (${amountLabel})`
                : ok
                    ? `✅ Change order approved & payment link sent — ${coLabel} (${amountLabel})`
                    : `⚠️ Change order approved — needs a look — ${coLabel} (${amountLabel})`;
            const detail = summary.awaitingActuals
                ? `<p>The customer approved the cost-plus scope and markup terms. No payment is due yet. Tag actual time and expenses to this change order, then run Bill actuals.</p>`
                : ok
                    ? `<p>The customer signed and the QuickBooks payment link for <strong>${esc(amountLabel)}</strong> was emailed to <strong>${esc(sentTo)}</strong> automatically.</p>`
                    : `<p>The customer signed, but no payment email went out automatically:</p><ul>${summary.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul><p>Review in ProBuild or ChatGPT (list_project_billing shows the state; send_milestone_invoice sends when appropriate).</p>`;
            await sendNotification(
                to,
                subject,
                `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #333;">
                    <h2 style="font-size:18px;">Change order approved${projectName ? ` — ${esc(projectName)}` : ""}</h2>
                    <p><strong>${esc(coLabel)}</strong> (${esc(amountLabel)})</p>
                    ${detail}
                </div>`,
                undefined,
                { fromName: settings?.companyName || "ProBuild" },
            );
        }
    } catch { /* notification is best-effort */ }

    return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-order signature request. Moved verbatim from actions.ts's
// sendChangeOrderToClient; emails the customer a portal link to review & sign.
// ─────────────────────────────────────────────────────────────────────────────

export async function sendChangeOrderToClientCore(
    changeOrderId: string,
    dependencies: {
        sendNotification?: typeof sendNotification;
        logActivity?: typeof logActivityLazy;
        revalidatePath?: typeof revalidatePath;
    } = {},
): Promise<{ success: true; sentTo: string } | { success: false; error: string }> {
    // Read, amount math, and the Draft/Sent -> Sent flip run inside ONE
    // transaction holding a row lock on the CO (SELECT ... FOR UPDATE, same
    // pattern as billChangeOrderCore): a concurrent writer (editor save,
    // co-audit repair) blocks until commit, so the amount emailed is exactly
    // the amount that was on the row when it was marked Sent. The email
    // itself stays outside the transaction.
    type SendCoOutcome =
        | { kind: "error"; error: string }
        | {
            kind: "ok";
            code: string; title: string; projectId: string; projectName: string;
            clientId: string; clientName: string; clientEmail: string; additionalEmail: string | null;
            coSubtotal: number; coTaxAmount: number; coRevisedAmount: number; taxLabel: string;
            pricingType: string; markupPercent: number; updatedAt: Date;
            schedules: Array<{ name: string; amount: number; dueDate: Date | null }>;
        };
    const outcome = await prisma.$transaction(async (tx): Promise<SendCoOutcome> => {
        const locked = await tx.$queryRaw<Array<{ id: string; code: string; title: string; status: string; pricingType: string; markupPercent: number | null; totalAmount: unknown; projectId: string; estimateId: string; updatedAt: Date }>>`
            SELECT "id", "code", "title", "status", "pricingType", "markupPercent", "totalAmount", "projectId", "estimateId", "updatedAt"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) return { kind: "error", error: "Change order not found" };
        // Only Draft/Sent may be (re)sent — a CO that flipped to Approved/Declined
        // since the caller checked must not get a signature request.
        if (co.status !== "Draft" && co.status !== "Sent") {
            return { kind: "error", error: `Change order ${co.code} is no longer in a sendable state (now "${co.status}") — refresh and retry.` };
        }

        // An unpriced draft (e.g. an AI-suggested CO the PM hasn't priced yet)
        // must never reach the client for signature at $0 — once approved it
        // bills and locks, and a $0 approved CO can't be repaired.
        const items = await tx.changeOrderItem.findMany({
            where: { changeOrderId },
            select: { name: true, type: true, quantity: true, unitCost: true },
        });
        // Legacy rows written before section headers were rejected at the write path. A header
        // mirrors the total of the lines beneath it, so it must never reach a client signature.
        const sectionRows = coSectionRowNames(items);
        if (sectionRows.length > 0) {
            return { kind: "error", error: coSectionRowError(co.code, sectionRows) };
        }
        const storedSubtotalCents = Math.round(Number(co.totalAmount) * 100);
        const renderedSubtotalCents = billableCoItems(items).reduce(
            (sum, item) => sum + coLineCents(item.quantity, Number(item.unitCost)),
            0,
        );
        if (co.pricingType !== "COST_PLUS" && (items.length === 0 || storedSubtotalCents <= 0 || renderedSubtotalCents <= 0)) {
            return { kind: "error", error: `Change order ${co.code} has no priced items yet — add pricing before sending it to the client.` };
        }
        if (co.pricingType !== "COST_PLUS" && storedSubtotalCents !== renderedSubtotalCents) {
            return { kind: "error", error: `Change order ${co.code} pricing is out of sync with its items — save it before sending.` };
        }

        const project = await tx.project.findUnique({
            where: { id: co.projectId },
            select: { name: true, client: { select: { id: true, name: true, email: true, additionalEmail: true } } },
        });
        const client = project?.client;
        if (!client?.email) return { kind: "error", error: "Client has no email address" };

        // co.totalAmount is the PRE-TAX subtotal (same semantic as billChangeOrderCore).
        // The email must show the tax-inclusive Revised Amount — the number on the
        // signature page and the number billing will actually charge.
        const estimateTax = await tx.estimate.findUnique({
            where: { id: co.estimateId },
            select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
        });
        const coSubtotal = Math.round(Number(co.totalAmount) * 100) / 100;
        const coTaxAmount = Math.round(coSubtotal * coTaxRate(estimateTax) * 100) / 100;
        const coRevisedAmount = Math.round((coSubtotal + coTaxAmount) * 100) / 100;
        const schedules = await tx.changeOrderPaymentSchedule.findMany({
            where: { changeOrderId },
            orderBy: [{ order: "asc" }, { id: "asc" }],
            select: { name: true, amount: true, dueDate: true },
        });
        if (co.pricingType === "COST_PLUS" && schedules.length > 0) {
            return { kind: "error", error: "Cost-plus change orders cannot have a fixed payment schedule." };
        }

        const sentCo = await tx.changeOrder.update({
            where: { id: changeOrderId },
            data: { status: "Sent", sentAt: new Date() },
            select: { updatedAt: true },
        });

        return {
            kind: "ok",
            code: co.code, title: co.title, projectId: co.projectId, projectName: project?.name ?? "",
            clientId: client.id, clientName: client.name, clientEmail: client.email, additionalEmail: client.additionalEmail,
            coSubtotal, coTaxAmount, coRevisedAmount, taxLabel: coTaxLabel(estimateTax),
            pricingType: co.pricingType,
            markupPercent: co.markupPercent ?? 10,
            updatedAt: sentCo.updatedAt,
            schedules: schedules.map((row) => ({ ...row, amount: Number(row.amount) })),
        };
    }, { timeout: 15_000 });

    if (outcome.kind === "error") return { success: false, error: outcome.error };
    const { code, title, projectId, projectName, coSubtotal, coTaxAmount, coRevisedAmount, taxLabel, pricingType, markupPercent, schedules } = outcome;
    const client = { id: outcome.clientId, name: outcome.clientName, email: outcome.clientEmail, additionalEmail: outcome.additionalEmail };

    const { buildClientPortalUrl } = await import("./client-portal-auth");
    const portalUrl = await buildClientPortalUrl(client.id, client.email, `/portal/change-orders/${changeOrderId}`);
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    // The row lock released at commit, so a writer that was queued behind it
    // (editor save, co-audit repair) can land an edit while the portal URL and
    // settings were being built above. The send is external and can't be rolled
    // back — re-check the row last and abort on drift instead of emailing a
    // number that no longer matches the portal. FOR UPDATE (not findUnique):
    // the recheck must WAIT for any in-flight writer to commit before reading,
    // or it would read the pre-update row and pass while stale.
    const recheckRows = await prisma.$queryRaw<Array<{ status: string; totalAmount: unknown; updatedAt: Date }>>`
        SELECT "status", "totalAmount", "updatedAt" FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
    const recheck = recheckRows[0];
    if (!recheck || recheck.status !== "Sent" || recheck.updatedAt.getTime() !== outcome.updatedAt.getTime()
        || Math.abs(Math.round(Number(recheck.totalAmount) * 100) / 100 - coSubtotal) > 0.005) {
        return { success: false, error: `Change order ${code} was modified while the email was being prepared — review it and send again.` };
    }

    const changeOrderCc = buildCc(client.email, client.additionalEmail);
    await (dependencies.sendNotification ?? sendNotification)(
        client.email,
        `${companyName} sent you a change order to review`,
        `<!DOCTYPE html>
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                <h2 style="font-size: 20px; margin: 0 0 8px;">Change Order for Your Review</h2>
                <p style="color: #666; margin: 0 0 24px;">Hi ${escapeHtml(client.name)},</p>
                <p style="color: #666; line-height: 1.6;">
                    ${escapeHtml(companyName)} has sent you a change order titled "<strong>${escapeHtml(title)}</strong>" for project <strong>${escapeHtml(projectName || "your project")}</strong>.
                    Please review the scope changes and approve or decline.
                </p>
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0;">
                    ${pricingType === "COST_PLUS"
                        ? `<div style="font-size: 18px; font-weight: 700; color: #111;">Cost + ${markupPercent}% + tax</div><div style="color:#666;font-size:13px;margin-top:6px;">Billed from actual time and materials. Scope-line amounts are non-binding estimates.</div>`
                        : `<div style="color: #666; font-size: 13px; margin-bottom: 4px;">Change Order Amount</div><div style="font-size: 24px; font-weight: 700; color: #111;">${formatCurrency(coRevisedAmount)}</div>${coTaxAmount > 0 ? `<div style="color: #999; font-size: 12px; margin-top: 4px;">${formatCurrency(coSubtotal)} + ${formatCurrency(coTaxAmount)} ${escapeHtml(taxLabel)}</div>` : ""}`}
                    ${schedules.length ? `<div style="margin-top:16px;text-align:left;"><strong>Payment schedule</strong>${schedules.map((row) => `<div style="display:flex;justify-content:space-between;margin-top:6px;"><span>${escapeHtml(row.name)}${row.dueDate ? ` (${row.dueDate.toLocaleDateString("en-US")})` : ""}</span><span>${formatCurrency(row.amount)}</span></div>`).join("")}</div>` : ""}
                </div>
                <div style="text-align: center; margin: 32px 0;">
                    <a href="${portalUrl}" style="display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                        Review Change Order
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; text-align: center;">
                    Or copy this link: ${portalUrl}
                </p>
            </div>
            <p style="text-align: center; color: #aaa; font-size: 12px; margin-top: 32px;">
                Sent via ProBuild &bull; ${escapeHtml(companyName)}
            </p>
        </body>
        </html>`,
        undefined,
        { fromName: companyName, replyTo: settings?.email || undefined, cc: changeOrderCc, copyToInternal: true }
    );

    // Log activity
    await (dependencies.logActivity ?? logActivityLazy)({
        projectId,
        actorType: "TEAM",
        actorName: companyName,
        action: "sent_change_order",
        entityType: "change_order",
        entityId: changeOrderId,
        entityName: `Change Order ${code || title}`,
    });

    (dependencies.revalidatePath ?? revalidatePath)(`/projects/${projectId}/change-orders/${changeOrderId}`);
    (dependencies.revalidatePath ?? revalidatePath)(`/projects/${projectId}/change-orders`);
    return { success: true, sentTo: client.email };
}

// ─────────────────────────────────────────────────────────────────────────────
// Field change orders: DRAFT only. Sending/approval stays a human step in ProBuild.
// ─────────────────────────────────────────────────────────────────────────────

export type ChangeOrderDraftInput = {
    projectId: string;
    estimateId: string;
    title: string;
    description?: string;
    pricingType?: "FIXED" | "COST_PLUS";
    markupPercent?: number | null;
    items?: { name: string; description?: string; costCode?: string; costType?: string; quantity: number; unitCost: number }[];
    paymentSchedules?: { name: string; amount: number; dueDate?: string | Date | null; order?: number }[];
};

export async function createChangeOrderDraft(input: ChangeOrderDraftInput) {
    const { projectId, estimateId, title, description } = input;
    const items = input.items ?? [];
    const pricingType = input.pricingType ?? "FIXED";
    const markupPercent = input.markupPercent ?? (pricingType === "COST_PLUS" ? 10 : null);
    if (!title?.trim()) return { ok: false as const, error: "title is required" };
    if (pricingType !== "FIXED" && pricingType !== "COST_PLUS") return { ok: false as const, error: "pricingType must be FIXED or COST_PLUS" };
    if (markupPercent !== null && (!Number.isFinite(markupPercent) || Number(markupPercent) < 0 || Number(markupPercent) > 1_000)) {
        return { ok: false as const, error: "markupPercent must be between 0 and 1000" };
    }
    if (!Array.isArray(items)) return { ok: false as const, error: "items must be an array" };
    if (pricingType === "FIXED" && items.length === 0) return { ok: false as const, error: "items must be a non-empty array for a fixed-price change order" };

    const estimate = await prisma.estimate.findFirst({
        where: { id: estimateId, projectId },
        select: { id: true },
    });
    if (!estimate) return { ok: false as const, error: `Estimate ${estimateId} not found on project ${projectId} — use list_project_billing to find the estimate.` };

    const costCodes = await prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true } });
    const codeMap = new Map(costCodes.map(c => [c.code, c.id]));
    const validTypes = ["Labor", "Material", "Allowance", "Subcontractor", "Equipment", "Other"];
    const warnings: string[] = [];

    // "Section" is refused outright rather than coerced like other unknown types below. A
    // typo is worth absorbing; a section header is not — it is the rolled-up total of other
    // lines, so quietly filing it as Material would smuggle a double-count past every guard
    // that looks for `type === "Section"`, with nothing downstream able to tell afterwards.
    const sectionTyped = items.filter(item => item.costType?.trim().toLowerCase() === "section");
    if (sectionTyped.length > 0) {
        return {
            ok: false as const,
            error: `Cost type "Section" is not a change-order line (${sectionTyped.map(i => `"${i.name}"`).join(", ")}). `
                + `A section header mirrors the total of the lines beneath it, so list those lines instead. `
                + `Use one of: ${validTypes.join(", ")}.`,
        };
    }

    // Integer-cents math end to end so float artifacts (e.g. 1.005) can't
    // mis-round a line: unit costs become integer cents, line totals stay in
    // cents, and dollars only reappear at persistence.
    let totalCents = 0;
    const rows = items.map((item, idx) => {
        if (item.costCode && !codeMap.has(item.costCode)) {
            warnings.push(`Unknown cost code "${item.costCode}" on item "${item.name}" — left uncoded.`);
        }
        if (item.costType && !validTypes.includes(item.costType)) {
            warnings.push(`Unknown cost type "${item.costType}" on item "${item.name}" — use one of: ${validTypes.join(", ")}.`);
        }
        const unitCents = Math.round(item.unitCost * 100);
        // toPrecision strips float dust before rounding so fractional quantities
        // land on the intended half-cent boundary (0.29 * 5000 = 14.499999999999998
        // must round as 14.5).
        const lineCents = Math.round(Number((item.quantity * unitCents).toPrecision(12)));
        totalCents += lineCents;
        return {
            id: randomUUID(),
            name: item.name,
            description: item.description || null,
            type: item.costType && validTypes.includes(item.costType) ? item.costType : "Material",
            quantity: item.quantity,
            unitCost: unitCents / 100,
            total: lineCents / 100,
            order: idx,
            costCodeId: item.costCode ? (codeMap.get(item.costCode) ?? null) : null,
        };
    });
    const totalAmount = totalCents / 100;

    const requestedSchedules = input.paymentSchedules ?? [];
    const scheduleTimeZone = await resolveCompanyTimeZone();
    if (pricingType === "COST_PLUS" && requestedSchedules.length > 0) {
        return { ok: false as const, error: "Cost-plus change orders cannot have a fixed payment schedule." };
    }
    if (pricingType === "FIXED" && requestedSchedules.length === 1) {
        return { ok: false as const, error: "A fixed-price payment schedule requires at least two payments." };
    }
    let scheduledCents = 0;
    let scheduleRows: Array<{ name: string; amount: number; dueDate: Date | null; order: number }>;
    try {
        scheduleRows = requestedSchedules.map((schedule, index) => {
            const requestedCents = Math.round(Number(schedule.amount) * 100);
            const isLast = index === requestedSchedules.length - 1;
            const amountCents = isLast ? totalCents - scheduledCents : requestedCents;
            if (!Number.isSafeInteger(requestedCents) || requestedCents <= 0 || amountCents <= 0) {
                throw new Error("Every scheduled payment must be positive and earlier payments must total less than the subtotal.");
            }
            scheduledCents += amountCents;
            const dueDate = dateInputInTimeZone(schedule.dueDate, scheduleTimeZone, `Due date for ${schedule.name || `Payment ${index + 1}`}`);
            return {
                name: schedule.name?.trim() || `Payment ${index + 1}`,
                amount: amountCents / 100,
                dueDate,
                order: schedule.order ?? index,
            };
        });
    } catch (error: any) {
        return { ok: false as const, error: error?.message || "Invalid payment schedule" };
    }

    const changeOrder = await prisma.$transaction(async tx => {
        const created = await tx.changeOrder.create({
            data: {
                projectId,
                estimateId,
                code: "CO-TEMP",
                title: title.trim(),
                description: description?.trim() || null,
                status: "Draft",
                pricingType,
                markupPercent,
                totalAmount,
                balanceDue: totalAmount,
                items: { create: rows },
                ...(scheduleRows.length ? { paymentSchedules: { create: scheduleRows } } : {}),
            },
        });
        return tx.changeOrder.update({
            where: { id: created.id },
            data: { code: `CO-${String(created.number).padStart(5, "0")}` },
        });
    });

    revalidatePath(`/projects/${projectId}/change-orders`);

    return {
        ok: true as const,
        changeOrderId: changeOrder.id,
        code: changeOrder.code,
        title: changeOrder.title,
        totalAmount,
        itemCount: rows.length,
        pricingType,
        markupPercent,
        paymentSchedules: scheduleRows,
        status: "Draft",
        url: `https://probuild.goldentouchremodeling.com/projects/${projectId}/change-orders`,
        warnings,
        note: "Draft only — review and send it to the customer from ProBuild.",
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice milestone rebalance / delete / split — session-free cores for the
// permission-gated actions in actions.ts (addInvoiceMilestone's siblings).
// ─────────────────────────────────────────────────────────────────────────────

export type RebalanceMilestoneRow = { scheduleId: string; name: string; amount: number; dueDate?: string | null };

/**
 * Re-price the Pending milestones on an invoice without changing the invoice
 * total — the "Edit amounts" flow. Every currently-Pending row must be present
 * in `rows` (the new amounts must sum to the same pending balance they replace);
 * `invoice.totalAmount`/`balanceDue` are never touched here.
 *
 * Rows that change while carrying a QuickBooks invoice have that QBO invoice
 * replaced post-commit, sequentially, on one shared token fetch: probe (refuse
 * if a not-yet-pulled payment exists), delete in QBO, then atomically unlink
 * (via `claimQBInvoiceUnlink`, shared with `breakQBInvoiceLink` — a concurrent
 * settle wins the claim) and re-stage at the new amount. The link is only ever
 * cleared AFTER the old QBO invoice is confirmed gone, so a QBO-side payment
 * can never be stranded behind a cleared link. Every failure mode degrades to
 * a per-row warning; the DB changes are never rolled back.
 */
export async function updatePendingMilestoneAmountsCore(
    invoiceId: string,
    rows: RebalanceMilestoneRow[],
    deadline?: RouteDeadline,
): Promise<{ success: true; warnings: string[] }> {
    if (!rows.length) throw new Error("At least one milestone row is required");
    // ONE budget: the preflight probes and the post-commit re-stage are two
    // loops of serial QBO calls in the same request.
    const qbDeadline = deadline ?? createRouteDeadline(BILLING_QBO_BUDGET_MS);

    const parsed = rows.map((r) => ({
        scheduleId: r.scheduleId,
        name: (r.name || "").trim(),
        amount: Math.round(Number(r.amount) * 100) / 100,
        dueDate: r.dueDate || null,
    }));
    for (const r of parsed) {
        if (!r.scheduleId) throw new Error("Missing milestone id");
        if (!r.name) throw new Error("Milestone name is required");
        if (!Number.isFinite(r.amount) || r.amount <= 0) {
            throw new Error(`"${r.name || r.scheduleId}": amount must be greater than zero`);
        }
    }
    const seenIds = new Set(parsed.map((r) => r.scheduleId));
    if (seenIds.size !== parsed.length) throw new Error("Duplicate milestone in the same request");

    // Content-change test shared by the QBO preflight below and the in-tx
    // collection: any of amount/name/dueDate differing means the staged QBO
    // invoice (if one exists) no longer matches and must be replaced.
    const contentChanged = (
        row: { amount: unknown; name: string; dueDate: Date | null },
        r: { name: string; amount: number; dueDate: string | null },
    ) =>
        Math.abs(toNum(row.amount) - r.amount) > 0.005 ||
        row.name !== r.name ||
        (row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null) !== (r.dueDate ? r.dueDate.slice(0, 10) : null);

    // PREFLIGHT (before any DB write): a QB-linked row may only be repriced if
    // its staged QBO invoice is reachable and payment-free RIGHT NOW. Committing
    // new amounts first and checking later leaves a window where a payment that
    // already landed in QBO (possibly hours before the poller's next pull)
    // settles the milestone at the NEW local amount while the client actually
    // paid the OLD one — a silent cash/records mismatch. Aborting here costs
    // nothing: no row has been touched yet. The post-commit loop re-probes
    // before the delete, so the residual race is only the seconds between this
    // check and the delete — and QBO refuses to delete a paid invoice even then.
    const preflightRows = await prisma.paymentSchedule.findMany({
        where: { invoiceId, id: { in: parsed.map((r) => r.scheduleId) }, qbInvoiceId: { not: null } },
    });
    const preflightChanged = preflightRows.filter((row) => contentChanged(row, parsed.find((p) => p.scheduleId === row.id)!));
    if (preflightChanged.length > 0) {
        const { getFreshQBTokens } = await import("./quickbooks-payments");
        const { probeQBInvoice } = await import("./quickbooks");
        let tokens;
        try {
            tokens = await getFreshQBTokens(qbDeadline);
        } catch (e) {
            throw new Error(
                `QuickBooks is unreachable (${e instanceof Error ? e.message : "unknown error"}) and this rebalance changes milestones with staged QuickBooks invoices. ` +
                `Nothing was changed — retry when QuickBooks is back, or use "Break QB Link" first.`
            );
        }
        for (const row of preflightChanged) {
            // The preflight is all-or-nothing anyway: running out of budget
            // part-way means the remaining rows were never verified, so it
            // aborts rather than committing on a partial check.
            if (isBudgetExhausted(qbDeadline)) {
                throw new Error(
                    `Ran out of time verifying the staged QuickBooks invoices for this rebalance — nothing was changed. Try again in a moment.`
                );
            }
            const probe = await probeQBInvoice(tokens, row.qbInvoiceId!, qbDeadline);
            if (probe.state === "error") {
                throw new Error(`Couldn't verify "${row.name}"'s staged QuickBooks invoice — nothing was changed. Retry in a moment.`);
            }
            if (probe.state === "ok" && (probe.paymentTxnIds.length > 0 || Math.abs(probe.balance - probe.total) > 0.005)) {
                throw new Error(
                    `A payment already exists on "${row.name}"'s QuickBooks invoice that ProBuild hasn't pulled yet. ` +
                    `Nothing was changed — run "Refresh QB payments" first, then rebalance.`
                );
            }
        }
    }

    type QBAffected = { scheduleId: string; name: string; oldQbInvoiceId: string };

    const qbAffected = await withTxRetry(() => prisma.$transaction(async (tx) => {
        // Canonical lock order: Estimate → Invoice → schedules. The mirror sync
        // below writes estimate-side rows, so read the estimate link (non-locking)
        // and lock the Estimate before the Invoice — same pattern as unrecordPayment.
        const invLink = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(tx, { estimateId: invLink?.estimateId, invoiceId });

        const existing = await tx.paymentSchedule.findMany({ where: { invoiceId } });
        const existingMap = new Map(existing.map((s) => [s.id, s]));

        for (const r of parsed) {
            const row = existingMap.get(r.scheduleId);
            if (!row) throw new Error(`Milestone not found: ${r.scheduleId}`);
            if (row.status !== "Pending") throw new Error(`"${row.name}" is not Pending — only pending milestones can be rebalanced`);
            if (row.stripeSessionId || row.stripePaymentIntentId) {
                throw new Error(`A payment is in progress on "${row.name}". Wait for it to finish or void it before rebalancing.`);
            }
            // A parked row has no qbInvoiceId, so the QB preflight above never
            // saw it — but an invoice for the OLD amount may be sitting in
            // QuickBooks. Repricing it would leave the client paying one number
            // while ProBuild settles another. Rebalances that leave this row's
            // content alone are still fine.
            if (isBlockedByAmbiguousCreate(row) && contentChanged(row, r)) {
                throw new QBResolveRequiredError(row.name);
            }
        }

        // Every currently-Pending row must be accounted for — a partial submission
        // can't total-preserve since the rows left out would be silently excluded
        // from both sides of the comparison below.
        const pendingRows = existing.filter((s) => s.status === "Pending");
        if (pendingRows.length !== parsed.length || !pendingRows.every((s) => seenIds.has(s.id))) {
            throw new Error("All pending milestones must be included in the rebalance");
        }

        const currentPendingTotal = Math.round(pendingRows.reduce((sum, s) => sum + toNum(s.amount), 0) * 100) / 100;
        const newTotal = Math.round(parsed.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
        if (Math.abs(newTotal - currentPendingTotal) > 0.005) {
            throw new Error(
                `New amounts total ${formatCurrency(newTotal)}, but the pending balance is ${formatCurrency(currentPendingTotal)}. ` +
                `Rebalancing can't change the invoice total — use "Add extra charge" or a change order for that.`
            );
        }

        // Total-preserving PER POOL, not just invoice-wide: estimate-mirrored rows
        // and invoice-only extras must each keep their own sum. A single invoice
        // total check would let money slide between the pools — the per-row mirror
        // below would then desync the estimate-side schedule from the estimate
        // total (e.g. the invoice reads paid while the estimate still shows a
        // balance due).
        const sumCents = (vals: number[]) => Math.round(vals.reduce((s, v) => s + v, 0) * 100) / 100;
        const currentMirrored = sumCents(pendingRows.filter((s) => s.sourceScheduleId).map((s) => toNum(s.amount)));
        const newMirrored = sumCents(parsed.filter((r) => existingMap.get(r.scheduleId)!.sourceScheduleId).map((r) => r.amount));
        if (Math.abs(newMirrored - currentMirrored) > 0.005) {
            throw new Error(
                `New amounts move money between estimate-linked milestones and extra charges. ` +
                `Estimate-linked milestones must still total ${formatCurrency(currentMirrored)} ` +
                `(entered: ${formatCurrency(newMirrored)}) so the estimate's payment schedule stays in sync.`
            );
        }

        const affected: QBAffected[] = [];
        for (const r of parsed) {
            const row = existingMap.get(r.scheduleId)!;

            // A QB-linked row whose content changes needs its staged QBO invoice
            // replaced (QBO invoices are create-only here — no update path). The
            // preflight above already verified these invoices are reachable and
            // payment-free. The link is deliberately KEPT through this transaction:
            // unlinking happens post-commit only AFTER the old QBO invoice is
            // confirmed still payment-free and actually deleted, so a payment that
            // landed in QBO can never be orphaned behind a cleared link.
            if (row.qbInvoiceId && contentChanged(row, r)) {
                affected.push({ scheduleId: row.id, name: r.name, oldQbInvoiceId: row.qbInvoiceId });
            }

            await tx.paymentSchedule.update({
                where: { id: r.scheduleId },
                data: {
                    name: r.name,
                    amount: r.amount,
                    dueDate: r.dueDate ? new Date(r.dueDate) : null,
                },
            });

            // Mirror onto the linked estimate-side row (unpaid only). The new amount
            // is no longer necessarily the same share of the estimate total, so clear
            // `percentage` rather than guess one — consistent with saveEstimate's
            // differential upsert, which nulls `percentage` whenever the incoming
            // payload doesn't carry one for the row's new amount.
            if (row.sourceScheduleId) {
                await tx.estimatePaymentSchedule.updateMany({
                    where: { id: row.sourceScheduleId, status: { not: "Paid" } },
                    data: {
                        name: r.name,
                        amount: r.amount,
                        dueDate: r.dueDate ? new Date(r.dueDate) : null,
                        percentage: null,
                    },
                });
            }
        }
        return affected;
    }));

    // Post-commit QBO resync: one shared token fetch, sequential per affected row.
    // Order per row is deliberate — probe, refuse if paid, delete in QBO, and only
    // THEN unlink locally (atomic claim) and re-stage. Unlinking last means a QBO
    // payment the poller hasn't pulled yet can never be stranded behind a cleared
    // link: until the old invoice is confirmed gone, the row keeps pointing at it
    // and the payment poller keeps watching it.
    const warnings: string[] = [];
    if (qbAffected.length > 0) {
        try {
            const { getFreshQBTokens, pushMilestoneToQuickBooks, claimQBInvoiceUnlink } = await import("./quickbooks-payments");
            const { deleteQBInvoice, probeQBInvoice } = await import("./quickbooks");
            const tokens = await getFreshQBTokens(qbDeadline);
            let qboWall: unknown = null;
            for (const row of qbAffected) {
                if (qboWall) {
                    warnings.push(`"${row.name}": ${outageNote(qboWall)} Its QuickBooks invoice still shows the old details — re-stage it via "QuickBooks Link".`);
                    continue;
                }
                if (isBudgetExhausted(qbDeadline)) {
                    warnings.push(`"${row.name}": ran out of time before replacing its QuickBooks invoice — it still shows the old details. Re-stage it via "QuickBooks Link".`);
                    continue;
                }
                try {
                    const probe = await probeQBInvoice(tokens, row.oldQbInvoiceId, qbDeadline);
                    if (probe.state === "error") {
                        warnings.push(`"${row.name}": couldn't reach QuickBooks to replace the staged invoice — it still shows the old details. Retry, or use "Break QB Link" and re-stage.`);
                        continue;
                    }
                    if (probe.state === "ok" && (probe.paymentTxnIds.length > 0 || Math.abs(probe.balance - probe.total) > 0.005)) {
                        // A payment landed on the old QBO invoice in the seconds since
                        // the preflight passed. Do NOT delete or unlink — leave the link
                        // so the poller settles it — but the local amount has already
                        // changed, so tell the user to reconcile this milestone now.
                        warnings.push(`"${row.name}": a payment just landed on its old QuickBooks invoice, but the milestone amount here already changed — run "Refresh QB payments" and reconcile this milestone before sending anything.`);
                        continue;
                    }
                    const alreadyGone = probe.state === "voided" || probe.state === "notFound";
                    if (!alreadyGone && !(await deleteQBInvoice(tokens, row.oldQbInvoiceId, qbDeadline))) {
                        warnings.push(`"${row.name}": couldn't delete the old QuickBooks invoice — it still shows the old details. Retry, or use "Break QB Link" and re-stage.`);
                        continue;
                    }
                    // Old QBO invoice is confirmed gone — now clear the link, atomically
                    // (a concurrent settle still wins the claim and we stop here).
                    if (!(await claimQBInvoiceUnlink(prisma, row.scheduleId, row.oldQbInvoiceId))) {
                        warnings.push(`"${row.name}": milestone changed while replacing its QuickBooks invoice — refresh and review before re-staging.`);
                        continue;
                    }
                    await pushMilestoneToQuickBooks(row.scheduleId, tokens, qbDeadline);
                } catch (e) {
                    warnings.push(`"${row.name}": QuickBooks re-stage failed (${e instanceof Error ? e.message : "unknown error"}) — re-stage it via "QuickBooks Link".`);
                    // Shared wall: the remaining rows get the same warning
                    // without spending another full deadline each.
                    if (isSharedQboWall(e)) qboWall = e;
                }
            }
        } catch (e) {
            // Token fetch itself failed (QB not connected/unreachable). Nothing was
            // unlinked — every affected row still points at its old QBO invoice,
            // which now shows outdated details. Warn once per row.
            const reason = e instanceof Error ? e.message : "QuickBooks unavailable";
            for (const row of qbAffected) {
                warnings.push(`"${row.name}": QuickBooks unavailable (${reason}) — its staged QuickBooks invoice still shows the old details. Use "Break QB Link" and re-stage once QuickBooks is back.`);
            }
        }
    }

    return { success: true, warnings };
}

/**
 * Delete a Pending, non-mirrored, non-QB-linked "extra charge" milestone —
 * the exact inverse of `addInvoiceMilestone`. QB-linked rows must go through
 * Break QB Link first (this is DB-only, no QBO call).
 */
export async function deleteInvoiceMilestoneCore(
    scheduleId: string,
): Promise<{ success: true; projectId: string; invoiceId: string }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        const row = await tx.paymentSchedule.findUnique({ where: { id: scheduleId } });
        if (!row) throw new Error("Milestone not found");

        await lockMoneyParents(tx, { invoiceId: row.invoiceId });

        // Re-read under the invoice lock — a concurrent write between the first
        // read and the lock could have changed status/links.
        const locked = await tx.paymentSchedule.findUnique({ where: { id: scheduleId } });
        if (!locked) throw new Error("Milestone not found");
        if (locked.status !== "Pending") throw new Error("Only pending milestones can be deleted");
        if (locked.sourceScheduleId) {
            throw new Error("This milestone is linked to the estimate — remove it from the estimate's payment schedule instead");
        }
        if (locked.qbInvoiceId) {
            throw new Error(`This milestone has a QuickBooks invoice staged — break the QuickBooks link first, then delete.`);
        }
        // A parked milestone has NO qbInvoiceId and may still have a real,
        // collectible invoice in QuickBooks. Deleting it here would abandon that
        // invoice with nothing in ProBuild pointing at it.
        if (isQboInvoiceLinkedOrPending(locked)) {
            throw new QBResolveRequiredError(locked.name);
        }
        if (locked.stripeSessionId || locked.stripePaymentIntentId) {
            throw new Error("A payment is in progress on this milestone — wait for it to finish or void it before deleting");
        }

        // Re-assert every deletable-state predicate checked above IN the delete
        // itself, not just at the read. The milestone-rail's in-flight claim
        // (pushMilestoneToQuickBooksCore in quickbooks-payments.ts) writes its
        // `qbSyncError` CAS with a bare `updateMany` outside this transaction —
        // `lockMoneyParents` above does not serialize against it. A push that
        // lands its claim in the gap between the read and the delete would
        // otherwise get an unconditional delete-by-id anyway, wiping the row
        // (and its in-flight claim) out from under a create that may already be
        // landing at QuickBooks, leaving a real invoice with nothing in
        // ProBuild pointing at it. `deleteMany` with the same predicates makes
        // this a CAS: it deletes only if nothing changed since the read.
        const deleted = await tx.paymentSchedule.deleteMany({
            where: {
                id: scheduleId,
                status: "Pending",
                sourceScheduleId: null,
                qbInvoiceId: null,
                qbSyncError: null,
                stripeSessionId: null,
                stripePaymentIntentId: null,
            },
        });
        if (deleted.count !== 1) {
            throw new Error("This milestone changed while being deleted — refresh and try again.");
        }

        const invoice = await tx.invoice.findUnique({ where: { id: locked.invoiceId } });
        if (!invoice) throw new Error("Invoice not found");

        const amount = toNum(locked.amount);
        const newTotal = Math.round((toNum(invoice.totalAmount) - amount) * 100) / 100;
        const newBalance = Math.max(0, Math.round((toNum(invoice.balanceDue) - amount) * 100) / 100);
        // Inverse of addInvoiceMilestone's ladder: a pure decrement can only ever
        // free up balance. "Paid" requires actual money received — a zero balance
        // reached by deleting the only pending row on an invoice with no payments
        // (e.g. a Draft whose sole extra is removed) keeps its current status
        // rather than reading as settled.
        const paidAmount = Math.round((toNum(invoice.totalAmount) - toNum(invoice.balanceDue)) * 100) / 100;
        const nextStatus =
            newBalance <= 0 ? (paidAmount > 0.005 ? "Paid" : invoice.status)
            : invoice.status === "Paid" ? "Partially Paid"
            : invoice.status;

        await tx.invoice.update({
            where: { id: invoice.id },
            data: {
                totalAmount: newTotal,
                balanceDue: newBalance,
                ...(nextStatus !== invoice.status ? { status: nextStatus } : {}),
            },
        });

        return { success: true as const, projectId: invoice.projectId, invoiceId: invoice.id };
    }));
}

/**
 * Replace every non-Paid milestone on an invoice with a fresh set — the
 * "Split payments" flow. Moved from actions.ts verbatim except the arithmetic
 * fix below; behavior for the caller is unchanged.
 *
 * KNOWN LIMITATION: this deletes and recreates every non-Paid row, so any
 * `sourceScheduleId` link to an estimate-side mirror is dropped — the new rows
 * are unlinked extras. `updatePendingMilestoneAmountsCore` (re-price in place)
 * is the correct tool when the mirror link must survive.
 */
// Frozen CO billing (ChangeOrderBilling / sourceChangeOrderId / sourceCoScheduleId links)
// must never be orphaned by invoice-level destructive operations. Callers hold the invoice lock.
export async function assertInvoiceHasNoChangeOrderBilling(
    tx: Prisma.TransactionClient,
    invoiceId: string,
    operation: "delete" | "re-split",
) {
    const schedule = await tx.paymentSchedule.findFirst({
        where: {
            invoiceId,
            OR: [
                { sourceChangeOrderId: { not: null } },
                { sourceCoScheduleId: { not: null } },
                { coBilling: { isNot: null } },
            ],
        },
        select: { id: true },
    });
    if (schedule) {
        throw new Error("Cannot " + operation + " an invoice with change-order billing. Void/rebill the change-order billing before trying again.");
    }
}

export async function splitInvoiceMilestonesCore(
    invoiceId: string,
    milestones: { name: string; amount: number; dueDate?: string | null }[],
): Promise<string> {
    if (!milestones.length) throw new Error("At least one milestone is required");

    const validated = milestones.map((m, i) => {
        const name = (m.name || "").trim();
        const amount = Math.round(Number(m.amount) * 100) / 100;
        if (!name) throw new Error(`Milestone ${i + 1}: name is required`);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Milestone ${i + 1}: amount must be greater than zero`);
        return { name, amount, dueDate: m.dueDate || null };
    });

    const newTotal = Math.round(validated.reduce((s, m) => s + m.amount, 0) * 100) / 100;

    // Interactive tx, invoice locked FIRST (canonical Estimate → Invoice order; this flow touches
    // only the invoice). The paid portion is re-read from the LOCKED invoice, so a concurrent
    // settle on a surviving Paid milestone can't leave paidAmount stale and get its balance
    // overwritten. Arithmetic is otherwise unchanged from the original array-form transaction.
    const projectId = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { invoiceId });
        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (!invoice) throw new Error("Invoice not found");

        // Refuse to re-split while a payment is in flight on a non-Paid milestone. The delete
        // below drops every non-Paid schedule; if one has an open Stripe checkout or a sent
        // QuickBooks invoice, a settlement landing afterward would find no row to claim and the
        // customer would be charged with nothing to reconcile against. Checked under the invoice
        // lock so a checkout/QB-send starting concurrently can't slip in after this guard.
        const inFlight = await tx.paymentSchedule.findFirst({
            where: {
                invoiceId,
                status: { not: "Paid" },
                OR: [
                    { stripeSessionId: { not: null } },
                    { stripePaymentIntentId: { not: null } },
                    { qbInvoiceId: { not: null } },
                    // A create whose outcome is unknown counts as in flight: the
                    // id is null but a collectible invoice may exist, and the
                    // re-split below drops the row that would settle it. Prefix
                    // matched, because a marker carries a per-issuance identity.
                    ...pendingCreateMarkerWhere(),
                ],
            },
            select: { name: true },
        });
        if (inFlight) {
            throw new Error(
                `A payment is in progress on this invoice (milestone "${inFlight.name}"). Wait for it to finish or void it before re-splitting the milestones.`,
            );
        }

        await assertInvoiceHasNoChangeOrderBilling(tx, invoiceId, "re-split");

        // Recalculate: the paid portion survives untouched, and only the pending
        // portion is replaced. totalAmount must keep counting the surviving paid
        // rows (paidAmount + newTotal) — a prior version dropped paidAmount from
        // totalAmount here, undercounting the invoice whenever the split ran on a
        // partially-paid invoice. balanceDue is exactly the fresh pending total.
        const paidAmount = Math.round(
            (Number(invoice.totalAmount) - Number(invoice.balanceDue)) * 100,
        ) / 100;
        const newInvoiceTotal = Math.round((paidAmount + newTotal) * 100) / 100;
        const newBalance = newTotal; // validated milestones are all > 0, so this is always positive
        const newStatus =
            invoice.status === "Draft" ? "Draft"
            : invoice.status === "Overdue" ? "Overdue"
            : paidAmount > 0 ? "Partially Paid"
            : "Issued";

        await tx.paymentSchedule.deleteMany({ where: { invoiceId, status: { not: "Paid" } } });
        // NOTE: this drops sourceScheduleId links on any replaced row — see the
        // KNOWN LIMITATION above. Rebalancing amounts in place (without touching
        // links) should go through updatePendingMilestoneAmountsCore instead.
        await tx.paymentSchedule.createMany({
            data: validated.map((m) => ({
                invoiceId,
                name: m.name,
                amount: m.amount,
                status: "Pending",
                dueDate: m.dueDate ? new Date(m.dueDate) : null,
            })),
        });
        await tx.invoice.update({
            where: { id: invoiceId },
            data: { totalAmount: newInvoiceTotal, balanceDue: newBalance, status: newStatus },
        });
        return invoice.projectId;
    }));

    return projectId;
}
