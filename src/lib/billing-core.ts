import { revalidatePath as nextRevalidatePath } from "next/cache";
import { createHash, randomUUID } from "crypto";
import { Prisma } from "@prisma/client";

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
    CLIENT_DOC_COPY_EMAIL,
    buildFrozenNotification,
    sendFrozenNotification as defaultSendFrozenNotification,
    sendNotification,
    type FrozenNotification,
} from "./email";
import { formatCurrency } from "./utils";
import {
    allocateCoScheduleGross,
    billableCoItems,
    canonicalCoTaxTerms,
    coLineCents,
    coSectionRowError,
    coSectionRowNames,
    coTaxFingerprint,
    coTaxLabel,
    coTaxRate,
    effectiveCoTaxInfo,
    fixedCoScheduleValidationError,
} from "./co-tax";
import { isManualCoApproval, staffNameFromManualApprovedBy } from "./co-approval";
import { deriveInvoiceTaxFields, toNum } from "./prisma-helpers";
import { dateInputInTimeZone, endOfDateInTimeZone, resolveCompanyTimeZone } from "./company-timezone";
import {
    canonicalChangeOrderRecipients,
    type ChangeOrderRecipientSet,
} from "./change-order-send-preview";
import { canRetryProviderAttempt, drainChangeOrderAutomationJobs } from "./change-order-automation";
import {
    enqueueReviewEmailAutomationJob,
    prepareChangeOrderReviewJobsForMutation,
    ChangeOrderReviewDeliveryUnresolvedError,
} from "./change-order-automation-jobs";
import {
    executeReviewEmailAutomationJob,
    newChangeOrderReviewGeneration,
    reviewEmailSettingsExpectation,
} from "./change-order-review-automation";

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

export type MilestoneRecipientSet = {
    to: string[];
    cc: string[];
};

/** Provider-visible recipient set shared by MCP preview, CAS, and delivery. */
export function canonicalMilestoneRecipients(
    primaryEmail: string | null | undefined,
    additionalEmail: string | null | undefined,
): MilestoneRecipientSet {
    const primary = (primaryEmail ?? "").trim().toLowerCase();
    const additional = (additionalEmail ?? "").trim().toLowerCase();
    return {
        to: primary ? [primary] : [],
        cc: additional && additional !== primary ? [additional] : [],
    };
}

export function milestoneRecipientConflictError(input: {
    expected?: MilestoneRecipientSet;
    current: MilestoneRecipientSet;
}): string | null {
    if (!input.expected) return null;
    return JSON.stringify(input.expected) === JSON.stringify(input.current)
        ? null
        : "Payment-request recipients changed after the preview; review the fresh To/CC list before sending.";
}

export type CompleteEmailRecipientSet = MilestoneRecipientSet & {
    bcc: string[];
    /** Exact normalized provider envelope sender derived from companyName. */
    from: string;
    /** Exact normalized provider Reply-To derived from CompanySettings.email. */
    replyTo: string;
};

/**
 * Canonical provider-visible routing/settings envelope. Destination
 * ordering/casing do not create drift; sender headers retain the exact value
 * that buildFrozenNotification will give the provider.
 */
export function completeFrozenRecipientSet(input: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    /** A previously frozen provider envelope sender. */
    from?: string;
    /** Live CompanySettings.companyName used to derive the provider sender. */
    fromName?: string;
    replyTo?: string;
}): CompleteEmailRecipientSet {
    const normalized = buildFrozenNotification({
        to: input.to ?? [],
        cc: input.cc,
        bcc: input.bcc,
        fromName: input.fromName,
        replyTo: input.replyTo,
        subject: "recipient-fence",
        html: "recipient-fence",
    });
    const canonical = (values: string[] | undefined) => (values ?? [])
        .map(value => value.trim().toLowerCase())
        .filter(Boolean)
        .sort();
    return {
        to: canonical(normalized.to),
        cc: canonical(normalized.cc),
        bcc: canonical(normalized.bcc),
        from: input.from?.replace(/[\r\n]+/g, " ").trim() || normalized.from,
        replyTo: normalized.replyTo,
    };
}

export function completeFrozenRecipientConflictError(input: {
    expected: Pick<FrozenNotification, "to" | "cc" | "bcc" | "from" | "replyTo">;
    current: CompleteEmailRecipientSet;
}): string | null {
    return JSON.stringify(completeFrozenRecipientSet(input.expected)) === JSON.stringify(input.current)
        ? null
        : "Invoice email recipients or internal notification copies changed, or reply-to/sender settings changed before provider delivery; review the fresh provider-visible email settings before sending.";
}

function internalNotificationCopies(notificationEmail: string | null | undefined): string[] {
    return (notificationEmail?.trim() || CLIENT_DOC_COPY_EMAIL)
        .split(",")
        .map(email => email.trim())
        .filter(Boolean);
}

/**
 * Final first-provider recipient read. Callers already hold canonical money
 * parents; the complete lock order is Estimate -> Invoice -> Client ->
 * CompanySettings. FOR SHARE makes ordinary Client/settings UPDATEs wait until
 * providerStarted commits, closing the read/checkpoint TOCTOU without changing
 * byte-identical recovery: callers skip this helper once providerStarted exists.
 */
export async function lockInvoiceDeliveryRecipientSet(
    tx: Pick<Prisma.TransactionClient, "$queryRaw">,
    input: { clientId: string; overrideEmail?: string | null },
): Promise<{ visible: MilestoneRecipientSet; complete: CompleteEmailRecipientSet }> {
    const clients = await tx.$queryRaw<Array<{
        id: string;
        email: string | null;
        additionalEmail: string | null;
    }>>`
        SELECT "id", "email", "additionalEmail"
        FROM "Client"
        WHERE "id" = ${input.clientId}
        FOR SHARE
    `;
    const client = clients[0];
    if (!client) throw new Error("Invoice client not found");
    const settings = await tx.$queryRaw<Array<{
        notificationEmail: string | null;
        email: string | null;
        companyName: string | null;
    }>>`
        SELECT "notificationEmail", "email", "companyName"
        FROM "CompanySettings"
        WHERE "id" = 'singleton'
        FOR SHARE
    `;
    const visible = canonicalMilestoneRecipients(
        input.overrideEmail || client.email,
        client.additionalEmail,
    );
    return {
        visible,
        complete: completeFrozenRecipientSet({
            to: visible.to,
            cc: visible.cc,
            bcc: internalNotificationCopies(settings[0]?.notificationEmail),
            fromName: settings[0]?.companyName || "Your Contractor",
            replyTo: settings[0]?.email || undefined,
        }),
    };
}

export function buildMilestoneSendPreviewPayload(input: {
    invoiceId: string;
    ids: string[];
    recipients: MilestoneRecipientSet;
    amounts: Array<[string, number]>;
    sentAt: Array<[string, string | null]>;
    milestones: Array<[string, string, number, string, string | null]>;
    reconcile: Array<[string, number]>;
    allowResend: boolean;
}): string {
    return JSON.stringify(input);
}

export function milestoneSendFinancialFingerprint(input: {
    invoiceId: string;
    milestones: Array<[string, string, number, string, string | null]>;
}): string {
    return JSON.stringify({
        invoiceId: input.invoiceId,
        milestones: [...input.milestones].sort((a, b) => a[0].localeCompare(b[0])),
    });
}

export function milestoneFinancialConflictError(input: {
    expected?: string;
    invoiceId: string;
    milestones: Array<[string, string, number, string, string | null]>;
}): string | null {
    if (!input.expected) return null;
    return input.expected === milestoneSendFinancialFingerprint({
        invoiceId: input.invoiceId,
        milestones: input.milestones,
    })
        ? null
        : "Payment-request milestones changed after the preview; review the fresh names, amounts, statuses, and prior-send markers before sending.";
}

export type InvoiceSendFinancialState = {
    invoiceId: string;
    code: string;
    status: string;
    totalAmount: number;
    balanceDue: number;
    payments: Array<{
        id: string;
        name: string;
        amount: number;
        status: string;
        dueDate: string | null;
        qbInvoiceSentAt: string | null;
    }>;
};

/**
 * Stable money/request-state CAS for a whole-invoice email. QBO link metadata is
 * deliberately excluded because resend refreshes it; everything that changes
 * what the customer is being asked to pay remains bound to the confirmation.
 */
export function invoiceSendFinancialFingerprint(input: InvoiceSendFinancialState): string {
    return JSON.stringify({
        invoiceId: input.invoiceId,
        code: input.code,
        status: input.status,
        totalAmount: input.totalAmount,
        balanceDue: input.balanceDue,
        payments: [...input.payments].sort((a, b) => a.id.localeCompare(b.id)),
    });
}

export function buildInvoiceResendPreviewPayload(input: {
    invoiceId: string;
    recipients: MilestoneRecipientSet;
    invoice: {
        code: string;
        status: string;
        total: number;
        balanceDue: number;
        sentAt: string | null;
    };
    milestones: Array<{
        id: string;
        name: string;
        amount: number;
        status: string;
        qbInvoiceId: string | null;
        qbInvoiceSentAt: string | null;
        qbSyncError: string | null;
    }>;
}): string {
    return JSON.stringify({
        ...input,
        milestones: [...input.milestones].sort((a, b) => a.id.localeCompare(b.id)),
    });
}

export type InvoiceSendExpectation = {
    expectedRecipients?: MilestoneRecipientSet;
    expectedFinancialFingerprint?: string;
};

type InvoiceEmailAttemptPayload = {
    dispatch: FrozenNotification;
    recipients: MilestoneRecipientSet;
    financialFingerprint: string;
};

function parseInvoiceEmailAttemptPayload(value: unknown): InvoiceEmailAttemptPayload | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const dispatch = record.dispatch;
    const recipients = record.recipients;
    if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)
        || !recipients || typeof recipients !== "object" || Array.isArray(recipients)
        || typeof record.financialFingerprint !== "string") return null;
    const frozen = dispatch as Record<string, unknown>;
    const recipientSet = recipients as Record<string, unknown>;
    const stringArray = (candidate: unknown): candidate is string[] => (
        Array.isArray(candidate) && candidate.every(item => typeof item === "string" && item.trim().length > 0)
    );
    if (typeof frozen.from !== "string" || !stringArray(frozen.to)
        || typeof frozen.replyTo !== "string" || typeof frozen.subject !== "string"
        || typeof frozen.html !== "string" || typeof frozen.text !== "string"
        || (frozen.cc !== undefined && !stringArray(frozen.cc))
        || (frozen.bcc !== undefined && !stringArray(frozen.bcc))
        || !stringArray(recipientSet.to) || !Array.isArray(recipientSet.cc)
        || recipientSet.cc.some(item => typeof item !== "string" || !item.trim())) return null;
    return {
        dispatch: frozen as unknown as FrozenNotification,
        recipients: {
            to: recipientSet.to,
            cc: recipientSet.cc as string[],
        },
        financialFingerprint: record.financialFingerprint,
    };
}

export type MilestoneAttemptState = {
    id: string;
    name: string;
    amount: number;
    status: string;
    qbInvoiceSentAt: string | null;
    qbInvoiceId: string;
    qbInvoiceLink: string | null;
    qbSyncError: string | null;
};

export function milestoneDeliveryFingerprint(invoiceId: string, milestones: MilestoneAttemptState[]): string {
    return JSON.stringify({
        invoiceId,
        milestones: [...milestones].sort((a, b) => a.id.localeCompare(b.id)),
    });
}

export function milestoneDeliveryStateConflictError(input: {
    expectedFingerprint: string;
    invoiceId: string;
    current: MilestoneAttemptState[];
}): string | null {
    return milestoneDeliveryFingerprint(input.invoiceId, input.current) === input.expectedFingerprint
        ? null
        : "Payment-request milestone money, status, or QuickBooks identity changed after the frozen checkpoint; review it again.";
}

export function manualMilestoneAttemptAdoptionError(input: {
    requestedIds: readonly string[];
    requestedRecipients: MilestoneRecipientSet;
    frozenIds: readonly string[];
    frozenRecipients: MilestoneRecipientSet;
    providerStarted: boolean;
}): string | null {
    const requested = [...new Set(input.requestedIds)].sort();
    const frozen = [...new Set(input.frozenIds)].sort();
    if (requested.length !== frozen.length || requested.some((id, index) => id !== frozen[index])) {
        return "A different frozen milestone request already owns this invoice; reconcile that exact attempt before sending another set.";
    }
    if (!input.providerStarted && milestoneRecipientConflictError({
        expected: input.frozenRecipients,
        current: input.requestedRecipients,
    })) {
        return "Payment-request recipients changed before the provider attempt; review the fresh To/CC list before sending.";
    }
    return null;
}

type MilestoneInvoiceEmailAttemptPayload = InvoiceEmailAttemptPayload & {
    overrideEmail: string | null;
    milestoneIds: string[];
    milestones: MilestoneAttemptState[];
    resultMilestones: Array<{ id: string; name: string; wasReconciled: boolean }>;
};

function parseMilestoneInvoiceEmailAttemptPayload(value: unknown): MilestoneInvoiceEmailAttemptPayload | null {
    const base = parseInvoiceEmailAttemptPayload(value);
    if (!base || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if ((record.overrideEmail !== null && typeof record.overrideEmail !== "string")
        || !Array.isArray(record.milestoneIds)
        || record.milestoneIds.length === 0
        || record.milestoneIds.some(id => typeof id !== "string" || !id.trim())
        || !Array.isArray(record.milestones)
        || record.milestones.length !== record.milestoneIds.length
        || record.milestones.some(state => !state || typeof state !== "object" || Array.isArray(state)
            || typeof (state as Record<string, unknown>).id !== "string"
            || typeof (state as Record<string, unknown>).name !== "string"
            || typeof (state as Record<string, unknown>).amount !== "number"
            || typeof (state as Record<string, unknown>).status !== "string"
            || ((state as Record<string, unknown>).qbInvoiceSentAt !== null && typeof (state as Record<string, unknown>).qbInvoiceSentAt !== "string")
            || typeof (state as Record<string, unknown>).qbInvoiceId !== "string"
            || ((state as Record<string, unknown>).qbInvoiceLink !== null && typeof (state as Record<string, unknown>).qbInvoiceLink !== "string")
            || ((state as Record<string, unknown>).qbSyncError !== null && typeof (state as Record<string, unknown>).qbSyncError !== "string"))
        || !Array.isArray(record.resultMilestones)
        || record.resultMilestones.length !== record.milestoneIds.length
        || record.resultMilestones.some(result => !result || typeof result !== "object" || Array.isArray(result)
            || typeof (result as Record<string, unknown>).id !== "string"
            || typeof (result as Record<string, unknown>).name !== "string"
            || typeof (result as Record<string, unknown>).wasReconciled !== "boolean")) {
        return null;
    }
    return {
        ...base,
        overrideEmail: record.overrideEmail as string | null,
        milestoneIds: record.milestoneIds as string[],
        milestones: record.milestones as MilestoneAttemptState[],
        resultMilestones: record.resultMilestones as Array<{ id: string; name: string; wasReconciled: boolean }>,
    };
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

async function getDefaultSalesTaxRate(
    client: Pick<Prisma.TransactionClient, "companySettings"> = prisma,
): Promise<number> {
    const settings = await client.companySettings.findUnique({
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
    const estimateHint = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { projectId: true },
    });
    if (!estimateHint) throw new Error("Estimate not found");
    if (!estimateHint.projectId) throw new Error("Project not found");
    const projectId = estimateHint.projectId;

    // Project -> Estimate is the shared creation/target-selection mutex. Keep
    // both locks through the Invoice insert, every cloned milestone, and the
    // final balance/status write. A CO biller that acquires the Estimate lock
    // and re-selects its target therefore sees either all of this invoice or
    // none of it—never the older project invoice during a half-created B.
    const created = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Estimate" WHERE id = ${estimateId} FOR UPDATE`;

        const estimate = await tx.estimate.findUnique({ where: { id: estimateId } });
        if (!estimate) throw new Error("Estimate not found");
        if (estimate.projectId !== projectId) {
            throw new Error("Estimate project changed while creating its invoice; reload and retry");
        }
        const project = await tx.project.findUnique({ where: { id: projectId } });
        if (!project) throw new Error("Project not found");

        const total = toNum(estimate.totalAmount || 0);
        const rate = estimate.taxRatePercent != null
            ? Number(estimate.taxRatePercent)
            : await getDefaultSalesTaxRate(tx);
        const tax = deriveInvoiceTaxFields(total, rate, !!estimate.taxExempt);
        const invoice = await tx.invoice.create({
            data: {
                code: "INV-TEMP",
                projectId,
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
        const invoiceCode = `INV-${String(invoice.number).padStart(5, "0")}`;
        const schedules = await tx.estimatePaymentSchedule.findMany({
            where: { estimateId },
            orderBy: { order: "asc" },
        });

        let paidAmount = 0;
        const createdPaymentIds: string[] = [];
        if (schedules.length > 0) {
            for (const schedule of schedules) {
                if (schedule.status === "Paid") paidAmount += toNum(schedule.amount);
                const createdPayment = await tx.paymentSchedule.create({
                    data: {
                        invoiceId: invoice.id,
                        sourceScheduleId: schedule.id,
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
                    select: { id: true },
                });
                createdPaymentIds.push(createdPayment.id);
            }
        } else {
            const createdPayment = await tx.paymentSchedule.create({
                data: {
                    invoiceId: invoice.id,
                    name: "Initial Payment",
                    amount: estimate.totalAmount || 0,
                    status: "Pending",
                },
                select: { id: true },
            });
            createdPaymentIds.push(createdPayment.id);
        }

        const newBalanceDue = Math.max(0, total - paidAmount);
        const invoiceStatus = paidAmount > 0
            ? (newBalanceDue <= 0 ? "Paid" : "Partially Paid")
            : "Draft";
        await tx.invoice.update({
            where: { id: invoice.id },
            data: { code: invoiceCode, balanceDue: newBalanceDue, status: invoiceStatus },
        });
        return {
            id: invoice.id,
            projectId,
            createdPaymentIds,
        };
    }));

    revalidatePath(`/projects/${created.projectId}/invoices`);
    return {
        id: created.id,
        projectId: created.projectId,
        // Internal compensation token: the guarded wrapper may delete a losing
        // concurrent duplicate only while these remain its exact child set.
        createdPaymentIds: created.createdPaymentIds,
    };
}

export function invoiceCompensationSnapshotMatches(input: {
    estimateId: string;
    createdPaymentIds: readonly string[];
    invoice: {
        estimateId?: string | null;
        status: string;
        sentAt?: Date | null;
        viewedAt?: Date | null;
        qbInvoiceId?: string | null;
        qbSyncedAt?: Date | null;
        hasEmailAttempt?: boolean;
        progressBillingCount?: number;
        payments: Array<Parameters<typeof paymentScheduleHasProviderOrPaymentEvidence>[0] & { id: string }>;
    };
}): boolean {
    if (input.invoice.estimateId !== input.estimateId) return false;
    if (invoiceHasAuditEvidence(input.invoice)) return false;
    const expectedIds = [...input.createdPaymentIds].sort();
    const actualIds = input.invoice.payments.map((payment) => payment.id).sort();
    return expectedIds.length === actualIds.length
        && expectedIds.every((id, index) => id === actualIds[index]);
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
        // Lock the exact losing parent before checking its relations. The parent
        // row lock serializes FK child inserts, and exact child-id comparison
        // ensures the compensating cascade can remove only the schedules this
        // invocation created — never concurrent provider/audit state.
        const removed = await withTxRetry(() => prisma.$transaction(async (tx) => {
            await lockMoneyParents(tx, { estimateId, invoiceId: created.id });
            const candidate = await tx.invoice.findUnique({
                where: { id: created.id },
                include: {
                    payments: true,
                    progressBillings: { select: { id: true } },
                    emailAttempt: { select: { invoiceId: true } },
                },
            });
            if (!candidate || !invoiceCompensationSnapshotMatches({
                estimateId,
                createdPaymentIds: created.createdPaymentIds,
                invoice: {
                    ...candidate,
                    hasEmailAttempt: Boolean(candidate.emailAttempt),
                    progressBillingCount: candidate.progressBillings.length,
                },
            })) return false;
            await tx.invoice.delete({ where: { id: created.id } });
            return true;
        }));
        if (removed) {
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

type InvoiceDeliveryDatabase = Pick<Prisma.TransactionClient, "invoice" | "changeOrderAutomationJob">;

export async function activeApprovalClientDeliveryForInvoice(
    invoiceId: string,
    db: InvoiceDeliveryDatabase = prisma,
) {
    const invoice = await db.invoice.findUnique({
        where: { id: invoiceId },
        select: { estimateId: true, projectId: true },
    });
    if (!invoice) return null;
    return db.changeOrderAutomationJob.findFirst({
        where: {
            kind: "APPROVAL_CLIENT_EMAIL",
            // SUCCEEDED is no longer concurrent; a deliberate resend may proceed.
            // NEEDS_ATTENTION remains blocked because delivery can be ambiguous.
            status: { in: ["PENDING", "PROCESSING", "NEEDS_ATTENTION"] },
            changeOrder: {
                OR: [
                    { projectId: invoice.projectId },
                    ...(invoice.estimateId ? [{ estimateId: invoice.estimateId }] : []),
                ],
            },
        },
        select: { id: true, status: true },
        orderBy: { createdAt: "asc" },
    });
}

function activeApprovalDeliveryMessage(status: string): string {
    return status === "NEEDS_ATTENTION"
        ? "Automatic change-order payment delivery has an unresolved provider outcome. Verify that durable job before sending this invoice again."
        : "Automatic change-order payment delivery is still in progress. Wait for it to finish before sending this invoice.";
}

export async function sendInvoiceToClientCore(
    invoiceId: string,
    overrideEmail?: string,
    expectation: InvoiceSendExpectation = {},
) {
    const [invoiceRef, attemptRef] = await Promise.all([
        prisma.invoice.findUnique({
            where: { id: invoiceId },
            select: { estimateId: true },
        }),
        prisma.invoiceEmailAttempt.findUnique({
            where: { invoiceId },
            select: { attemptKey: true },
        }),
    ]);
    if (!invoiceRef) throw new Error("Invoice not found");

    // Phase one freezes the complete first payload and provider key in a short,
    // committed transaction. A process crash or ambiguous provider outcome can
    // therefore retry byte-identically without inventing a second delivery.
    const prepared = await prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, {
            estimateId: invoiceRef.estimateId,
            invoiceId,
            allowInvoiceEmailAttemptKey: attemptRef?.attemptKey,
        });
        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: {
                project: { include: { client: true } },
                client: true,
                payments: {
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        name: true,
                        amount: true,
                        status: true,
                        dueDate: true,
                        qbInvoiceSentAt: true,
                    },
                },
            },
        });
        if (!invoice) throw new Error("Invoice not found");

        const existingRow = await tx.invoiceEmailAttempt.findUnique({ where: { invoiceId } });
        const providerStartedAttempt = parseInvoiceEmailAttemptPayload(existingRow?.payload);
        if (existingRow?.providerStartedAt) {
            if (existingRow.kind !== "WHOLE_INVOICE"
                || !providerStartedAttempt
                || !canRetryProviderAttempt(existingRow.startedAt, new Date())) {
                return {
                    kind: "error" as const,
                    result: {
                        success: false as const,
                        code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                        error: "A provider-started invoice email cannot be retried safely. Verify delivery before any new send.",
                        sentTo: undefined,
                    },
                };
            }
            // Once the provider fence exists, later approval jobs or Client
            // edits cannot replace/veto this attempt. Resume its byte-identical
            // payload/key; all money writers remain blocked on the Invoice.
            return {
                kind: "ready" as const,
                attemptKey: existingRow.attemptKey,
                attempt: providerStartedAttempt,
            };
        }

        const automaticDelivery = await activeApprovalClientDeliveryForInvoice(invoiceId, tx);
        if (automaticDelivery) {
            return {
                kind: "error" as const,
                result: {
                    success: false as const,
                    error: activeApprovalDeliveryMessage(automaticDelivery.status),
                    sentTo: undefined,
                },
            };
        }

        const currentRecipients = canonicalMilestoneRecipients(
            overrideEmail || invoice.client?.email || invoice.project?.client?.email,
            invoice.client?.additionalEmail || invoice.project?.client?.additionalEmail,
        );
        const recipientConflict = milestoneRecipientConflictError({
            expected: expectation.expectedRecipients,
            current: currentRecipients,
        });
        if (recipientConflict) {
            return {
                kind: "error" as const,
                result: {
                    success: false as const,
                    code: "RECIPIENT_CONFLICT" as const,
                    error: recipientConflict,
                    sentTo: undefined,
                },
            };
        }
        const currentFinancialFingerprint = invoiceSendFinancialFingerprint({
            invoiceId: invoice.id,
            code: invoice.code,
            status: invoice.status,
            totalAmount: Number(invoice.totalAmount),
            balanceDue: Number(invoice.balanceDue),
            payments: invoice.payments.map(payment => ({
                id: payment.id,
                name: payment.name,
                amount: Number(payment.amount),
                status: payment.status,
                dueDate: payment.dueDate?.toISOString() ?? null,
                qbInvoiceSentAt: payment.qbInvoiceSentAt?.toISOString() ?? null,
            })),
        });
        if (expectation.expectedFinancialFingerprint
            && expectation.expectedFinancialFingerprint !== currentFinancialFingerprint) {
            return {
                kind: "error" as const,
                result: {
                    success: false as const,
                    code: "INVOICE_STATE_CONFLICT" as const,
                    error: "Invoice amount or payment state changed after the preview; review the fresh invoice before sending.",
                    sentTo: undefined,
                },
            };
        }

        if (existingRow) {
            if (existingRow.kind !== "WHOLE_INVOICE") {
                return {
                    kind: "error" as const,
                    result: {
                        success: false as const,
                        code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                        error: "A milestone email attempt is unresolved; verify it before sending the whole invoice.",
                        sentTo: undefined,
                    },
                };
            }
            const existing = parseInvoiceEmailAttemptPayload(existingRow.payload);
            if (!existing) {
                if (!existingRow.providerStartedAt) {
                    await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
                } else {
                    return {
                        kind: "error" as const,
                        result: {
                            success: false as const,
                            code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                            error: "This invoice has an incomplete prior email checkpoint. Verify delivery before sending again.",
                            sentTo: undefined,
                        },
                    };
                }
            } else if (milestoneRecipientConflictError({ expected: existing.recipients, current: currentRecipients })
                || existing.financialFingerprint !== currentFinancialFingerprint
                || !canRetryProviderAttempt(existingRow.startedAt, new Date())) {
                if (!existingRow.providerStartedAt) {
                    // No provider boundary was crossed; replacing this stale
                    // checkpoint is safe and avoids permanently wedging billing.
                    await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
                } else {
                    return {
                        kind: "error" as const,
                        result: {
                            success: false as const,
                            code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                            error: "A prior invoice email has a provider-started unresolved outcome and no longer matches the current invoice. Verify delivery before any new send.",
                            sentTo: undefined,
                        },
                    };
                }
            } else {
                return {
                    kind: "ready" as const,
                    attemptKey: existingRow.attemptKey,
                    attempt: existing,
                };
            }
        }

        const recipientEmail = currentRecipients.to[0];
        if (!recipientEmail) throw new Error("No email address provided");
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
        const clientId = invoice.clientId || invoice.project?.clientId;
        let portalUrl: string;
        if (clientId) {
            const { signClientPortalToken } = await import("./client-portal-auth");
            const token = await signClientPortalToken(clientId, recipientEmail);
            portalUrl = `${appUrl}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(`/portal/invoices/${invoiceId}`)}`;
        } else {
            portalUrl = `${appUrl}/portal/invoices/${invoiceId}`;
        }
        const settings = await tx.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Your Contractor";
        const invoiceCc = currentRecipients.cc.length ? currentRecipients.cc : undefined;
        const internalCopies = (settings?.notificationEmail?.trim() || CLIENT_DOC_COPY_EMAIL)
            .split(",")
            .map(email => email.trim())
            .filter(Boolean);
        const dispatch = buildFrozenNotification({
            to: [recipientEmail],
            subject: `${companyName} sent you an invoice — ${invoice.code}`,
            html: `<!DOCTYPE html>
            <html>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                <div style="text-align: center; margin-bottom: 32px;">
                    <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
                </div>
                <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                    <h2 style="font-size: 20px; margin: 0 0 8px;">Invoice ${invoice.code}</h2>
                    <p style="color: #666; margin: 0 0 24px;">Hi ${invoice.client?.name || invoice.project?.client?.name || "there"},</p>
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
            fromName: companyName,
            replyTo: settings?.email || undefined,
            cc: invoiceCc,
            bcc: internalCopies,
        });
        const attemptKey = `invoice-send/${invoiceId}/${randomUUID()}`;
        const attempt: InvoiceEmailAttemptPayload = {
            dispatch,
            recipients: currentRecipients,
            financialFingerprint: currentFinancialFingerprint,
        };
        await tx.invoiceEmailAttempt.create({
            data: {
                invoiceId,
                kind: "WHOLE_INVOICE",
                attemptKey,
                payload: JSON.parse(JSON.stringify(attempt)) as Prisma.InputJsonValue,
                startedAt: new Date(),
            },
        });
        return {
            kind: "ready" as const,
            attemptKey,
            attempt,
        };
    }, { timeout: 15_000 });

    if (prepared.kind === "error") return prepared.result;

    // Commit the provider-start fence before crossing the external boundary.
    // Every money writer checks this row after acquiring the Invoice lock; once
    // this timestamp exists it must wait until the same stable attempt resolves.
    const providerFence = await prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, {
            estimateId: invoiceRef.estimateId,
            invoiceId,
            allowInvoiceEmailAttemptKey: prepared.attemptKey,
        });
        const attemptRow = await tx.invoiceEmailAttempt.findUnique({ where: { invoiceId } });
        const attempt = parseInvoiceEmailAttemptPayload(attemptRow?.payload);
        if (attemptRow?.attemptKey !== prepared.attemptKey
            || attemptRow.kind !== "WHOLE_INVOICE"
            || !attempt) {
            return {
                kind: "error" as const,
                result: {
                    success: false as const,
                    code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                    error: "The durable invoice email checkpoint changed before provider delivery. Reload before sending.",
                    sentTo: undefined,
                },
            };
        }
        if (attemptRow.providerStartedAt) {
            return { kind: "ready" as const };
        }
        const automaticDelivery = await activeApprovalClientDeliveryForInvoice(invoiceId, tx);
        if (automaticDelivery) {
            if (!attemptRow.providerStartedAt) {
                await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
            }
            return {
                kind: "error" as const,
                result: {
                    success: false as const,
                    code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                    error: attemptRow.providerStartedAt
                        ? `${activeApprovalDeliveryMessage(automaticDelivery.status)} A provider-started whole-invoice attempt also needs reconciliation.`
                        : activeApprovalDeliveryMessage(automaticDelivery.status),
                    sentTo: undefined,
                },
            };
        }
        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: {
                project: { include: { client: true } },
                client: true,
                payments: {
                    orderBy: { id: "asc" },
                    select: { id: true, name: true, amount: true, status: true, dueDate: true, qbInvoiceSentAt: true },
                },
            },
        });
        if (!invoice) throw new Error("Invoice not found");
        // Canonical first-attempt lock order is Estimate -> Invoice -> Client ->
        // CompanySettings. This final read, not the earlier routing snapshot,
        // owns the decision to cross the provider boundary.
        const lockedDestinations = await lockInvoiceDeliveryRecipientSet(tx, {
            clientId: invoice.clientId,
            overrideEmail,
        });
        const currentRecipients = lockedDestinations.visible;
        const completeRecipientConflict = completeFrozenRecipientConflictError({
            expected: attempt.dispatch,
            current: lockedDestinations.complete,
        });
        const currentFinancialFingerprint = invoiceSendFinancialFingerprint({
            invoiceId: invoice.id,
            code: invoice.code,
            status: invoice.status,
            totalAmount: Number(invoice.totalAmount),
            balanceDue: Number(invoice.balanceDue),
            payments: invoice.payments.map(payment => ({
                id: payment.id,
                name: payment.name,
                amount: Number(payment.amount),
                status: payment.status,
                dueDate: payment.dueDate?.toISOString() ?? null,
                qbInvoiceSentAt: payment.qbInvoiceSentAt?.toISOString() ?? null,
            })),
        });
        if (completeRecipientConflict
            || milestoneRecipientConflictError({ expected: attempt.recipients, current: currentRecipients })
            || attempt.financialFingerprint !== currentFinancialFingerprint) {
            if (!attemptRow.providerStartedAt) {
                await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
            }
            return {
                kind: "error" as const,
                result: {
                    success: false as const,
                    code: attemptRow.providerStartedAt
                        ? "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const
                        : "INVOICE_STATE_CONFLICT" as const,
                    error: attemptRow.providerStartedAt
                        ? "A provider-started invoice email no longer matches current recipients or money state. Verify delivery before any new send."
                        : completeRecipientConflict
                            || "Invoice recipients or money state changed before provider delivery. Review the fresh invoice before sending.",
                    sentTo: undefined,
                },
            };
        }
        if (!attemptRow.providerStartedAt) {
            await tx.invoiceEmailAttempt.update({
                where: { invoiceId },
                data: { providerStartedAt: new Date() },
            });
        }
        return { kind: "ready" as const };
    }, { timeout: 15_000 });
    if (providerFence.kind === "error") return providerFence.result;

    // Phase three locks the money parents, revalidates the durable checkpoint,
    // then keeps the Invoice lock through provider delivery and bookkeeping.
    // The external call is bounded and idempotent; this transaction is never
    // auto-retried. If its commit is lost, phase one's checkpoint survives and
    // the next request repeats the exact same payload/key.
    const outcome = await prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, {
            estimateId: invoiceRef.estimateId,
            invoiceId,
            allowInvoiceEmailAttemptKey: prepared.attemptKey,
        });
        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            select: { id: true, status: true, projectId: true, code: true },
        });
        if (!invoice) throw new Error("Invoice not found");
        const attemptRow = await tx.invoiceEmailAttempt.findUnique({ where: { invoiceId } });
        const persistedAttempt = parseInvoiceEmailAttemptPayload(attemptRow?.payload);
        if (attemptRow?.attemptKey !== prepared.attemptKey
            || attemptRow.kind !== "WHOLE_INVOICE"
            || !persistedAttempt
            || !attemptRow.providerStartedAt) {
            return {
                result: {
                    success: false as const,
                    code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                    error: "The durable invoice email attempt changed or already completed. Reload before any further send.",
                    sentTo: undefined,
                },
                audit: null,
            };
        }
        // Phase two is the final live-state validation. Once providerStartedAt
        // commits, the Invoice row lock/fence makes this frozen attempt the sole
        // permitted money writer. A later approval enqueue or Client edit must
        // not veto it here: doing so would retain a provider-started checkpoint
        // that blocks both the approval BILL job and every retry indefinitely.
        if (!canRetryProviderAttempt(attemptRow.startedAt, new Date())) {
            return {
                result: {
                    success: false as const,
                    code: "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const,
                    error: "The frozen invoice email exceeded the provider idempotency window. Verify delivery before any new send.",
                    sentTo: undefined,
                },
                audit: null,
            };
        }

        const providerResult = await defaultSendFrozenNotification(
            persistedAttempt.dispatch,
            attemptRow.attemptKey,
        );
        if (!providerResult.success) {
            if (!providerResult.ambiguous) {
                await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
            }
            return {
                result: {
                    success: false as const,
                    code: providerResult.ambiguous
                        ? "INVOICE_EMAIL_ATTEMPT_UNRESOLVED" as const
                        : "INVOICE_EMAIL_PROVIDER_REJECTED" as const,
                    error: providerResult.ambiguous
                        ? "The invoice email provider outcome is ambiguous. Retry only this same frozen attempt; do not create a new send."
                        : "The invoice email provider rejected the request; no email was recorded.",
                    sentTo: undefined,
                },
                audit: null,
            };
        }

        const sentAt = new Date();
        await tx.invoice.update({
            where: { id: invoiceId },
            data: {
                ...(invoice.status === "Draft"
                    ? { status: "Issued", issueDate: sentAt, sentAt }
                    : { sentAt }),
            },
        });
        // This broad stamp is safe only while the Invoice parent lock is held:
        // approval BILL workers must acquire the same lock before inserting.
        await tx.paymentSchedule.updateMany({
            where: { invoiceId, status: "Pending" },
            data: { qbInvoiceSentAt: sentAt },
        });
        await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
        return {
            result: { success: true as const, sentTo: persistedAttempt.recipients.to[0] },
            audit: {
                projectId: invoice.projectId,
                companyName: persistedAttempt.dispatch.from.replace(/\s*<[^>]+>\s*$/, "") || "Your Contractor",
                invoiceCode: invoice.code,
            },
        };
    }, { timeout: 20_000 });

    if (outcome.audit?.projectId) {
        try {
            await logActivityLazy({
                projectId: outcome.audit.projectId,
                actorType: "TEAM",
                actorName: outcome.audit.companyName,
                action: "sent_invoice",
                entityType: "invoice",
                entityId: invoiceId,
                entityName: `Invoice ${outcome.audit.invoiceCode}`,
            });
            revalidatePath(`/projects/${outcome.audit.projectId}/invoices`);
            revalidatePath(`/projects/${outcome.audit.projectId}/invoices/${invoiceId}`);
        } catch (error) {
            // The provider + money state already committed. Reporting failure here
            // would invite a new attempt/key and a duplicate customer email.
            console.error("[sendInvoiceToClientCore] Post-send audit/cache refresh failed:", error);
        }
    }
    if (outcome.result.success) revalidatePath("/invoices");
    return outcome.result;
}

/**
 * Resend an invoice whose QuickBooks payment links may have gone stale: refresh
 * each milestone's QBO link (re-pushing clears "voided"/"notFound" flags where
 * possible), then send the ProBuild invoice email with its always-current portal
 * link. QuickBooks being disconnected downgrades to a plain resend, not a failure.
 */
export async function resendInvoiceCore(
    invoiceId: string,
    overrideEmail?: string,
    expectation: InvoiceSendExpectation = {},
) {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            client: true,
            project: { include: { client: true } },
            payments: {
                orderBy: { id: "asc" },
                select: {
                    id: true,
                    name: true,
                    amount: true,
                    status: true,
                    dueDate: true,
                    qbInvoiceId: true,
                    qbInvoiceSentAt: true,
                },
            },
        },
    });
    if (!invoice) return { success: false as const, error: "Invoice not found" };

    const currentRecipients = canonicalMilestoneRecipients(
        overrideEmail || invoice.client?.email || invoice.project?.client?.email,
        invoice.client?.additionalEmail || invoice.project?.client?.additionalEmail,
    );
    const recipientConflict = milestoneRecipientConflictError({
        expected: expectation.expectedRecipients,
        current: currentRecipients,
    });
    if (recipientConflict) {
        return {
            success: false as const,
            code: "RECIPIENT_CONFLICT" as const,
            error: recipientConflict,
            linkRefresh: [],
        };
    }
    const currentFinancialFingerprint = invoiceSendFinancialFingerprint({
        invoiceId: invoice.id,
        code: invoice.code,
        status: invoice.status,
        totalAmount: Number(invoice.totalAmount),
        balanceDue: Number(invoice.balanceDue),
        payments: invoice.payments.map(payment => ({
            id: payment.id,
            name: payment.name,
            amount: Number(payment.amount),
            status: payment.status,
            dueDate: payment.dueDate?.toISOString() ?? null,
            qbInvoiceSentAt: payment.qbInvoiceSentAt?.toISOString() ?? null,
        })),
    });
    if (expectation.expectedFinancialFingerprint
        && expectation.expectedFinancialFingerprint !== currentFinancialFingerprint) {
        return {
            success: false as const,
            code: "INVOICE_STATE_CONFLICT" as const,
            error: "Invoice amount or payment state changed after the preview; review the fresh invoice before refreshing payment links.",
            linkRefresh: [],
        };
    }

    const existingEmailAttempt = await prisma.invoiceEmailAttempt.findUnique({
        where: { invoiceId },
        select: { kind: true },
    });
    if (existingEmailAttempt) {
        if (existingEmailAttempt.kind !== "WHOLE_INVOICE") {
            return {
                success: false as const,
                error: "A milestone email attempt is unresolved; verify it before resending the whole invoice.",
                linkRefresh: [],
            };
        }
        const retried = await sendInvoiceToClientCore(invoiceId, overrideEmail, expectation);
        return { ...retried, linkRefresh: [] };
    }

    // Stop before token refresh, QBO reads, or any provider-visible work. The
    // send core rechecks immediately before delivery after link refresh too.
    const automaticDelivery = await activeApprovalClientDeliveryForInvoice(invoiceId);
    if (automaticDelivery) {
        return {
            success: false as const,
            error: activeApprovalDeliveryMessage(automaticDelivery.status),
            linkRefresh: [],
        };
    }

    const linkRefresh: Array<{ milestone: string; refreshed: boolean; payLink?: string; error?: string }> = [];
    let linkRefreshConflict: string | null = null;
    const qbMilestones = invoice.payments.filter(p => p.qbInvoiceId && p.status !== "Paid" && p.status !== "Canceled");
    if (qbMilestones.length > 0) {
        try {
            const {
                getFreshQBTokens,
                pushMilestoneToQuickBooks,
                refreshExistingMilestoneQboStateUnderInvoiceLock,
            } = await import("./quickbooks-payments");
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
                        const snapshot = await prisma.paymentSchedule.findUnique({
                            where: { id: m.id },
                            select: {
                                invoiceId: true,
                                status: true,
                                qbInvoiceId: true,
                                qbCreateGeneration: true,
                                qbInvoiceLink: true,
                                qbSyncError: true,
                            },
                        });
                        if (!snapshot || snapshot.invoiceId !== invoiceId || snapshot.qbInvoiceId !== res.qbInvoiceId) {
                            linkRefreshConflict = "A milestone changed QuickBooks identity while its payment link was being refreshed; reload before resending.";
                            break;
                        }
                        const liveLink = await getQBInvoicePaymentLink(tokens, res.qbInvoiceId);
                        if (liveLink) {
                            if (liveLink !== snapshot.qbInvoiceLink) {
                                const write = await withTxRetry(() => prisma.$transaction(tx => (
                                    refreshExistingMilestoneQboStateUnderInvoiceLock(tx, {
                                        scheduleId: m.id,
                                        invoiceId,
                                        expectedStatus: snapshot.status,
                                        expectedQbInvoiceId: res.qbInvoiceId,
                                        expectedGeneration: snapshot.qbCreateGeneration,
                                        expectedQbInvoiceLink: snapshot.qbInvoiceLink,
                                        expectedQbSyncError: snapshot.qbSyncError,
                                        payLink: liveLink,
                                        providerReachable: true,
                                    })
                                )));
                                if (write === "stale") {
                                    linkRefreshConflict = "A milestone changed while its QuickBooks payment link was being refreshed; reload before resending.";
                                    break;
                                }
                            }
                            payLink = liveLink;
                        }
                    }
                    linkRefresh.push({ milestone: m.name, refreshed: true, payLink });
                } catch (err: any) {
                    linkRefresh.push({ milestone: m.name, refreshed: false, error: err?.message || "refresh failed" });
                }
                if (linkRefreshConflict) break;
            }
        } catch {
            linkRefresh.push({ milestone: "(all)", refreshed: false, error: "QuickBooks not connected — portal link still works" });
        }
    }

    if (linkRefreshConflict) {
        return {
            success: false as const,
            code: "INVOICE_STATE_CONFLICT" as const,
            error: linkRefreshConflict,
            linkRefresh,
        };
    }

    const sent = await sendInvoiceToClientCore(invoiceId, overrideEmail, expectation);
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

export function buildMilestoneFrozenNotification(input: {
    companyName: string;
    companyEmail?: string | null;
    notificationEmail?: string | null;
    clientName?: string | null;
    projectName?: string | null;
    invoiceCode: string;
    milestones: Array<{ name: string; amount: number }>;
    portalUrl: string;
    recipients: MilestoneRecipientSet;
}): FrozenNotification {
    const { subject, html } = buildMilestoneRequestEmail({
        companyName: input.companyName,
        clientName: input.clientName,
        projectName: input.projectName,
        invoiceCode: input.invoiceCode,
        milestones: input.milestones,
        portalUrl: input.portalUrl,
    });
    const internalCopies = (input.notificationEmail?.trim() || CLIENT_DOC_COPY_EMAIL)
        .split(",")
        .map(email => email.trim())
        .filter(Boolean);

    return buildFrozenNotification({
        to: input.recipients.to,
        subject,
        html,
        fromName: input.companyName,
        replyTo: input.companyEmail || undefined,
        cc: input.recipients.cc,
        bcc: internalCopies,
    });
}

export type MilestoneAutomationDelivery = {
    idempotencyKey: string;
    /** Exact billing result this job is allowed to deliver. */
    expectedScheduleIds?: readonly string[];
    /** Heartbeat the fenced claim immediately before each external side effect. */
    renewBeforeSideEffect?: () => Promise<boolean>;
    /** The byte-identical dispatch loaded from the durable job on a retry. */
    frozenNotification?: FrozenNotification;
    /**
     * Persist the first dispatch and provider-attempt checkpoint before sending.
     * The returned value is authoritative: if another attempt already froze the
     * payload, it returns that immutable winner rather than the candidate.
     */
    persistFrozenNotification: (candidate: FrozenNotification) => Promise<FrozenNotification>;
    sendFrozenNotification?: (
        dispatch: FrozenNotification,
        idempotencyKey: string,
    ) => Promise<{ success: boolean; id?: string; ambiguous?: boolean }>;
    /** Owns the atomic milestone stamps, invoice transition/activity, and job completion. */
    completeAfterDelivery: (input: {
        invoiceId: string;
        scheduleIds: string[];
        recipient: string;
        sentAt: Date;
        providerMessageId?: string;
        milestoneFingerprint?: string;
        milestones?: MilestoneAttemptState[];
    }) => Promise<void>;
};

export type MilestoneFrozenDeliveryResult = {
    delivered: boolean;
    recorded: boolean;
    deliveredButUnrecorded?: boolean;
    deliveryAmbiguous?: boolean;
    providerMessageId?: string;
    error?: string;
};

export function milestoneAutomationPreflightError(input: {
    requestedIds: readonly string[];
    expectedIds: readonly string[];
    milestones: Array<{ id: string; status: string; qbInvoiceSentAt: Date | null }>;
    recipient: string;
}): string | null {
    const canonical = (ids: readonly string[]) => [...new Set(ids)].sort();
    const requested = canonical(input.requestedIds);
    const expected = canonical(input.expectedIds);
    const found = canonical(input.milestones.map(milestone => milestone.id));
    if (
        requested.length !== input.requestedIds.length
        || expected.length !== input.expectedIds.length
        || requested.length !== expected.length
        || requested.some((id, index) => id !== expected[index])
        || found.length !== expected.length
        || found.some((id, index) => id !== expected[index])
    ) {
        return "Billing preflight did not preserve the exact billed milestone set; no QuickBooks or email action was attempted.";
    }
    if (!input.recipient.trim()) return "Client has no email on file";
    if (input.milestones.some(milestone => milestone.status === "Paid" || milestone.status === "Canceled")) {
        return "The exact billed milestone set contains a milestone that is already paid or canceled.";
    }
    if (input.milestones.some(milestone => milestone.qbInvoiceSentAt !== null)) {
        return "The exact billed milestone set contains a payment request that was already sent; automatic delivery stopped to prevent a duplicate email.";
    }
    return null;
}

/**
 * Durable provider boundary for approval-driven milestone requests. The
 * persist callback always runs first, even when the caller supplied a frozen
 * retry payload, so it can fence the claim and record the provider-idempotency
 * horizon immediately before every attempt.
 */
export async function deliverMilestoneFrozenNotification(
    candidate: FrozenNotification,
    context: {
        invoiceId: string;
        scheduleIds: string[];
        recipient: string;
        milestoneFingerprint?: string;
        milestones?: MilestoneAttemptState[];
    },
    automation: MilestoneAutomationDelivery,
): Promise<MilestoneFrozenDeliveryResult> {
    let dispatch: FrozenNotification;
    try {
        dispatch = await automation.persistFrozenNotification(
            automation.frozenNotification ?? candidate,
        );
    } catch (error: any) {
        return {
            delivered: false,
            recorded: false,
            error: `Could not persist the frozen payment request (${error?.message || "unknown error"})`,
        };
    }

    const send = automation.sendFrozenNotification ?? defaultSendFrozenNotification;
    let providerResult: { success: boolean; id?: string; ambiguous?: boolean };
    try {
        providerResult = await send(dispatch, automation.idempotencyKey);
    } catch (error: any) {
        return {
            delivered: false,
            recorded: false,
            error: `Email provider failed to send the payment request (${error?.message || "unknown error"})`,
        };
    }
    if (!providerResult.success) {
        if (providerResult.ambiguous) {
            return {
                delivered: false,
                recorded: false,
                deliveryAmbiguous: true,
                error: "Email provider outcome is ambiguous — do not resend; recover the same automation job with its existing idempotency key.",
            };
        }
        return {
            delivered: false,
            recorded: false,
            error: "Email provider failed to send the payment request",
        };
    }

    try {
        await automation.completeAfterDelivery({
            ...context,
            scheduleIds: [...context.scheduleIds],
            sentAt: new Date(),
            ...(providerResult.id ? { providerMessageId: providerResult.id } : {}),
        });
    } catch (error: any) {
        return {
            delivered: true,
            recorded: false,
            deliveredButUnrecorded: true,
            ...(providerResult.id ? { providerMessageId: providerResult.id } : {}),
            error: `Email delivered, but durable recording failed (${error?.message || "unknown error"}) — do not resend; recover the same automation job with its existing idempotency key.`,
        };
    }

    return {
        delivered: true,
        recorded: true,
        ...(providerResult.id ? { providerMessageId: providerResult.id } : {}),
    };
}

type MilestoneEmailInvoice = {
    id: string;
    code: string;
    clientId: string | null;
    client: { name: string | null; email: string | null; additionalEmail: string | null } | null;
    project: { name: string; clientId: string | null; client: { additionalEmail: string | null } | null } | null;
};

async function milestonePortalUrl(
    invoice: MilestoneEmailInvoice,
    milestones: Array<{ id: string }>,
    recipient: string,
): Promise<string> {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const clientId = invoice.clientId || invoice.project?.clientId;
    const nextPath = `/portal/invoices/${invoice.id}?milestone=${milestones.map(m => m.id).join(",")}`;
    if (!clientId) return `${appUrl}${nextPath}`;

    const { signClientPortalToken } = await import("./client-portal-auth");
    const token = await signClientPortalToken(clientId, recipient.toLowerCase());
    return `${appUrl}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(nextPath)}`;
}

async function sendMilestoneRequestEmail(
    invoice: MilestoneEmailInvoice,
    milestones: Array<{ id: string; name: string; amount: number }>,
    recipients: MilestoneRecipientSet,
    companyName: string,
): Promise<void> {
    const recipient = recipients.to[0] ?? "";
    const portalUrl = await milestonePortalUrl(invoice, milestones, recipient);

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
            cc: recipients.cc,
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
    opts: {
        reconcile?: Record<string, number>;
        allowResend?: boolean;
        expectedRecipients?: MilestoneRecipientSet;
        expectedMilestoneFingerprint?: string;
    } | undefined,
    actorName: string,
    automation?: MilestoneAutomationDelivery,
): Promise<{
    success: boolean;
    sent: number;
    failed: number;
    skipped: number;
    // True when one or more selected milestones drifted from QBO and were NOT sent;
    // the modal flips into the side-by-side review step using driftReview.
    needsReview?: boolean;
    driftReview?: Array<{ id: string; name: string; probuildAmount: number; qbTotal: number; direction: "higher" | "lower" }>;
    deliveredButUnrecorded?: boolean;
    deliveryAmbiguous?: boolean;
    results: Array<{ id: string; name: string; status: "sent" | "skipped" | "failed" | "reconciled"; error?: string; sentTo?: string }>;
    error?: string;
    code?: "RECIPIENT_CONFLICT" | "MILESTONE_STATE_CONFLICT" | "QBO_CREATE_FINGERPRINT_MISMATCH";
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
        const activeInvoiceEmailAttempt = await prisma.invoiceEmailAttempt.findUnique({
            where: { invoiceId },
            select: { kind: true, providerStartedAt: true, payload: true },
        });
        if (activeInvoiceEmailAttempt) {
            const milestoneAttempt = activeInvoiceEmailAttempt.kind === "MILESTONE"
                ? parseMilestoneInvoiceEmailAttemptPayload(activeInvoiceEmailAttempt.payload)
                : null;
            const requested = [...new Set(paymentScheduleIds)].sort();
            const frozenIds = milestoneAttempt ? [...milestoneAttempt.milestoneIds].sort() : [];
            const requestedRecipients = canonicalMilestoneRecipients(
                overrideEmail || invoice.client?.email || invoice.project?.client?.email || "",
                invoice.client?.additionalEmail || invoice.project?.client?.additionalEmail || null,
            );
            const adoptionError = milestoneAttempt ? manualMilestoneAttemptAdoptionError({
                requestedIds: requested,
                requestedRecipients,
                frozenIds,
                frozenRecipients: milestoneAttempt.recipients,
                providerStarted: activeInvoiceEmailAttempt.providerStartedAt !== null,
            }) : "The frozen milestone attempt is invalid.";
            const exactSet = milestoneAttempt
                && requested.length === frozenIds.length
                && requested.every((id, index) => id === frozenIds[index]);
            if (!automation && milestoneAttempt && exactSet) {
                const resumed = await deliverManualMilestoneAttempt(invoiceId, requestedRecipients);
                const resultRows = milestoneAttempt.resultMilestones.map(milestone => ({
                    id: milestone.id,
                    name: milestone.name,
                    status: milestone.wasReconciled ? "reconciled" as const : "sent" as const,
                    ...(resumed.delivered ? { sentTo: milestoneAttempt.recipients.to[0] } : {}),
                    ...(resumed.error ? { error: resumed.error } : {}),
                }));
                return {
                    success: resumed.delivered,
                    sent: resumed.delivered ? resultRows.length : 0,
                    failed: resumed.delivered ? 0 : resultRows.length,
                    skipped: 0,
                    ...(resumed.deliveredButUnrecorded ? { deliveredButUnrecorded: true } : {}),
                    ...(resumed.deliveryAmbiguous ? { deliveryAmbiguous: true } : {}),
                    results: resultRows,
                    ...(resumed.delivered ? {} : { error: resumed.error }),
                };
            }
            return {
                success: false,
                sent: 0,
                failed: 0,
                skipped: 0,
                results: [],
                error: adoptionError || `A ${activeInvoiceEmailAttempt.kind.toLowerCase().replace(/_/g, " ")} email has an unresolved ${activeInvoiceEmailAttempt.providerStartedAt ? "provider" : "pre-provider"} outcome. Verify that frozen attempt before sending any milestone request.`,
            };
        }

        const allPayments = invoice.payments;
        const selectedPayments = allPayments.filter(p => paymentScheduleIds.includes(p.id));
        if (selectedPayments.length === 0) {
            return { success: false, sent: 0, failed: 0, skipped: 0, results: [], error: "No milestones selected" };
        }
        const milestoneConflict = milestoneFinancialConflictError({
            expected: opts?.expectedMilestoneFingerprint,
            invoiceId,
            milestones: selectedPayments.map((payment): [string, string, number, string, string | null] => [
                payment.id,
                payment.name,
                Number(payment.amount),
                payment.status,
                payment.qbInvoiceSentAt?.toISOString() ?? null,
            ]),
        });
        if (milestoneConflict) {
            return {
                success: false,
                sent: 0,
                failed: 0,
                skipped: 0,
                results: [],
                code: "MILESTONE_STATE_CONFLICT",
                error: milestoneConflict,
            };
        }

        const primaryRecipient = overrideEmail || invoice.client?.email || invoice.project?.client?.email || "";
        const additionalRecipient = invoice.client?.additionalEmail || invoice.project?.client?.additionalEmail || null;
        // This is the second read after an MCP preview/confirm request. Compare
        // before loading QuickBooks, then use only this immutable snapshot for
        // the provider payload so a later contact edit cannot alter the send.
        const recipients = canonicalMilestoneRecipients(primaryRecipient, additionalRecipient);
        const recipient = recipients.to[0] ?? "";
        const recipientConflict = milestoneRecipientConflictError({
            expected: opts?.expectedRecipients,
            current: recipients,
        });
        if (recipientConflict) {
            return {
                success: false,
                sent: 0,
                failed: 0,
                skipped: 0,
                results: [],
                code: "RECIPIENT_CONFLICT",
                error: recipientConflict,
            };
        }
        if (automation) {
            const preflightError = milestoneAutomationPreflightError({
                requestedIds: paymentScheduleIds,
                expectedIds: automation.expectedScheduleIds ?? paymentScheduleIds,
                milestones: selectedPayments,
                recipient,
            });
            if (preflightError) {
                return { success: false, sent: 0, failed: 0, skipped: 0, results: [], error: preflightError };
            }
        } else {
            // Approval creates this job before its BILL worker creates milestones.
            // Refuse every manual/MCP send while durable approval delivery owns a
            // selected source CO; this closes the manual-vs-cron duplicate race.
            const sourceChangeOrderIds = [...new Set(
                selectedPayments
                    .map(payment => payment.sourceChangeOrderId)
                    .filter((id): id is string => Boolean(id)),
            )];
            if (sourceChangeOrderIds.length > 0) {
                const automaticDelivery = await prisma.changeOrderAutomationJob.findFirst({
                    where: {
                        changeOrderId: { in: sourceChangeOrderIds },
                        kind: "APPROVAL_CLIENT_EMAIL",
                        status: { notIn: ["SKIPPED", "CANCELED"] },
                    },
                    select: { id: true, status: true },
                });
                if (automaticDelivery) {
                    return {
                        success: false,
                        sent: 0,
                        failed: 0,
                        skipped: 0,
                        results: [],
                        error: `Automatic change-order approval delivery is ${automaticDelivery.status.toLowerCase().replace(/_/g, " ")}; wait for or reconcile that durable job instead of sending a duplicate payment request.`,
                    };
                }
            }
        }

        const renewBeforeSideEffect = async () => automation?.renewBeforeSideEffect
            ? automation.renewBeforeSideEffect()
            : true;
        const leaseLostResult = () => ({
            success: false,
            sent: 0,
            failed: 0,
            skipped: 0,
            results: [] as Array<{ id: string; name: string; status: "sent" | "skipped" | "failed" | "reconciled"; error?: string; sentTo?: string }>,
            error: "The automation claim lease was lost before a QuickBooks side effect; no further work was attempted.",
        });

        const {
            getFreshQBTokens,
            getMilestoneQboCreatePayloadMismatch,
            pushMilestoneToQuickBooks,
            reconcileMilestoneToQbo,
            refreshExistingMilestoneQboStateUnderInvoiceLock,
        } = await import("./quickbooks-payments");
        const { getQBInvoiceStatus, getQBInvoicePaymentLink } = await import("./quickbooks");

        for (const schedule of selectedPayments) {
            const mismatch = await getMilestoneQboCreatePayloadMismatch(schedule.id);
            if (mismatch) {
                return {
                    success: false,
                    sent: 0,
                    failed: 0,
                    skipped: selectedPayments.length,
                    code: "QBO_CREATE_FINGERPRINT_MISMATCH",
                    results: selectedPayments.map(payment => ({
                        id: payment.id,
                        name: payment.name,
                        status: "skipped" as const,
                        error: payment.id === schedule.id
                            ? `The frozen QuickBooks create payload no longer matches current billing fields (${mismatch.changedFields.length ? mismatch.changedFields.join(", ") : "fingerprint changed"}). Review before any QBO read or client delivery.`
                            : "The batch stopped before QuickBooks because another selected milestone requires review.",
                    })),
                    error: "A selected milestone's durable QuickBooks create payload changed; review and explicitly reconcile it before sending.",
                };
            }
        }

        let tokens;
        try {
            if (!(await renewBeforeSideEffect())) return leaseLostResult();
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
        let deliveredButUnrecorded = false;
        let deliveryAmbiguous = false;
        let qboLinkRefreshConflict: string | null = null;
        const results: Array<{ id: string; name: string; status: "sent" | "skipped" | "failed" | "reconciled"; error?: string; sentTo?: string }> = [];
        const driftReview: Array<{ id: string; name: string; probuildAmount: number; qbTotal: number; direction: "higher" | "lower" }> = [];
        // Milestones that cleared every guard, queued for the single request email
        // that goes out after the loop (one email per batch, not one per milestone).
        // effectiveAmount is the verified QuickBooks total — after a reconcile this
        // is the NEW amount, so the email never quotes the stale pre-reconcile one.
        const sendable: Array<{
            schedule: (typeof selectedPayments)[number];
            wasReconciled: boolean;
            effectiveAmount: number;
            verifiedQbInvoiceId: string;
        }> = [];

        for (const schedule of selectedPayments) {
            if (schedule.status === "Paid" || schedule.status === "Canceled") {
                skippedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "skipped", error: "Milestone is already paid or canceled" });
                continue;
            }

            if (!automation && schedule.qbInvoiceSentAt && !opts?.allowResend) {
                skippedCount++;
                results.push({
                    id: schedule.id,
                    name: schedule.name,
                    status: "skipped",
                    error: `Payment request was already sent at ${schedule.qbInvoiceSentAt.toISOString()}; explicit resend confirmation is required`,
                });
                continue;
            }

            if (!recipient) {
                skippedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "skipped", error: "Client has no email on file" });
                continue;
            }

            try {
                if (!(await renewBeforeSideEffect())) return leaseLostResult();
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
                    if (!(await renewBeforeSideEffect())) return leaseLostResult();
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
                sendable.push({ schedule, wasReconciled, effectiveAmount: qbTotal, verifiedQbInvoiceId: qbInvoiceId });
            } catch (err: any) {
                failedCount++;
                results.push({ id: schedule.id, name: schedule.name, status: "failed", error: err?.message || "Unexpected error during send" });
            }
        }

        // One client email per send batch, listing only the milestones that passed
        // the guards, with a portal link focused on them. If the email itself fails,
        // every queued milestone is marked failed (nothing was communicated), and
        // nothing is stamped as sent.
        let manualDurableDelivery = false;
        if (sendable.length > 0) {
            // Refresh each milestone's live QBO pay link so the portal Pay Now
            // never hands the client a stale link (best-effort — the portal
            // still works when a link can't be fetched).
            for (const { schedule, verifiedQbInvoiceId } of sendable) {
                try {
                    if (!(await renewBeforeSideEffect())) return leaseLostResult();
                    const snapshot = await prisma.paymentSchedule.findUnique({
                        where: { id: schedule.id },
                        select: {
                            invoiceId: true,
                            status: true,
                            qbInvoiceId: true,
                            qbCreateGeneration: true,
                            qbInvoiceLink: true,
                            qbSyncError: true,
                        },
                    });
                    if (!snapshot || snapshot.invoiceId !== invoiceId || snapshot.qbInvoiceId !== verifiedQbInvoiceId) {
                        qboLinkRefreshConflict = "A selected milestone changed QuickBooks identity while its payment link was being refreshed; reload before sending.";
                        break;
                    }
                    const liveLink = await getQBInvoicePaymentLink(tokens, verifiedQbInvoiceId);
                    if (liveLink && liveLink !== snapshot.qbInvoiceLink) {
                        const write = await withTxRetry(() => prisma.$transaction(tx => (
                            refreshExistingMilestoneQboStateUnderInvoiceLock(tx, {
                                scheduleId: schedule.id,
                                invoiceId,
                                expectedStatus: snapshot.status,
                                expectedQbInvoiceId: verifiedQbInvoiceId,
                                expectedGeneration: snapshot.qbCreateGeneration,
                                expectedQbInvoiceLink: snapshot.qbInvoiceLink,
                                expectedQbSyncError: snapshot.qbSyncError,
                                payLink: liveLink,
                                providerReachable: true,
                            })
                        )));
                        if (write === "stale") {
                            qboLinkRefreshConflict = "A selected milestone changed while its QuickBooks payment link was being refreshed; reload before sending.";
                            break;
                        }
                    }
                } catch { /* link refresh is best-effort */ }
            }

            if (qboLinkRefreshConflict) {
                for (const { schedule } of sendable) {
                    failedCount++;
                    results.push({
                        id: schedule.id,
                        name: schedule.name,
                        status: "failed",
                        error: qboLinkRefreshConflict,
                    });
                }
                return {
                    success: false,
                    sent: 0,
                    failed: failedCount,
                    skipped: skippedCount,
                    code: "MILESTONE_STATE_CONFLICT",
                    results,
                    error: qboLinkRefreshConflict,
                };
            }

            const emailMilestones = sendable.map(s => ({
                id: s.schedule.id,
                name: s.schedule.name,
                amount: s.effectiveAmount,
            }));
            const liveDeliveryRows = await prisma.paymentSchedule.findMany({
                where: { invoiceId, id: { in: sendable.map(candidate => candidate.schedule.id) } },
                select: {
                    id: true,
                    name: true,
                    amount: true,
                    status: true,
                    qbInvoiceSentAt: true,
                    qbInvoiceId: true,
                    qbInvoiceLink: true,
                    qbSyncError: true,
                },
            });
            const verifiedById = new Map(sendable.map(candidate => [candidate.schedule.id, candidate]));
            if (liveDeliveryRows.length !== sendable.length || liveDeliveryRows.some(row => {
                const verified = verifiedById.get(row.id);
                return !verified
                    || row.qbInvoiceId !== verified.verifiedQbInvoiceId
                    || row.qbSyncError !== null
                    || Math.abs(Number(row.amount) - verified.effectiveAmount) > 0.005
                    || row.status === "Paid"
                    || row.status === "Canceled";
            })) {
                throw new Error("A selected milestone's verified QuickBooks invoice identity or health changed before delivery; review and verify it again.");
            }
            const deliveryMilestoneStates = liveDeliveryRows.map((row): MilestoneAttemptState => ({
                id: row.id,
                name: row.name,
                amount: Number(row.amount),
                status: row.status,
                qbInvoiceSentAt: row.qbInvoiceSentAt?.toISOString() ?? null,
                qbInvoiceId: row.qbInvoiceId!,
                qbInvoiceLink: row.qbInvoiceLink,
                qbSyncError: row.qbSyncError,
            })).sort((a, b) => a.id.localeCompare(b.id));
            const deliveryMilestoneFingerprint = milestoneDeliveryFingerprint(invoiceId, deliveryMilestoneStates);
            let emailFailed = false;
            let recordingError: string | null = null;
            if (automation) {
                try {
                    const candidate = automation.frozenNotification ?? buildMilestoneFrozenNotification({
                        companyName,
                        companyEmail: settings?.email,
                        notificationEmail: settings?.notificationEmail,
                        clientName: invoice.client?.name,
                        projectName: invoice.project?.name,
                        invoiceCode: invoice.code,
                        milestones: emailMilestones,
                        portalUrl: await milestonePortalUrl(invoice, emailMilestones, recipient),
                        recipients,
                    });
                    const delivery = await deliverMilestoneFrozenNotification(
                        candidate,
                        {
                            invoiceId,
                            scheduleIds: emailMilestones.map(milestone => milestone.id),
                            recipient,
                            milestoneFingerprint: deliveryMilestoneFingerprint,
                            milestones: deliveryMilestoneStates,
                        },
                        automation,
                    );
                    emailFailed = !delivery.delivered;
                    deliveredButUnrecorded = delivery.deliveredButUnrecorded === true;
                    deliveryAmbiguous = delivery.deliveryAmbiguous === true;
                    recordingError = delivery.delivered && !delivery.recorded
                        ? (delivery.error || "Email delivered, but durable recording failed — do not resend")
                        : null;
                    if (emailFailed) {
                        for (const { schedule } of sendable) {
                            failedCount++;
                            results.push({
                                id: schedule.id,
                                name: schedule.name,
                                status: "failed",
                                error: delivery.error || "Failed to send request email",
                            });
                        }
                    }
                } catch (emailErr: any) {
                    emailFailed = true;
                    for (const { schedule } of sendable) {
                        failedCount++;
                        results.push({ id: schedule.id, name: schedule.name, status: "failed", error: emailErr?.message || "Failed to prepare request email" });
                    }
                }
            } else {
                try {
                    const prepared = await prisma.$transaction(async tx => {
                        await lockMoneyParents(tx, { estimateId: invoice.estimateId, invoiceId });
                        const existing = await tx.invoiceEmailAttempt.findUnique({ where: { invoiceId } });
                        if (existing) {
                            const payload = existing.kind === "MILESTONE"
                                ? parseMilestoneInvoiceEmailAttemptPayload(existing.payload)
                                : null;
                            if (!payload) throw new Error("Another invoice email has an unresolved outcome; verify it before sending a milestone request.");
                            const adoptionError = manualMilestoneAttemptAdoptionError({
                                requestedIds: emailMilestones.map(milestone => milestone.id),
                                requestedRecipients: recipients,
                                frozenIds: payload.milestoneIds,
                                frozenRecipients: payload.recipients,
                                providerStarted: existing.providerStartedAt !== null,
                            });
                            if (adoptionError) throw new Error(adoptionError);
                            return payload;
                        }

                        const lockedInvoice = await tx.invoice.findUnique({
                            where: { id: invoiceId },
                            include: {
                                project: { include: { client: true } },
                                client: true,
                            },
                        });
                        if (!lockedInvoice) throw new Error("Invoice not found");
                        if (lockedInvoice.estimateId !== invoice.estimateId) {
                            throw new Error("Invoice estimate linkage changed before delivery; review the milestone request again.");
                        }
                        const liveRecipients = canonicalMilestoneRecipients(
                            overrideEmail || lockedInvoice.client?.email || lockedInvoice.project?.client?.email || "",
                            lockedInvoice.client?.additionalEmail || lockedInvoice.project?.client?.additionalEmail || null,
                        );
                        const recipientError = milestoneRecipientConflictError({ expected: recipients, current: liveRecipients });
                        if (recipientError) throw new Error(recipientError);

                        const livePayments = await tx.paymentSchedule.findMany({
                            where: { invoiceId, id: { in: emailMilestones.map(milestone => milestone.id) } },
                            select: {
                                id: true,
                                name: true,
                                amount: true,
                                status: true,
                                qbInvoiceSentAt: true,
                                qbInvoiceId: true,
                                qbInvoiceLink: true,
                                qbSyncError: true,
                            },
                        });
                        const liveById = new Map(livePayments.map(payment => [payment.id, payment]));
                        for (const candidate of sendable) {
                            const live = liveById.get(candidate.schedule.id);
                            if (!live
                                || live.name !== candidate.schedule.name
                                || Math.abs(Number(live.amount) - candidate.effectiveAmount) > 0.005
                                || live.status === "Paid"
                                || live.status === "Canceled"
                                || live.qbInvoiceId !== candidate.verifiedQbInvoiceId
                                || live.qbSyncError !== null) {
                                throw new Error("A selected milestone changed after QuickBooks verification; review the fresh milestone state before sending.");
                            }
                        }
                        const milestoneStates = livePayments.map((payment): MilestoneAttemptState => ({
                            id: payment.id,
                            name: payment.name,
                            amount: Number(payment.amount),
                            status: payment.status,
                            qbInvoiceSentAt: payment.qbInvoiceSentAt?.toISOString() ?? null,
                            qbInvoiceId: payment.qbInvoiceId!,
                            qbInvoiceLink: payment.qbInvoiceLink,
                            qbSyncError: payment.qbSyncError,
                        })).sort((a, b) => a.id.localeCompare(b.id));
                        const portalUrl = await milestonePortalUrl(lockedInvoice, emailMilestones, liveRecipients.to[0] ?? "");
                        const dispatch = buildMilestoneFrozenNotification({
                            companyName,
                            companyEmail: settings?.email,
                            notificationEmail: settings?.notificationEmail,
                            clientName: lockedInvoice.client?.name,
                            projectName: lockedInvoice.project?.name,
                            invoiceCode: lockedInvoice.code,
                            milestones: emailMilestones,
                            portalUrl,
                            recipients: liveRecipients,
                        });
                        const payload: MilestoneInvoiceEmailAttemptPayload = {
                            dispatch,
                            recipients: liveRecipients,
                            overrideEmail: overrideEmail?.trim().toLowerCase() || null,
                            milestoneIds: milestoneStates.map(state => state.id),
                            milestones: milestoneStates,
                            financialFingerprint: milestoneDeliveryFingerprint(invoiceId, milestoneStates),
                            resultMilestones: sendable.map(({ schedule, wasReconciled }) => ({
                                id: schedule.id,
                                name: schedule.name,
                                wasReconciled,
                            })),
                        };
                        await tx.invoiceEmailAttempt.create({
                            data: {
                                invoiceId,
                                kind: "MILESTONE",
                                attemptKey: `invoice-milestone/${invoiceId}/${randomUUID()}`,
                                payload: payload as unknown as Prisma.InputJsonObject,
                                startedAt: new Date(),
                            },
                        });
                        return payload;
                    }, { timeout: 15_000 });
                    const delivery = await deliverManualMilestoneAttempt(invoiceId, recipients);
                    manualDurableDelivery = true;
                    emailFailed = !delivery.delivered;
                    deliveredButUnrecorded = delivery.deliveredButUnrecorded === true;
                    deliveryAmbiguous = delivery.deliveryAmbiguous === true;
                    recordingError = delivery.delivered && !delivery.recorded
                        ? (delivery.error || "Email delivered, but durable recording failed — do not resend")
                        : null;
                    if (emailFailed) throw new Error(delivery.error || `Failed to send frozen payment request for ${prepared.milestoneIds.join(", ")}`);
                } catch (emailErr: any) {
                    emailFailed = true;
                    for (const { schedule } of sendable) {
                        failedCount++;
                        results.push({ id: schedule.id, name: schedule.name, status: "failed", error: emailErr?.message || "Failed to send request email" });
                    }
                }
            }

            // The email left — from here on a failure is a BOOKKEEPING failure and
            // must never be reported as a send failure (that would invite a
            // duplicate resend to the client). Stamp the batch atomically; if the
            // stamp fails, milestones still report "sent" with the recording error
            // attached so staff know to verify, not resend.
            if (!emailFailed) {
                let stampError: string | null = null;
                if (automation) {
                    stampError = recordingError;
                } else if (!manualDurableDelivery) {
                    const stampedAt = new Date();
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
                }
                for (const { schedule, wasReconciled } of sendable) {
                    sentCount++;
                    results.push({
                        id: schedule.id,
                        name: schedule.name,
                        status: wasReconciled ? "reconciled" : "sent",
                        sentTo: recipient,
                        ...(stampError
                            ? {
                                error: automation
                                    ? stampError
                                    : `Email delivered, but recording the send failed (${stampError}) — verify in QuickBooks before resending`,
                            }
                            : {}),
                    });

                    // Log activity per sent milestone (best-effort — never flips a
                    // delivered send to "failed")
                    if (!automation && invoice.projectId) {
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
        if (!automation && !manualDurableDelivery && sentCount > 0 && invoice.status === "Draft") {
            try {
                await prisma.invoice.updateMany({
                    where: { id: invoiceId, status: "Draft" },
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
            ...(deliveredButUnrecorded ? { deliveredButUnrecorded: true } : {}),
            ...(deliveryAmbiguous ? { deliveryAmbiguous: true } : {}),
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

/**
 * Shared target-selection side of createInvoiceFromEstimateCore's Estimate
 * mutex. The SELECT runs only after the lock is granted, so a just-committed
 * estimate invoice wins over the project's older fallback invoice.
 */
export async function findChangeOrderInvoiceUnderEstimateLock(
    tx: Prisma.TransactionClient,
    co: { estimateId: string; projectId: string },
): Promise<CoInvoiceTarget | null> {
    await lockMoneyParents(tx, { estimateId: co.estimateId });
    return findChangeOrderInvoice(tx, co);
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
    // Bind confirmation to every customer-visible backup field, not only the
    // dollars. A note/vendor/date/receipt edit can materially change what the
    // customer receives even when the total stays identical.
    const fingerprintPayload = JSON.stringify({ timeEntries, expenses });
    return {
        laborCents,
        expenseCents,
        markupCents,
        taxCents,
        pretaxCents,
        totalCents: pretaxCents + taxCents,
        fingerprint: createHash("sha256").update(fingerprintPayload).digest("hex"),
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
            termsTaxExempt: true, termsTaxRateName: true, termsTaxRatePercent: true,
            estimate: { select: { taxExempt: true, taxRatePercent: true, taxRateName: true } },
        },
    });
    if (!co) throw new Error("Change order not found");
    if (co.pricingType !== "COST_PLUS") throw new Error(`${co.code} is not a cost-plus change order`);
    if (co.status !== "Approved") throw new Error(`${co.code} must be Approved before actuals can be billed`);
    const invoice = await prisma.$transaction((tx) => findChangeOrderInvoice(tx, co));
    if (!invoice) throw new Error("This project has no invoice yet — create the invoice first, then bill actuals.");
    const markupPercent = co.markupPercent ?? 10;
    const taxInfo = effectiveCoTaxInfo(co, co.estimate);
    const taxRate = coTaxRate(taxInfo);
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
        taxLabel: coTaxLabel(taxInfo),
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
            termsTaxExempt: boolean | null; termsTaxRateName: string | null; termsTaxRatePercent: Prisma.Decimal | null;
        }>>`
            SELECT "id", "code", "title", "status", "pricingType", "markupPercent", "projectId", "estimateId",
                   "termsTaxExempt", "termsTaxRateName", "termsTaxRatePercent"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) throw new Error("Change order not found");
        if (co.pricingType !== "COST_PLUS") throw new Error(`${co.code} is fixed price — use bill_change_order`);
        if (co.status !== "Approved") throw new Error(`${co.code} must be Approved before actuals can be billed`);
        // Always take the same Estimate mutex as invoice creation, then select
        // the target from the post-wait snapshot. This also fences the legacy
        // fallback tax read below.
        const invoice = await findChangeOrderInvoiceUnderEstimateLock(tx, co);
        const estimateTax = co.termsTaxExempt === null
            ? await tx.estimate.findUnique({
                where: { id: co.estimateId },
                select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
            })
            : null;
        if (!invoice) throw new Error("This project has no invoice yet — create the invoice first, then bill actuals.");
        await lockMoneyParents(tx, { invoiceId: invoice.id });
        const markupPercent = co.markupPercent ?? 10;
        const taxInfo = effectiveCoTaxInfo(co, estimateTax);
        const taxRate = coTaxRate(taxInfo);
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
        if (co.termsTaxExempt === null) {
            const frozenTerms = canonicalCoTaxTerms(taxInfo);
            await tx.changeOrder.update({
                where: { id: co.id },
                data: {
                    termsTaxExempt: frozenTerms.taxExempt,
                    termsTaxRateName: frozenTerms.taxRateName,
                    termsTaxRatePercent: frozenTerms.taxRatePercent,
                    revision: { increment: 1 },
                },
            });
        }
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
        const locked = await tx.$queryRaw<Array<{
            id: string; code: string; title: string; status: string; totalAmount: unknown;
            projectId: string; estimateId: string; termsTaxExempt: boolean | null;
            termsTaxRateName: string | null; termsTaxRatePercent: Prisma.Decimal | null;
        }>>`
            SELECT "id", "code", "title", "status", "totalAmount", "projectId", "estimateId",
                   "termsTaxExempt", "termsTaxRateName", "termsTaxRatePercent"
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
        const taxInfo = effectiveCoTaxInfo(co, estimateTax);
        const subtotal = Math.round(Number(co.totalAmount) * 100) / 100;
        const taxAmount = Math.round(subtotal * coTaxRate(taxInfo) * 100) / 100;
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
        return { kind: "created", milestoneId: created.id, milestoneName, amount, subtotal, taxAmount, taxLabel: coTaxLabel(taxInfo), invoiceId: invoice.id, invoiceCode: invoice.code, projectId: co.projectId, coCode: co.code };
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

export function matchExistingChangeOrderMilestones(
    plans: ReadonlyArray<{
        sourceCoScheduleId: string | null;
        name: string;
        totalCents: number;
    }>,
    existing: ReadonlyArray<{
        id: string;
        sourceCoScheduleId: string | null;
        name: string;
        amount: unknown;
    }>,
): { ok: true; existingIds: Array<string | null> } | { ok: false; error: string } {
    const existingIds: Array<string | null> = plans.map(() => null);
    const usedExistingIndexes = new Set<number>();
    const seenPlanSourceIds = new Set<string>();
    const cents = (amount: unknown) => Math.round(Number(amount) * 100);

    // Resolve every durable source identity before considering legacy rows. A
    // same-name legacy milestone must never steal a plan whose exact row is
    // already present later in either array.
    for (const [planIndex, plan] of plans.entries()) {
        if (!plan.sourceCoScheduleId) continue;
        if (seenPlanSourceIds.has(plan.sourceCoScheduleId)) {
            return { ok: false, error: "The signed change-order schedule contains a duplicate source identity. Reconcile it before billing." };
        }
        seenPlanSourceIds.add(plan.sourceCoScheduleId);
        const exactIndexes = existing
            .map((row, index) => ({ row, index }))
            .filter(({ row }) => row.sourceCoScheduleId === plan.sourceCoScheduleId)
            .map(({ index }) => index);
        if (exactIndexes.length > 1) {
            return { ok: false, error: `Multiple existing milestones claim signed schedule ${plan.sourceCoScheduleId}. Reconcile them before billing.` };
        }
        if (exactIndexes.length === 0) continue;
        const existingIndex = exactIndexes[0];
        const row = existing[existingIndex];
        if (cents(row.amount) !== plan.totalCents) {
            return { ok: false, error: `Existing milestone "${row.name}" does not match the signed change-order amount` };
        }
        usedExistingIndexes.add(existingIndex);
        existingIds[planIndex] = row.id;
    }

    // Legacy rows have no durable schedule identity. Match only an unconsumed,
    // unlinked row with the exact frozen display name. Amount can disambiguate
    // distinct same-name plans, but equal-name/equal-amount candidates are not
    // honestly assignable and must stop for reconciliation.
    for (const [planIndex, plan] of plans.entries()) {
        if (existingIds[planIndex]) continue;
        const namedCandidates = existing
            .map((row, index) => ({ row, index }))
            .filter(({ row, index }) => !usedExistingIndexes.has(index)
                && row.sourceCoScheduleId === null
                && row.name === plan.name);
        if (namedCandidates.length === 0) continue;
        const amountCandidates = namedCandidates.filter(({ row }) => cents(row.amount) === plan.totalCents);
        if (amountCandidates.length !== 1) {
            if (namedCandidates.length === 1) {
                return { ok: false, error: `Existing milestone "${namedCandidates[0].row.name}" does not match the signed change-order amount` };
            }
            return { ok: false, error: `Legacy milestones named "${plan.name}" are ambiguous. Reconcile them before retrying automatic billing.` };
        }
        const chosen = amountCandidates[0];
        usedExistingIndexes.add(chosen.index);
        existingIds[planIndex] = chosen.row.id;
    }

    const unexpected = existing.filter((_, index) => !usedExistingIndexes.has(index));
    if (unexpected.length > 0) {
        return {
            ok: false,
            error: "Existing change-order milestones do not match the current signed schedule set. Reconcile the old or extra split rows before billing.",
        };
    }
    if (new Set(existingIds.filter((id): id is string => Boolean(id))).size
        !== existingIds.filter(Boolean).length) {
        return { ok: false, error: "An existing change-order milestone was matched more than once. Reconcile it before billing." };
    }
    return { ok: true, existingIds };
}

export async function billChangeOrderCore(
    changeOrderId: string,
    dependencies: { logActivity?: typeof logActivityLazy; revalidatePath?: typeof revalidatePath } = {},
) {
    const outcome = await withTxRetry(() => prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{
            id: string; code: string; title: string; status: string; pricingType: string;
            totalAmount: unknown; projectId: string; estimateId: string;
            termsTaxExempt: boolean | null; termsTaxRateName: string | null; termsTaxRatePercent: Prisma.Decimal | null;
        }>>`
            SELECT "id", "code", "title", "status", "pricingType", "totalAmount", "projectId", "estimateId",
                   "termsTaxExempt", "termsTaxRateName", "termsTaxRatePercent"
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
        // Always serialize target selection with createInvoiceFromEstimateCore.
        // Its Invoice B either commits before this Estimate lock (and is
        // selected here) or waits until this billing transaction finishes.
        const selectedInvoice = await findChangeOrderInvoiceUnderEstimateLock(tx, co);
        const estimateTax = co.termsTaxExempt === null
            ? await tx.estimate.findUnique({
                where: { id: co.estimateId },
                select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
            })
            : null;
        const taxInfo = effectiveCoTaxInfo(co, estimateTax);
        const totalTaxCents = Math.round(subtotalCents * coTaxRate(taxInfo));
        const existingRefs = await tx.paymentSchedule.findMany({
            where: {
                invoice: { projectId: co.projectId },
                status: { not: "Canceled" },
                OR: [{ sourceChangeOrderId: co.id }, { name: { startsWith: `${co.code} — ` } }],
            },
            select: { invoiceId: true },
        });
        const existingInvoiceIds = [...new Set(existingRefs.map(row => row.invoiceId))];
        if (existingInvoiceIds.length > 1) {
            return {
                ok: false as const,
                error: `Existing ${co.code} milestones are split across multiple invoices. Reconcile them before retrying automatic billing.`,
            };
        }
        // A retry must finish on the same invoice that owns its already-created
        // source milestones. Choosing a newer project invoice here would return
        // a mismatched invoiceId/milestoneIds pair and permanently park CLIENT.
        const invoice = existingInvoiceIds[0]
            ? await tx.invoice.findUnique({
                where: { id: existingInvoiceIds[0] },
                select: { id: true, code: true, status: true },
            })
            : selectedInvoice;
        if (!invoice) return { ok: false as const, error: "This project has no invoice yet — create the invoice first, then bill the change order." };
        await lockMoneyParents(tx, { invoiceId: invoice.id });
        const lockedInvoice = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { status: true } });
        const existing = await tx.paymentSchedule.findMany({
            where: {
                invoice: { projectId: co.projectId },
                status: { not: "Canceled" },
                OR: [{ sourceChangeOrderId: co.id }, { name: { startsWith: `${co.code} — ` } }],
            },
        });
        if (existing.some(row => row.invoiceId !== invoice.id)) {
            return {
                ok: false as const,
                error: `Existing ${co.code} milestones changed invoices while billing. Reload and reconcile them before retrying.`,
            };
        }

        const schedules = await tx.changeOrderPaymentSchedule.findMany({
            where: { changeOrderId },
            orderBy: [{ order: "asc" }, { id: "asc" }],
        });
        const scheduleError = fixedCoScheduleValidationError(subtotalCents, schedules);
        if (scheduleError) return { ok: false as const, error: scheduleError };
        const grossSchedules = allocateCoScheduleGross(subtotalCents / 100, schedules, taxInfo);
        const plans = schedules.length
            ? grossSchedules.map((row) => ({
                sourceCoScheduleId: row.id as string | null,
                name: `${co.code} — ${row.name}`.slice(0, 300),
                dueDate: row.dueDate,
                pretaxCents: row.pretaxCents,
                taxCents: row.taxCents,
                totalCents: row.grossCents,
            }))
            : [{
                sourceCoScheduleId: null as string | null,
                name: `${co.code} — ${co.title}`.slice(0, 300),
                dueDate: null as Date | null,
                pretaxCents: subtotalCents,
                taxCents: totalTaxCents,
                totalCents: subtotalCents + totalTaxCents,
            }];
        const milestones: Array<{
            id: string; name: string; amount: number; pretaxAmount: number; taxAmount: number;
            status: string; created: boolean;
        }> = [];
        let newPretaxCents = 0;
        let newTaxCents = 0;
        let newTotalCents = 0;
        const existingMatch = matchExistingChangeOrderMilestones(plans, existing);
        if (!existingMatch.ok) return existingMatch;
        const existingById = new Map(existing.map((row) => [row.id, row]));
        for (const [planIndex, plan] of plans.entries()) {
            const priorId = existingMatch.existingIds[planIndex];
            const prior = priorId ? existingById.get(priorId) : undefined;
            if (prior) {
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
        if (co.termsTaxExempt === null) {
            const frozenTerms = canonicalCoTaxTerms(taxInfo);
            await tx.changeOrder.update({
                where: { id: co.id },
                data: {
                    termsTaxExempt: frozenTerms.taxExempt,
                    termsTaxRateName: frozenTerms.taxRateName,
                    termsTaxRatePercent: frozenTerms.taxRatePercent,
                    revision: { increment: 1 },
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
            taxLabel: coTaxLabel(taxInfo),
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
    opts?: { notify?: boolean; freshlyApproved?: boolean; suppressClientEmails?: boolean },
    dependencies: {
        billChangeOrder?: typeof billChangeOrderCore;
        sendMilestoneInvoices?: typeof sendMilestoneInvoicesCore;
    } = {},
): Promise<{ billed: boolean; sent: boolean; issues: string[]; awaitingActuals?: boolean; clientEmailSuppressed?: boolean }> {
    const summary: { billed: boolean; sent: boolean; issues: string[]; awaitingActuals?: boolean; clientEmailSuppressed?: boolean } = { billed: false, sent: false, issues: [] };
    let coLabel = changeOrderId;
    let amountLabel = "";
    let projectName = "";
    let sentTo = "";
    // DB-derived, not just the caller's option: a CO that is Approved with no
    // clientSignatureUrl and the manual-approval marker on approvedBy must never
    // email the client, no matter who calls this handler. The explicit
    // opts.suppressClientEmails still ORs in (kept for the inline caller, which
    // reads its own freshly-committed transaction result rather than a stale
    // read) — but this is what protects the cron backstop (co-billing-sweep),
    // which never passes the option at all.
    let isManualApproval = false;
    let manualApprovedBy = "";

    try {
        const co = await prisma.changeOrder.findUnique({
            where: { id: changeOrderId },
            select: { code: true, title: true, totalAmount: true, pricingType: true, markupPercent: true, approvedBy: true, clientSignatureUrl: true, status: true, project: { select: { name: true } } },
        });
        if (co) {
            coLabel = `${co.code} — ${co.title}`;
            amountLabel = formatCurrency(co.totalAmount);
            projectName = co.project?.name ?? "";
            isManualApproval = isManualCoApproval(co);
            manualApprovedBy = staffNameFromManualApprovedBy(co.approvedBy);
        }
        const suppressClientEmails = Boolean(opts?.suppressClientEmails) || isManualApproval;

        if (co?.pricingType === "COST_PLUS") {
            summary.awaitingActuals = true;
            amountLabel = `cost + ${co.markupPercent ?? 10}% + tax`;
        } else {
            const bill = await (dependencies.billChangeOrder ?? billChangeOrderCore)(changeOrderId);
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
            } else if (suppressClientEmails) {
                // Manual staff approval: billing rows/invoice totals are created
                // exactly as on the portal path, but no client ever signed this CO,
                // so no client-facing payment email goes out. Structural flag, not
                // an issue — this is expected behavior for a manual approval, not
                // a problem to surface as a caution.
                summary.billed = true;
                summary.clientEmailSuppressed = true;
            } else {
                summary.billed = true;
                const freshIds = bill.milestones.filter((row) => row.created).map((row) => row.id);
                const send = await (dependencies.sendMilestoneInvoices ?? sendMilestoneInvoicesCore)(bill.invoiceId, freshIds, undefined, undefined, "Auto (change-order approval)");
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
            // Four honest outcomes, not "sent vs. needs a look": a clean manual
            // approval billed correctly with no client email is SUCCESS, not a
            // warning — it never signed anything for the client to begin with.
            // Only a real billing failure (bill.ok === false, still landing in
            // summary.issues with summary.billed left false) earns the ⚠️ bucket.
            const outcomeKind: "awaitingActuals" | "sent" | "manual" | "needsLook" =
                summary.awaitingActuals ? "awaitingActuals"
                : summary.sent ? "sent"
                : (isManualApproval && summary.billed) ? "manual"
                : "needsLook";
            // A schedule failure (pushed to summary.issues above, after billing)
            // must not be hidden behind a clean ✅ subject — summary.issues by this
            // point carries only actual problems (the manual-approval notice is now
            // a structural flag, not an issue), so no filtering is needed.
            const awaitingActualsNeedsLook = outcomeKind === "awaitingActuals" && summary.issues.length > 0;
            const manualNeedsLook = outcomeKind === "manual" && summary.issues.length > 0;
            // The send itself can succeed while a later step in this same call
            // (schedule apply, a partial milestone-send error) still lands in
            // summary.issues — outcomeKind picks "sent" purely off summary.sent,
            // so without this check that CO gets the clean ✅ subject with no
            // hint anything needs a look.
            const sentNeedsLook = outcomeKind === "sent" && summary.issues.length > 0;
            const reviewParagraph = `<p>Review in ProBuild or ChatGPT (list_project_billing shows the state; send_milestone_invoice sends when appropriate).</p>`;
            const subject = {
                awaitingActuals: awaitingActualsNeedsLook
                    ? `⚠️ Change order approved — awaiting actuals, needs a look — ${coLabel} (${amountLabel})`
                    : `Change order approved — awaiting actuals — ${coLabel} (${amountLabel})`,
                sent: sentNeedsLook
                    ? `⚠️ Change order approved & payment link sent — needs a look — ${coLabel} (${amountLabel})`
                    : `✅ Change order approved & payment link sent — ${coLabel} (${amountLabel})`,
                manual: manualNeedsLook
                    ? `⚠️ Change order manually approved — needs a look — ${coLabel} (${amountLabel})`
                    : `✅ Change order manually approved by staff — ${coLabel} (${amountLabel})`,
                needsLook: `⚠️ Change order approved — needs a look — ${coLabel} (${amountLabel})`,
            }[outcomeKind];
            const detail = {
                awaitingActuals: `<p>${isManualApproval ? `Staff (<strong>${esc(manualApprovedBy)}</strong>) manually approved` : "The customer approved"} the cost-plus scope and markup terms. No payment is due yet. Tag actual time and expenses to this change order, then run Bill actuals.</p>${awaitingActualsNeedsLook ? `<ul>${summary.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>${reviewParagraph}` : ""}`,
                sent: `<p>The customer signed and the QuickBooks payment link for <strong>${esc(amountLabel)}</strong> was emailed to <strong>${esc(sentTo)}</strong> automatically.</p>${sentNeedsLook ? `<ul>${summary.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>${reviewParagraph}` : ""}`,
                manual: `<p>${esc(coLabel)} was manually approved by staff${manualApprovedBy ? ` (<strong>${esc(manualApprovedBy)}</strong>)` : ""} — no client ever signed this change order. Billing was created on the invoice as usual.${summary.clientEmailSuppressed ? " No payment email was sent to the client." : ""}</p>${manualNeedsLook ? `<ul>${summary.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>${reviewParagraph}` : ""}`,
                needsLook: isManualApproval
                    ? `<p>Staff${manualApprovedBy ? ` (<strong>${esc(manualApprovedBy)}</strong>)` : ""} manually approved this change order (no client signature), but the automation did not complete cleanly:</p><ul>${summary.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>${reviewParagraph}`
                    : `<p>The customer signed, but no payment email went out automatically:</p><ul>${summary.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>${reviewParagraph}`,
            }[outcomeKind];
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
        expectedRevision?: number;
        expectedTaxFingerprint?: string;
        expectedRecipients?: ChangeOrderRecipientSet;
        previewGeneration?: string;
        sendNotification?: typeof sendNotification;
        sendFrozenNotification?: typeof defaultSendFrozenNotification;
        logActivity?: typeof logActivityLazy;
        revalidatePath?: typeof revalidatePath;
        buildClientPortalUrl?: (clientId: string, email: string, path: string) => Promise<string>;
    } = {},
): Promise<
    | { success: true; sentTo: string; revision: number }
    | { success: false; error: string; code?: "REVISION_CONFLICT" | "TAX_TERMS_CONFLICT" | "RECIPIENT_CONFLICT" }
> {
    // Read and amount math run under the CO lock. The durable REVIEW_EMAIL job
    // performs the actual Draft/Sent -> Sent transition only after its frozen
    // provider delivery succeeds inside a second CO-locked transaction.
    // transaction holding a row lock on the CO (SELECT ... FOR UPDATE, same
    // pattern as billChangeOrderCore): a concurrent writer (editor save,
    // co-audit repair) blocks until commit, so the amount emailed is exactly
    // the amount that was on the row when it was marked Sent. The email
    // itself stays outside the transaction.
    type SendCoOutcome =
        | { kind: "error"; error: string; code?: "REVISION_CONFLICT" | "TAX_TERMS_CONFLICT" | "RECIPIENT_CONFLICT" }
        | {
            kind: "ok";
            code: string; title: string; projectId: string; projectName: string;
            clientId: string; clientName: string; clientEmail: string; additionalEmail: string | null;
            coSubtotal: number; coTaxAmount: number; coRevisedAmount: number; taxLabel: string;
            pricingType: string; markupPercent: number; taxFingerprint: string;
            taxTerms: { taxExempt: boolean; taxRatePercent: number; taxRateName: string | null };
            revision: number;
            schedules: Array<{ name: string; amount: number; dueDate: Date | null }>;
        };
    const outcome = await prisma.$transaction(async (tx): Promise<SendCoOutcome> => {
        const coRef = await tx.changeOrder.findUnique({
            where: { id: changeOrderId },
            select: { projectId: true },
        });
        if (!coRef) return { kind: "error", error: "Change order not found" };
        // Project-scoped workers and parent deletion use Project -> CO -> job.
        // This unlocked routing read is revalidated after both locks are held.
        const [project] = await tx.$queryRaw<Array<{ id: string; name: string; clientId: string | null }>>`
            SELECT "id", "name", "clientId" FROM "Project" WHERE "id" = ${coRef.projectId} FOR SHARE`;
        if (!project) return { kind: "error", error: "Change-order project not found" };
        const locked = await tx.$queryRaw<Array<{
            id: string; code: string; title: string; status: string; pricingType: string;
            markupPercent: number | null; totalAmount: unknown; projectId: string; estimateId: string;
            revision: number; termsTaxExempt: boolean | null; termsTaxRateName: string | null;
            termsTaxRatePercent: Prisma.Decimal | null;
        }>>`
            SELECT "id", "code", "title", "status", "pricingType", "markupPercent", "totalAmount", "projectId", "estimateId",
                   "revision", "termsTaxExempt", "termsTaxRateName", "termsTaxRatePercent"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) return { kind: "error", error: "Change order not found" };
        if (co.projectId !== project.id) {
            return { kind: "error", code: "REVISION_CONFLICT", error: `Change order ${co.code} moved projects — reload before sending.` };
        }
        // Only Draft/Sent may be (re)sent — a CO that flipped to Approved/Declined
        // since the caller checked must not get a signature request.
        if (co.status !== "Draft" && co.status !== "Sent") {
            return { kind: "error", error: `Change order ${co.code} is no longer in a sendable state (now "${co.status}") — refresh and retry.` };
        }
        if (!Number.isInteger(dependencies.expectedRevision) || Number(dependencies.expectedRevision) < 0) {
            return { kind: "error", code: "REVISION_CONFLICT", error: `Change order ${co.code} must be reloaded before it can be sent.` };
        }
        if (co.revision !== dependencies.expectedRevision) {
            return { kind: "error", code: "REVISION_CONFLICT", error: `Change order ${co.code} was modified after this page loaded — reload and review it before sending.` };
        }
        if (typeof dependencies.expectedTaxFingerprint !== "string" || dependencies.expectedTaxFingerprint.length > 500) {
            return { kind: "error", error: `Change order ${co.code} tax terms are invalid — reload and review them before sending.` };
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

        // Lock the remaining recipient owner before comparing the MCP-confirmed set and
        // before transitioning to Sent. A client/contact edit that raced the
        // preview must either commit first (and conflict) or wait until this
        // exact confirmed set is durably attached to the transition.
        const [client] = project?.clientId
            ? await tx.$queryRaw<Array<{ id: string; name: string; email: string | null; additionalEmail: string | null }>>`
                SELECT "id", "name", "email", "additionalEmail"
                FROM "Client" WHERE "id" = ${project.clientId} FOR SHARE`
            : [];
        if (!client?.email) return { kind: "error", error: "Client has no email address" };
        const recipients = canonicalChangeOrderRecipients(client.email, client.additionalEmail);
        if (dependencies.expectedRecipients
            && JSON.stringify(recipients) !== JSON.stringify(dependencies.expectedRecipients)) {
            return {
                kind: "error",
                code: "RECIPIENT_CONFLICT",
                error: `Change order ${co.code} recipients changed after the preview — review the fresh recipient list before sending.`,
            };
        }

        // co.totalAmount is the PRE-TAX subtotal (same semantic as billChangeOrderCore).
        // The email must show the tax-inclusive Revised Amount — the number on the
        // signature page and the number billing will actually charge.
        let terms = co.termsTaxExempt === null
            ? null
            : canonicalCoTaxTerms({
                taxExempt: co.termsTaxExempt,
                taxRateName: co.termsTaxRateName,
                taxRatePercent: co.termsTaxRatePercent,
            });
        const mustSnapshotTerms = co.status === "Draft" || terms === null;
        if (mustSnapshotTerms) {
            // Hold a shared lock through the status+snapshot commit. A tax-only
            // Estimate edit does not bump CO.revision, so an ordinary read here
            // would leave a race between fingerprint validation and snapshot.
            const [estimateTax] = await tx.$queryRaw<Array<{
                taxExempt: boolean; taxRatePercent: Prisma.Decimal | null; taxRateName: string | null;
            }>>`
                SELECT "taxExempt", "taxRatePercent", "taxRateName"
                FROM "Estimate" WHERE "id" = ${co.estimateId} FOR SHARE`;
            terms = canonicalCoTaxTerms(estimateTax);
        }
        if (!terms) {
            return { kind: "error", error: `Change order ${co.code} tax terms could not be resolved.` };
        }
        if (coTaxFingerprint(terms) !== dependencies.expectedTaxFingerprint) {
            return { kind: "error", code: "TAX_TERMS_CONFLICT", error: `Change order ${co.code} tax terms changed after this page loaded — reload and review the exact rate before sending.` };
        }
        const coSubtotal = Math.round(Number(co.totalAmount) * 100) / 100;
        const coTaxAmount = Math.round(coSubtotal * coTaxRate(terms) * 100) / 100;
        const coRevisedAmount = Math.round((coSubtotal + coTaxAmount) * 100) / 100;
        const schedules = await tx.changeOrderPaymentSchedule.findMany({
            where: { changeOrderId },
            orderBy: [{ order: "asc" }, { id: "asc" }],
            select: { name: true, amount: true, dueDate: true },
        });
        if (co.pricingType === "COST_PLUS" && schedules.length > 0) {
            return { kind: "error", error: "Cost-plus change orders cannot have a fixed payment schedule." };
        }
        if (co.pricingType !== "COST_PLUS") {
            const scheduleError = fixedCoScheduleValidationError(storedSubtotalCents, schedules);
            if (scheduleError) return { kind: "error", error: scheduleError };
        }

        const customerSchedules = allocateCoScheduleGross(coSubtotal, schedules, terms);

        return {
            kind: "ok",
            code: co.code, title: co.title, projectId: co.projectId, projectName: project?.name ?? "",
            clientId: client.id, clientName: client.name, clientEmail: client.email, additionalEmail: client.additionalEmail,
            coSubtotal, coTaxAmount, coRevisedAmount, taxLabel: coTaxLabel(terms),
            pricingType: co.pricingType,
            markupPercent: co.markupPercent ?? 10,
            taxFingerprint: coTaxFingerprint(terms),
            taxTerms: terms,
            revision: co.revision,
            schedules: customerSchedules.map((row) => ({ ...row, amount: row.grossCents / 100 })),
        };
    }, { timeout: 15_000 });

    if (outcome.kind === "error") {
        return { success: false, error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) };
    }
    const { code, title, projectId, projectName, coSubtotal, coTaxAmount, coRevisedAmount, taxLabel, pricingType, markupPercent, schedules } = outcome;
    const client = { id: outcome.clientId, name: outcome.clientName, email: outcome.clientEmail, additionalEmail: outcome.additionalEmail };

    const buildPortalUrl = dependencies.buildClientPortalUrl
        ?? (await import("./client-portal-auth")).buildClientPortalUrl;
    const portalUrl = await buildPortalUrl(client.id, client.email, `/portal/change-orders/${changeOrderId}`);
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Your Contractor";

    const changeOrderCc = buildCc(client.email, client.additionalEmail);
    const reviewHtml = `<!DOCTYPE html>
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
        </html>`;
    const internalCopies = (settings?.notificationEmail?.trim() || CLIENT_DOC_COPY_EMAIL)
        .split(",")
        .map(email => email.trim())
        .filter(Boolean);
    const dispatch = buildFrozenNotification({
        to: [client.email],
        subject: `${companyName} sent you a change order to review`,
        html: reviewHtml,
        fromName: companyName,
        replyTo: settings?.email || undefined,
        cc: changeOrderCc,
        bcc: internalCopies,
    });
    const expectedSettings = reviewEmailSettingsExpectation({
        recipients: canonicalChangeOrderRecipients(client.email, client.additionalEmail),
        notificationEmail: settings?.notificationEmail,
        email: settings?.email,
        companyName: settings?.companyName,
    });
    const previewGeneration = dependencies.previewGeneration?.trim() || newChangeOrderReviewGeneration();
    if (previewGeneration.length > 200) {
        return { success: false, error: "Change-order review generation is invalid — reload and try again." };
    }

    let reviewJob: { id: string };
    try {
        reviewJob = await prisma.$transaction(async (tx) => {
            const [locked] = await tx.$queryRaw<Array<{
                status: string;
                revision: number;
                totalAmount: unknown;
            }>>`
                SELECT "status", "revision", "totalAmount"
                FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
            if (!locked || (locked.status !== "Draft" && locked.status !== "Sent")
                || locked.revision !== outcome.revision
                || Math.round(Number(locked.totalAmount) * 100) !== Math.round(coSubtotal * 100)) {
                throw new Error("REVIEW_PREP_REVISION_CONFLICT");
            }
            // CO -> review jobs is the global lock order. This cancels only
            // never-attempted older previews and blocks an ambiguous delivery.
            await prepareChangeOrderReviewJobsForMutation(tx, changeOrderId);
            return enqueueReviewEmailAutomationJob(tx, {
                changeOrderId,
                eventRevision: outcome.revision,
                generationKey: previewGeneration,
                dispatch,
                payload: {
                    expectedRevision: outcome.revision,
                    expectedTaxFingerprint: outcome.taxFingerprint,
                    expectedTaxTerms: outcome.taxTerms,
                    expectedRecipients: canonicalChangeOrderRecipients(client.email, client.additionalEmail),
                    expectedSubtotalCents: Math.round(coSubtotal * 100),
                    companyName,
                    expectedSettings,
                },
            });
        }, { timeout: 15_000 });
    } catch (error) {
        const detail = error instanceof ChangeOrderReviewDeliveryUnresolvedError
            ? error.message
            : `Change order ${code} was modified while the email was being prepared — review it and send again.`;
        return { success: false, code: "REVISION_CONFLICT", error: detail };
    }

    const injectedFrozenSender = dependencies.sendFrozenNotification
        ?? (dependencies.sendNotification
            ? async (frozen: FrozenNotification, _idempotencyKey: string) => {
                const sent = await dependencies.sendNotification!(
                    frozen.to.join(","),
                    frozen.subject,
                    frozen.html,
                    undefined,
                    {
                        fromName: companyName,
                        replyTo: frozen.replyTo,
                        cc: frozen.cc,
                        bcc: frozen.bcc,
                    },
                );
                if (!sent.success) return { success: false as const, ambiguous: false };
                if (!sent.id) return { success: false as const, ambiguous: true };
                return { success: true as const, id: sent.id };
            }
            : undefined);
    await drainChangeOrderAutomationJobs(
        { jobId: reviewJob.id, limit: 1 },
        {
            executeJob: job => executeReviewEmailAutomationJob(job, {
                ...(injectedFrozenSender ? { sendFrozenNotification: injectedFrozenSender } : {}),
            }),
        },
    );
    const finalJob = await prisma.changeOrderAutomationJob.findUnique({
        where: { id: reviewJob.id },
        select: { status: true, result: true, lastError: true },
    });
    const finalResult = finalJob?.result && typeof finalJob.result === "object" && !Array.isArray(finalJob.result)
        ? finalJob.result as Record<string, unknown>
        : null;
    if (finalJob?.status !== "SUCCEEDED") {
        const conflictCode = finalResult?.code;
        const codeValue = conflictCode === "REVISION_CONFLICT"
            || conflictCode === "TAX_TERMS_CONFLICT"
            || conflictCode === "RECIPIENT_CONFLICT"
            ? conflictCode
            : undefined;
        return {
            success: false,
            ...(codeValue ? { code: codeValue } : {}),
            error: typeof finalResult?.error === "string"
                ? finalResult.error
                : (finalJob?.lastError || "The review email is queued for safe retry; the change order remains unsent."),
        };
    }
    const finalRevision = Number(finalResult?.revision);
    if (!Number.isSafeInteger(finalRevision) || finalRevision < 0) {
        return { success: false, error: "Review email delivered but its durable result is incomplete; verify before resending." };
    }

    (dependencies.revalidatePath ?? revalidatePath)(`/projects/${projectId}/change-orders/${changeOrderId}`);
    (dependencies.revalidatePath ?? revalidatePath)(`/projects/${projectId}/change-orders`);
    return { success: true, sentTo: client.email, revision: finalRevision };
}

type ManualMilestoneAttemptResult = {
    delivered: boolean;
    recorded: boolean;
    deliveryAmbiguous?: boolean;
    deliveredButUnrecorded?: boolean;
    error?: string;
    payload?: MilestoneInvoiceEmailAttemptPayload;
};

async function deliverManualMilestoneAttempt(
    invoiceId: string,
    requestedRecipients?: MilestoneRecipientSet,
): Promise<ManualMilestoneAttemptResult> {
    const attemptRef = await prisma.invoiceEmailAttempt.findUnique({
        where: { invoiceId },
        select: { attemptKey: true },
    });
    if (!attemptRef) return { delivered: false, recorded: false, error: "The frozen milestone email attempt no longer exists." };
    const invoiceRef = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
    if (!invoiceRef) return { delivered: false, recorded: false, error: "Invoice not found" };

    const checkpoint = await prisma.$transaction(async tx => {
        await lockMoneyParents(tx, {
            estimateId: invoiceRef.estimateId,
            invoiceId,
            allowInvoiceEmailAttemptKey: attemptRef.attemptKey,
        });
        const row = await tx.invoiceEmailAttempt.findUnique({ where: { invoiceId } });
        const payload = row?.kind === "MILESTONE"
            ? parseMilestoneInvoiceEmailAttemptPayload(row.payload)
            : null;
        if (!row || !payload || row.attemptKey !== attemptRef.attemptKey) {
            return { ok: false as const, error: "The frozen milestone email attempt is missing or invalid; verify delivery before retrying." };
        }
        if (!canRetryProviderAttempt(row.startedAt, new Date())) {
            return { ok: false as const, error: "The frozen milestone email exceeded the provider idempotency window. Verify delivery before any new send." };
        }

        if (!row.providerStartedAt) {
            const liveInvoice = await tx.invoice.findUnique({
                where: { id: invoiceId },
                include: {
                    project: { include: { client: true } },
                    client: true,
                },
            });
            if (!liveInvoice) return { ok: false as const, error: "Invoice not found" };
            // Same first-attempt order as whole-invoice delivery: Estimate ->
            // Invoice -> Client -> CompanySettings. A provider-started retry
            // never enters this branch and remains byte-identically frozen.
            const lockedDestinations = await lockInvoiceDeliveryRecipientSet(tx, {
                clientId: liveInvoice.clientId,
                overrideEmail: payload.overrideEmail,
            });
            const liveRecipients = lockedDestinations.visible;
            const completeRecipientConflict = completeFrozenRecipientConflictError({
                expected: payload.dispatch,
                current: lockedDestinations.complete,
            });
            const recipientConflict = milestoneRecipientConflictError({
                expected: payload.recipients,
                current: liveRecipients,
            });
            const requestedRecipientConflict = milestoneRecipientConflictError({
                expected: payload.recipients,
                current: requestedRecipients ?? payload.recipients,
            });
            const current = await tx.paymentSchedule.findMany({
                where: { invoiceId, id: { in: payload.milestoneIds } },
                select: {
                    id: true,
                    name: true,
                    amount: true,
                    status: true,
                    qbInvoiceSentAt: true,
                    qbInvoiceId: true,
                    qbInvoiceLink: true,
                    qbSyncError: true,
                },
            });
            const currentStates = current.map((payment): MilestoneAttemptState => ({
                id: payment.id,
                name: payment.name,
                amount: Number(payment.amount),
                status: payment.status,
                qbInvoiceSentAt: payment.qbInvoiceSentAt?.toISOString() ?? null,
                qbInvoiceId: payment.qbInvoiceId ?? "",
                qbInvoiceLink: payment.qbInvoiceLink,
                qbSyncError: payment.qbSyncError,
            }));
            const stateConflict = milestoneDeliveryStateConflictError({
                expectedFingerprint: payload.financialFingerprint,
                invoiceId,
                current: currentStates,
            });
            if (completeRecipientConflict || recipientConflict || requestedRecipientConflict
                || current.length !== payload.milestoneIds.length || stateConflict) {
                await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
                return {
                    ok: false as const,
                    error: completeRecipientConflict || recipientConflict || requestedRecipientConflict || stateConflict
                        || "The selected milestone set changed before provider delivery; review it again.",
                };
            }
            await tx.invoiceEmailAttempt.update({
                where: { invoiceId },
                data: { providerStartedAt: new Date() },
            });
        }
        return { ok: true as const, attemptKey: row.attemptKey, payload };
    }, { timeout: 15_000 });
    if (!checkpoint.ok) return { delivered: false, recorded: false, error: checkpoint.error };

    let providerAccepted = false;
    try {
        return await prisma.$transaction(async tx => {
        await lockMoneyParents(tx, {
            estimateId: invoiceRef.estimateId,
            invoiceId,
            allowInvoiceEmailAttemptKey: checkpoint.attemptKey,
        });
        const row = await tx.invoiceEmailAttempt.findUnique({ where: { invoiceId } });
        const payload = row?.kind === "MILESTONE"
            ? parseMilestoneInvoiceEmailAttemptPayload(row.payload)
            : null;
        if (!row || !payload || row.attemptKey !== checkpoint.attemptKey || !row.providerStartedAt) {
            return { delivered: false, recorded: false, error: "The frozen milestone provider checkpoint is missing or invalid; verify delivery before retrying." };
        }
        if (!canRetryProviderAttempt(row.startedAt, new Date())) {
            return { delivered: false, recorded: false, error: "The frozen milestone email exceeded the provider idempotency window. Verify delivery before any new send.", payload };
        }

        const provider = await defaultSendFrozenNotification(payload.dispatch, row.attemptKey);
        if (!provider.success) {
            if (!provider.ambiguous) await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
            return {
                delivered: false,
                recorded: false,
                ...(provider.ambiguous ? { deliveryAmbiguous: true } : {}),
                error: provider.ambiguous
                    ? "Email provider outcome is ambiguous — retry only this frozen milestone attempt/key; do not create a new send."
                    : "Email provider rejected the payment request.",
                payload,
            };
        }
        providerAccepted = true;

        const sentAt = new Date();
        for (const state of payload.milestones) {
            const stamped = await tx.paymentSchedule.updateMany({
                where: {
                    id: state.id,
                    invoiceId,
                    name: state.name,
                    amount: state.amount,
                    status: state.status,
                    qbInvoiceSentAt: state.qbInvoiceSentAt ? new Date(state.qbInvoiceSentAt) : null,
                    qbInvoiceId: state.qbInvoiceId,
                    qbInvoiceLink: state.qbInvoiceLink,
                    qbSyncError: state.qbSyncError,
                },
                data: { qbInvoiceSentAt: sentAt },
            });
            if (stamped.count !== 1) {
                throw new Error("the exact milestone state could not be stamped");
            }
        }
        await tx.invoice.updateMany({
            where: { id: invoiceId, status: "Draft" },
            data: { status: "Issued", issueDate: sentAt },
        });
        await tx.invoiceEmailAttempt.delete({ where: { invoiceId } });
        return { delivered: true, recorded: true, payload };
        }, { timeout: 45_000 });
    } catch (error: any) {
        if (providerAccepted) {
            return {
                delivered: true,
                recorded: false,
                deliveredButUnrecorded: true,
                error: `Email delivered, but atomic milestone bookkeeping failed (${error?.message || "unknown error"}). Keep this frozen attempt and verify delivery; do not resend.`,
                payload: checkpoint.payload,
            };
        }
        return {
            delivered: false,
            recorded: false,
            error: error?.message || "Email provider failed before milestone bookkeeping.",
            payload: checkpoint.payload,
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
                order: index,
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
): Promise<{ success: true; warnings: string[] }> {
    if (!rows.length) throw new Error("At least one milestone row is required");

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
            tokens = await getFreshQBTokens();
        } catch (e) {
            throw new Error(
                `QuickBooks is unreachable (${e instanceof Error ? e.message : "unknown error"}) and this rebalance changes milestones with staged QuickBooks invoices. ` +
                `Nothing was changed — retry when QuickBooks is back, or use "Break QB Link" first.`
            );
        }
        for (const row of preflightChanged) {
            const probe = await probeQBInvoice(tokens, row.qbInvoiceId!);
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
            const {
                getFreshQBTokens,
                pushMilestoneToQuickBooks,
                unlinkQBInvoiceAfterProviderConfirmation,
            } = await import("./quickbooks-payments");
            const tokens = await getFreshQBTokens();
            for (const row of qbAffected) {
                try {
                    const unlinked = await unlinkQBInvoiceAfterProviderConfirmation(
                        prisma,
                        tokens,
                        {
                            paymentScheduleId: row.scheduleId,
                            invoiceId,
                            qbInvoiceId: row.oldQbInvoiceId,
                            deleteInQBO: true,
                        },
                    );
                    if (!unlinked.ok) {
                        warnings.push(`"${row.name}": ${unlinked.error}`);
                        continue;
                    }
                    await pushMilestoneToQuickBooks(row.scheduleId, tokens);
                } catch (e) {
                    warnings.push(`"${row.name}": QuickBooks re-stage failed (${e instanceof Error ? e.message : "unknown error"}) — re-stage it via "QuickBooks Link".`);
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
        if (paymentScheduleHasProviderOrPaymentEvidence(locked)) {
            throw new Error(`This milestone has a QuickBooks invoice staged or create/provider/payment evidence — reconcile or break the authoritative link before deleting.`);
        }
        // ProgressBillingLine.scheduleId is intentionally not a foreign key, so
        // a cascade cannot protect this allocation. Progress-billing writers
        // take the same Invoice lock; checking beneath it prevents either side
        // from creating an orphaned line that could make this money billable a
        // second time.
        const progressBillingAllocation = await tx.progressBillingLine.findFirst({
            where: { scheduleId },
            select: { id: true },
        });
        if (progressBillingAllocation) {
            throw new Error("This milestone is allocated to a progress billing and cannot be deleted. Void or reconcile that billing first.");
        }

        await tx.paymentSchedule.delete({ where: { id: scheduleId } });

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

export function paymentScheduleHasProviderOrPaymentEvidence(row: {
    status?: string | null;
    paidAt?: Date | null;
    paymentDate?: Date | null;
    receiptSentAt?: Date | null;
    lastReminderAt?: Date | null;
    paymentMethod?: string | null;
    referenceNumber?: string | null;
    qbInvoiceId?: string | null;
    qbInvoiceLink?: string | null;
    qbPaymentId?: string | null;
    qbSyncedAt?: Date | null;
    qbInvoiceSentAt?: Date | null;
    qbSyncError?: string | null;
    qbCreateRequestId?: string | null;
    qbCreateFingerprint?: string | null;
    qbCreateStartedAt?: Date | null;
    stripeSessionId?: string | null;
    stripePaymentIntentId?: string | null;
}): boolean {
    return (row.status != null && row.status !== "Pending")
        || Boolean(row.paidAt || row.paymentDate
            || row.receiptSentAt || row.lastReminderAt || row.paymentMethod || row.referenceNumber
            || row.qbInvoiceId || row.qbInvoiceLink || row.qbPaymentId || row.qbSyncedAt
            || row.qbInvoiceSentAt || row.qbSyncError
            || row.qbCreateRequestId || row.qbCreateFingerprint || row.qbCreateStartedAt
            || row.stripeSessionId || row.stripePaymentIntentId);
}

export function invoiceHasAuditEvidence(input: {
    status: string;
    sentAt?: Date | null;
    viewedAt?: Date | null;
    qbInvoiceId?: string | null;
    qbSyncedAt?: Date | null;
    hasEmailAttempt?: boolean;
    progressBillingCount?: number;
    payments: Array<Parameters<typeof paymentScheduleHasProviderOrPaymentEvidence>[0]>;
}): boolean {
    return input.status !== "Draft"
        || Boolean(input.sentAt || input.viewedAt || input.qbInvoiceId || input.qbSyncedAt || input.hasEmailAttempt)
        || (input.progressBillingCount ?? 0) > 0
        || input.payments.some(paymentScheduleHasProviderOrPaymentEvidence);
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
                    { qbInvoiceLink: { not: null } },
                    { qbPaymentId: { not: null } },
                    { qbSyncedAt: { not: null } },
                    { qbInvoiceSentAt: { not: null } },
                    { qbSyncError: { not: null } },
                    { qbCreateRequestId: { not: null } },
                    { qbCreateFingerprint: { not: null } },
                    { qbCreateStartedAt: { not: null } },
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

        // Freeze the exact destructive set under the Invoice lock. Allocation
        // rows use scheduleId as an audit reference without a database FK, so
        // deleting even a Draft billing's schedule would orphan billed money
        // and permit it to be selected again.
        const destructiveSchedules = await tx.paymentSchedule.findMany({
            where: { invoiceId, status: { not: "Paid" } },
            select: { id: true },
        });
        const destructiveScheduleIds = destructiveSchedules.map((schedule) => schedule.id);
        const progressBillingAllocation = destructiveScheduleIds.length > 0
            ? await tx.progressBillingLine.findFirst({
                where: { scheduleId: { in: destructiveScheduleIds } },
                select: { id: true },
            })
            : null;
        if (progressBillingAllocation) {
            throw new Error("Cannot re-split milestones allocated to a progress billing. Void or reconcile that billing first.");
        }

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

        await tx.paymentSchedule.deleteMany({ where: { id: { in: destructiveScheduleIds } } });
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
