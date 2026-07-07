import { revalidatePath as nextRevalidatePath } from "next/cache";
import { randomUUID } from "crypto";

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
import { sendNotification } from "./email";
import { formatCurrency } from "./utils";

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

async function logActivityLazy(entry: Parameters<typeof import("./actions").logActivity>[0]) {
    const { logActivity } = await import("./actions");
    return logActivity(entry);
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
    await sendNotification(
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
export async function resendInvoiceCore(invoiceId: string, overrideEmail?: string) {
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
            const tokens = await getFreshQBTokens();
            for (const m of qbMilestones) {
                try {
                    // pushMilestoneToQuickBooks repairs voided/notFound state but reuses a
                    // stored link when one exists — fetch the CURRENT link from QBO so a
                    // stale stored value can't be handed back as "refreshed".
                    const res = await pushMilestoneToQuickBooks(m.id, tokens);
                    let payLink = res.payLink || undefined;
                    if (res.qbInvoiceId) {
                        const liveLink = await getQBInvoicePaymentLink(tokens, res.qbInvoiceId);
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
// Milestone send via QuickBooks. Moved verbatim from actions.ts; the actor's
// display name is a parameter instead of coming from the session.
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
        const { sendQBInvoice, getQBInvoiceStatus } = await import("./quickbooks");

        let tokens;
        try {
            tokens = await getFreshQBTokens();
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

        for (const schedule of selectedPayments) {
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
                    const status = await getQBInvoiceStatus(tokens, qbInvoiceId);
                    qbTotal = status?.total;
                } else {
                    const pushRes = await pushMilestoneToQuickBooks(schedule.id, tokens);
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

                // Send QBO invoice
                const sendRes = await sendQBInvoice(tokens, qbInvoiceId, recipient);
                if (!sendRes.ok) {
                    failedCount++;
                    results.push({ id: schedule.id, name: schedule.name, status: "failed", error: sendRes.error || "QuickBooks send failed" });
                    continue;
                }

                // Success -> update sent status
                await prisma.paymentSchedule.update({
                    where: { id: schedule.id },
                    data: { qbInvoiceSentAt: new Date() },
                });

                sentCount++;
                results.push({ id: schedule.id, name: schedule.name, status: wasReconciled ? "reconciled" : "sent", sentTo: recipient });

                // Log activity per sent milestone
                if (invoice.projectId) {
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
                }
            } catch (err: any) {
                failedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "failed", error: err?.message || "Unexpected error during send" });
            }
        }

        // If >= 1 successfully sent and invoice is Draft, flip to Issued
        if (sentCount > 0 && invoice.status === "Draft") {
            await prisma.invoice.update({
                where: { id: invoiceId },
                data: { status: "Issued", issueDate: new Date() },
            });
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
// Field change orders: DRAFT only. Sending/approval stays a human step in ProBuild.
// ─────────────────────────────────────────────────────────────────────────────

export type ChangeOrderDraftInput = {
    projectId: string;
    estimateId: string;
    title: string;
    description?: string;
    items: { name: string; description?: string; costCode?: string; costType?: string; quantity: number; unitCost: number }[];
};

export async function createChangeOrderDraft(input: ChangeOrderDraftInput) {
    const { projectId, estimateId, title, description, items } = input;
    if (!title?.trim()) return { ok: false as const, error: "title is required" };
    if (!Array.isArray(items) || items.length === 0) return { ok: false as const, error: "items must be a non-empty array" };

    const estimate = await prisma.estimate.findFirst({
        where: { id: estimateId, projectId },
        select: { id: true },
    });
    if (!estimate) return { ok: false as const, error: `Estimate ${estimateId} not found on project ${projectId} — use list_project_billing to find the estimate.` };

    const costCodes = await prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true } });
    const codeMap = new Map(costCodes.map(c => [c.code, c.id]));
    const validTypes = ["Labor", "Material", "Allowance", "Subcontractor", "Equipment", "Other"];
    const warnings: string[] = [];

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

    const changeOrder = await prisma.$transaction(async tx => {
        const created = await tx.changeOrder.create({
            data: {
                projectId,
                estimateId,
                code: "CO-TEMP",
                title: title.trim(),
                description: description?.trim() || null,
                status: "Draft",
                totalAmount,
                balanceDue: totalAmount,
                items: { create: rows },
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
        status: "Draft",
        url: `https://probuild.goldentouchremodeling.com/projects/${projectId}/change-orders`,
        warnings,
        note: "Draft only — review and send it to the customer from ProBuild.",
    };
}
