import { createHash, createHmac, timingSafeEqual } from "crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createEstimateFromPhases, templateToPhases, CLOSED_PROJECT_STATUSES, CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { getProjectBilling, sendMilestoneInvoicesCore, resendInvoiceCore, createChangeOrderDraft, billChangeOrderCore, sendChangeOrderToClientCore, listReceivables, createInvoiceFromEstimateGuarded } from "@/lib/billing-core";
import { coTaxRate, coTaxLabel } from "@/lib/co-tax";

// MCP connector for ChatGPT (streamable HTTP at POST /api/mcp/mcp).
//
// Lets an external AI assistant draft estimates and push them into ProBuild as
// Draft/Private estimates. Read surface is deliberately small (project + lead
// names, cost codes); the only write is create_estimate.
//
// Auth: shared secret in the query string (?key=<MCP_SECRET>), same
// machine-to-machine pattern as /api/integrations. ChatGPT custom connectors
// offer only OAuth or no-auth, so the secret rides in the connector URL.
// /api/mcp is excluded from the session-redirect matcher in src/proxy.ts.

export const maxDuration = 60;

function textResult(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Two-step confirmation for customer-facing sends: the preview returns an HMAC
// token bound to the EXACT send (ids, recipient, amounts, reconcile map) and a
// short time bucket. The send call must echo it, so a model can't skip the
// preview or confirm something different from what the user saw — if amounts or
// recipient changed since the preview, the token no longer verifies. Tokens are
// stateless (not single-use): within the ~5-10 minute window a replay repeats
// the send (a duplicate email of an already-approved send at worst). True
// single-use would need a server-side token table — revisit if that risk grows.
const PREVIEW_BUCKET_MS = 300_000;
function mintPreviewToken(payload: string): string {
    const bucket = Math.floor(Date.now() / PREVIEW_BUCKET_MS);
    return createHmac("sha256", process.env.MCP_SECRET ?? "").update(`${bucket}:${payload}`).digest("hex").slice(0, 20);
}
function verifyPreviewToken(token: string | undefined, payload: string): boolean {
    if (!token) return false;
    const now = Math.floor(Date.now() / PREVIEW_BUCKET_MS);
    for (const bucket of [now, now - 1]) {
        const expect = createHmac("sha256", process.env.MCP_SECRET ?? "").update(`${bucket}:${payload}`).digest("hex").slice(0, 20);
        const a = Buffer.from(token);
        const b = Buffer.from(expect);
        if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    return false;
}

const phaseItemSchema = z.object({
    name: z.string().min(1).max(300).describe("Line item name, e.g. 'Demo existing cabinets'"),
    description: z.string().max(2000).optional(),
    costCode: z.string().max(50).optional().describe("ProBuild cost code (the 'code' value from get_estimating_codes, e.g. '01-DEMO'). Set on every item."),
    costType: z.string().max(50).optional().describe("ProBuild cost type name from get_estimating_codes, e.g. 'Labor' or 'Material'."),
    quantity: z.number().positive().max(1_000_000).describe("Quantity in the given unit"),
    unit: z.string().max(30).optional().describe("e.g. 'sq ft', 'hours', 'job'"),
    unitCost: z.number().min(0).max(10_000_000).describe("Sell price per unit in USD"),
});

const phaseSchema = z.object({
    phaseName: z.string().min(1).max(300).describe("Phase heading, e.g. 'Demolition'"),
    phaseCode: z.string().max(50).optional().describe("Default cost code for the phase; items without their own costCode inherit it."),
    items: z.array(phaseItemSchema).min(1).max(200),
});

const milestoneSchema = z.object({
    name: z.string().min(1).max(300).describe("e.g. 'Deposit'"),
    percentage: z.number().positive().max(100).describe("Percent of the estimate total; all milestones together must sum to exactly 100"),
});

const handler = createMcpHandler(
    server => {
        server.registerTool(
            "list_projects",
            {
                title: "List ProBuild projects",
                annotations: { readOnlyHint: true },
                description: "List open projects (id, name, client, status). Use the id as create_estimate's projectId.",
                inputSchema: {},
            },
            async () => {
                const projects = await prisma.project.findMany({
                    where: { status: { notIn: CLOSED_PROJECT_STATUSES } },
                    take: 200,
                    orderBy: { createdAt: "desc" },
                    select: { id: true, name: true, status: true, type: true, location: true, client: { select: { name: true } } },
                });
                return textResult(projects.map(p => ({
                    id: p.id, name: p.name, client: p.client?.name ?? null, status: p.status, type: p.type, location: p.location,
                })));
            },
        );

        server.registerTool(
            "list_leads",
            {
                title: "List ProBuild leads",
                annotations: { readOnlyHint: true },
                description: "List open leads (id, name, client, stage). Use the id as create_estimate's leadId when the job has no project yet.",
                inputSchema: {},
            },
            async () => {
                const leads = await prisma.lead.findMany({
                    where: { stage: { notIn: CLOSED_LEAD_STAGES } },
                    take: 200,
                    orderBy: { createdAt: "desc" },
                    select: { id: true, name: true, stage: true, projectType: true, location: true, client: { select: { name: true } } },
                });
                return textResult(leads.map(l => ({
                    id: l.id, name: l.name, client: l.client?.name ?? null, stage: l.stage, projectType: l.projectType, location: l.location,
                })));
            },
        );

        server.registerTool(
            "get_estimating_codes",
            {
                title: "Get ProBuild cost codes and line-item type labels",
                annotations: { readOnlyHint: true },
                description: "Returns the active cost codes (REQUIRED on every line item) and the valid costType labels. costType is just a line label — Labor, Material, Allowance, Subcontractor, Equipment, Other — matching how GTR estimates (allowances + lump-sum labor).",
                inputSchema: {},
            },
            async () => {
                const costCodes = await prisma.costCode.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { code: true, name: true, description: true } });
                // Static labels, not the CostType table — cost types belong to expenses;
                // estimate lines use these labels only, matching the editor's picker.
                return textResult({ costCodes, costTypes: ["Labor", "Material", "Allowance", "Subcontractor", "Equipment", "Other"] });
            },
        );

        server.registerTool(
            "list_templates",
            {
                title: "List GTR estimate templates",
                annotations: { readOnlyHint: true },
                description:
                    "Catalog of GTR's standard estimate templates. Room templates (Kitchen Remodel, Single Room Remodel, Whole House Remodel, Bathroom Remodel) are full production sequences; " +
                    "'… Package' templates are reusable scope blocks (site services, permits, demolition, MEP rough/finish, closeout) for composing custom scopes. " +
                    "ALWAYS start an estimate from these instead of drafting freehand.",
                inputSchema: {},
            },
            async () => {
                const templates = await prisma.estimateTemplate.findMany({
                    take: 100,
                    orderBy: [{ source: "desc" }, { name: "asc" }], // standard library first
                    include: { items: { where: { type: "Section" }, orderBy: { order: "asc" }, select: { name: true } } },
                });
                const counts = await prisma.estimateTemplateItem.groupBy({ by: ["templateId"], _count: { id: true } });
                const countMap = new Map(counts.map(c => [c.templateId, c._count.id]));
                return textResult(templates.map(t => ({
                    name: t.name,
                    source: t.source, // "standard" = curated GTR library, "custom" = saved in-app
                    itemCount: countMap.get(t.id) ?? 0,
                    updatedAt: t.updatedAt.toISOString().slice(0, 10),
                    phases: t.items.map(i => i.name),
                })));
            },
        );

        server.registerTool(
            "get_template",
            {
                title: "Get a GTR estimate template",
                annotations: { readOnlyHint: true },
                description:
                    "Returns a template's full phases + line items (with cost codes, quantities and starting unit costs) in the exact shape create_estimate accepts. " +
                    "Pull it, scale quantities/allowances to the actual job with the user, add or drop phases, then create_estimate.",
                inputSchema: {
                    name: z.string().min(1).max(300).describe("Template name from list_templates (case-insensitive)"),
                },
            },
            async ({ name }) => {
                const result = await templateToPhases(name);
                if (!result.ok) return { ...textResult({ error: result.error }), isError: true };
                return textResult(result);
            },
        );

        server.registerTool(
            "create_estimate",
            {
                title: "Create a draft estimate in ProBuild",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Push a phase-grouped estimate into ProBuild against one project OR one lead. " +
                    "Creates it as Draft/Private for human review — it is not customer-visible until shared. " +
                    "Workflow: get_estimating_codes first, then list_projects or list_leads to resolve the target, then call this once. " +
                    "Returns the ProBuild URL of the new estimate plus warnings for any cost codes that didn't match.",
                inputSchema: {
                    title: z.string().min(1).max(300).describe("Estimate title, e.g. 'Hamilton Kitchen Remodel'"),
                    projectId: z.string().max(50).optional().describe("Target project id from list_projects (omit if using leadId)"),
                    leadId: z.string().max(50).optional().describe("Target lead id from list_leads (omit if using projectId)"),
                    phases: z.array(phaseSchema).min(1).max(50),
                    paymentMilestones: z.array(milestoneSchema).max(20).optional(),
                },
            },
            async args => {
                const result = await createEstimateFromPhases(args);
                if (!result.ok) {
                    return { ...textResult({ error: result.error }), isError: true };
                }
                return textResult(result);
            },
        );

        server.registerTool(
            "list_project_billing",
            {
                title: "List a project's invoices, milestones and estimates",
                annotations: { readOnlyHint: true },
                description:
                    "Billing snapshot for one project: estimates (for change orders), invoices with their payment milestones, per-milestone paid/sent status, and whether the QuickBooks payment link is stale. " +
                    "Use this FIRST to find the right invoiceId / milestone ids / estimateId before send_milestone_invoice, resend_invoice, or create_change_order.",
                inputSchema: {
                    projectId: z.string().max(50).describe("Project id from list_projects"),
                },
            },
            async ({ projectId }) => {
                const billing = await getProjectBilling(projectId);
                if (!billing) return { ...textResult({ error: `No project with id ${projectId}` }), isError: true };
                return textResult(billing);
            },
        );

        server.registerTool(
            "send_milestone_invoice",
            {
                title: "Send payment milestone(s) to the customer via QuickBooks",
                description:
                    "Emails the customer a QuickBooks invoice with a payment link for each selected milestone. TWO-STEP: call without confirmToken to get a preview " +
                    "(what will be sent, to whom, amounts) plus a confirmToken; show the preview to the user, then call again with the confirmToken only after they approve. " +
                    "The token is bound to the exact milestones/recipient/amounts and expires in ~5 minutes. " +
                    "If QuickBooks amounts have drifted, the result returns needsReview + driftReview — show the user the amounts and, if they approve reconciling, " +
                    "get a fresh preview with reconcile: { <milestoneId>: <approved QB total> } and confirm that.",
                inputSchema: {
                    invoiceId: z.string().max(50).describe("Invoice id from list_project_billing"),
                    paymentScheduleIds: z.array(z.string().max(50)).min(1).max(20).describe("Milestone ids from list_project_billing"),
                    overrideEmail: z.string().email().optional().describe("Only to send to a different address than the client on file"),
                    reconcile: z.record(z.string(), z.number()).optional().describe("Only after user approves a drift review: milestoneId -> approved QuickBooks total"),
                    confirmToken: z.string().max(40).optional().describe("Token from the preview response; supplying it executes the send"),
                },
            },
            async ({ invoiceId, paymentScheduleIds, overrideEmail, reconcile, confirmToken }) => {
                const invoice = await prisma.invoice.findUnique({
                    where: { id: invoiceId },
                    include: { client: true, project: { include: { client: true } }, payments: true },
                });
                if (!invoice) return { ...textResult({ error: "Invoice not found" }), isError: true };
                const selected = invoice.payments.filter(p => paymentScheduleIds.includes(p.id));
                const recipient = (overrideEmail || invoice.client?.email || invoice.project?.client?.email || "").trim();

                // Token payload pins ids, recipient, live amounts and the reconcile map —
                // any drift between preview and confirm invalidates the token.
                const payload = JSON.stringify({
                    invoiceId,
                    ids: [...paymentScheduleIds].sort(),
                    recipient,
                    amounts: selected.map(p => [p.id, Number(p.amount)]).sort(),
                    reconcile: Object.entries(reconcile ?? {}).sort(),
                });

                if (!verifyPreviewToken(confirmToken, payload)) {
                    return textResult({
                        preview: true,
                        wouldSend: selected.map(p => ({ id: p.id, name: p.name, amount: Number(p.amount), status: p.status })),
                        recipient: recipient || "(no client email on file — provide overrideEmail)",
                        invoice: { code: invoice.code, status: invoice.status },
                        confirmToken: mintPreviewToken(payload),
                        instruction: "Show this to the user. Call again with this confirmToken ONLY after they explicitly approve.",
                    });
                }
                const result = await sendMilestoneInvoicesCore(invoiceId, paymentScheduleIds, overrideEmail, { reconcile }, "ChatGPT connector");
                return textResult(result);
            },
        );

        server.registerTool(
            "resend_invoice",
            {
                title: "Resend an invoice (refreshes stale payment links)",
                description:
                    "Repairs stale QuickBooks payment links on an invoice's unpaid milestones, then re-emails the customer the invoice with its pay-online portal link " +
                    "(the portal link is minted fresh on every send, so it never goes stale). Fresh QuickBooks pay links are also returned in the result if the user wants to share one directly. " +
                    "Use when a customer says the payment link doesn't work. TWO-STEP: call without confirmToken for a preview + token, then echo the confirmToken after the user approves.",
                inputSchema: {
                    invoiceId: z.string().max(50).describe("Invoice id from list_project_billing"),
                    overrideEmail: z.string().email().optional(),
                    confirmToken: z.string().max(40).optional().describe("Token from the preview response; supplying it executes the send"),
                },
            },
            async ({ invoiceId, overrideEmail, confirmToken }) => {
                const invoice = await prisma.invoice.findUnique({
                    where: { id: invoiceId },
                    include: { client: true, payments: { select: { name: true, amount: true, status: true, qbSyncError: true } } },
                });
                if (!invoice) return { ...textResult({ error: "Invoice not found" }), isError: true };
                const recipient = (overrideEmail || invoice.client?.email || "").trim();

                const payload = JSON.stringify({ invoiceId, recipient, balanceDue: Number(invoice.balanceDue) });
                if (!verifyPreviewToken(confirmToken, payload)) {
                    return textResult({
                        preview: true,
                        invoice: { code: invoice.code, status: invoice.status, total: Number(invoice.totalAmount), balanceDue: Number(invoice.balanceDue) },
                        milestones: invoice.payments.map(p => ({ name: p.name, amount: Number(p.amount), status: p.status, staleLink: !!p.qbSyncError })),
                        recipient: recipient || "(no client email on file — provide overrideEmail)",
                        confirmToken: mintPreviewToken(payload),
                        instruction: "Show this to the user. Call again with this confirmToken ONLY after they explicitly approve.",
                    });
                }
                try {
                    const result = await resendInvoiceCore(invoiceId, overrideEmail);
                    return textResult(result);
                } catch (err: any) {
                    return { ...textResult({ error: err?.message || "Resend failed" }), isError: true };
                }
            },
        );

        server.registerTool(
            "create_change_order",
            {
                title: "Create a draft change order",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Captures a field change order as a DRAFT on a project (attached to one of its estimates — find the estimateId via list_project_billing). " +
                    "Line items follow the same costCode/costType rules as estimates. It is NOT sent to the customer — review and send happen in ProBuild.",
                inputSchema: {
                    projectId: z.string().max(50),
                    estimateId: z.string().max(50).describe("Estimate on the project this change order amends (from list_project_billing)"),
                    title: z.string().min(1).max(300).describe("e.g. 'Add recessed lighting in kitchen'"),
                    description: z.string().max(2000).optional(),
                    items: z.array(z.object({
                        name: z.string().min(1).max(300),
                        description: z.string().max(2000).optional(),
                        costCode: z.string().max(50).optional(),
                        costType: z.string().max(50).optional(),
                        quantity: z.number().positive().max(1_000_000),
                        unitCost: z.number().min(0).max(10_000_000),
                    })).min(1).max(100),
                },
            },
            async args => {
                const result = await createChangeOrderDraft(args);
                if (!result.ok) return { ...textResult({ error: result.error }), isError: true };
                return textResult(result);
            },
        );

        server.registerTool(
            "send_change_order",
            {
                title: "Send a change order to the customer for signature",
                description:
                    "Emails the customer a portal link to review and SIGN a Draft (or re-sends a Sent) change order — they approve or decline on their phone. " +
                    "TWO-STEP: call without confirmToken for a preview + token, show the user what will be sent and to whom, then echo the confirmToken after they approve. " +
                    "Once the customer signs (status Approved), bill_change_order puts it on the invoice.",
                inputSchema: {
                    changeOrderId: z.string().max(50).describe("Change order id from list_project_billing"),
                    confirmToken: z.string().max(40).optional().describe("Token from the preview response; supplying it executes the send"),
                },
            },
            async ({ changeOrderId, confirmToken }) => {
                const co = await prisma.changeOrder.findUnique({
                    where: { id: changeOrderId },
                    select: {
                        code: true, title: true, status: true, totalAmount: true, updatedAt: true,
                        estimate: { select: { taxExempt: true, taxRatePercent: true, taxRateName: true } },
                        project: { select: { name: true, client: { select: { name: true, email: true } } } },
                    },
                });
                if (!co) return { ...textResult({ error: "Change order not found" }), isError: true };
                if (co.status !== "Draft" && co.status !== "Sent") {
                    return { ...textResult({ error: `Change order ${co.code} is "${co.status}" — only Draft or Sent change orders can be (re)sent for signature.` }), isError: true };
                }
                const recipient = co.project?.client?.email ?? "";
                if (!recipient) {
                    return { ...textResult({ error: "The client has no email on file — add one in ProBuild first." }), isError: true };
                }

                // updatedAt in the payload means any edit to the CO between preview
                // and confirm (title, items, totals) invalidates the token.
                const payload = JSON.stringify({ changeOrderId, recipient, code: co.code, title: co.title, total: Number(co.totalAmount), status: co.status, updatedAt: co.updatedAt.toISOString() });
                if (!verifyPreviewToken(confirmToken, payload)) {
                    const subtotal = Number(co.totalAmount);
                    const taxAmount = Math.round(subtotal * coTaxRate(co.estimate) * 100) / 100;
                    return textResult({
                        preview: true,
                        changeOrder: {
                            code: co.code, title: co.title, status: co.status,
                            subtotal,
                            tax: taxAmount,
                            taxTreatment: coTaxLabel(co.estimate),
                            revisedAmountCustomerSigns: Math.round((subtotal + taxAmount) * 100) / 100,
                        },
                        project: co.project?.name,
                        recipient,
                        confirmToken: mintPreviewToken(payload),
                        instruction: "Show this to the user including the tax breakdown — the customer signs (and is later billed) the revised amount. Call again with this confirmToken ONLY after they explicitly approve.",
                    });
                }
                const result = await sendChangeOrderToClientCore(changeOrderId);
                if (!result.success) return { ...textResult({ error: result.error }), isError: true };
                return textResult({ ...result, note: "Customer will sign via the portal link. Once status shows Approved in list_project_billing, use bill_change_order." });
            },
        );

        server.registerTool(
            "send_estimate",
            {
                title: "Send an estimate to the customer",
                annotations: { readOnlyHint: false },
                description:
                    "Emails the customer their estimate with a portal link to review and sign it (signing auto-creates the invoice). Works for project AND lead estimates. " +
                    "TWO-STEP: call without confirmToken for a preview + token; show the user the recipient and total, then echo the confirmToken after they approve. " +
                    "Milestones must sum to the estimate balance or the send is refused with the exact mismatch.",
                inputSchema: {
                    estimateId: z.string().max(50).describe("Estimate id from list_project_billing (or the id create_estimate returned)"),
                    overrideEmail: z.string().email().optional().describe("Only to send to a different address than the client on file"),
                    customMessage: z.string().max(2000).optional().describe("Optional personal note included in the email"),
                    confirmToken: z.string().max(40).optional().describe("Token from the preview response; supplying it executes the send"),
                },
            },
            async ({ estimateId, overrideEmail, customMessage, confirmToken }) => {
                const estimate = await prisma.estimate.findUnique({
                    where: { id: estimateId },
                    select: {
                        code: true, title: true, status: true, totalAmount: true, taxExempt: true,
                        memo: true, termsAndConditions: true, taxRatePercent: true, taxRateName: true,
                        items: { orderBy: { order: "asc" }, select: { id: true, name: true, description: true, quantity: true, unitCost: true, total: true, parentId: true } },
                        paymentSchedules: { orderBy: { order: "asc" }, select: { id: true, name: true, amount: true, percentage: true, dueDate: true, status: true } },
                        project: { select: { name: true, client: { select: { name: true, email: true } } } },
                        lead: { select: { name: true, client: { select: { name: true, email: true } } } },
                    },
                });
                if (!estimate) return { ...textResult({ error: "Estimate not found" }), isError: true };
                const client = estimate.project?.client ?? estimate.lead?.client;
                const recipient = (overrideEmail || client?.email || "").trim();
                if (!recipient) return { ...textResult({ error: "The client has no email on file — add one in ProBuild first, or pass overrideEmail." }), isError: true };

                // sendEstimateToClient auto-repairs the LAST unpaid milestone to make the
                // schedule sum to the balance due. Compute that repair here so the preview
                // discloses it and the token binds it — no silent adjustment on confirm.
                const rc = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
                const schedules = estimate.paymentSchedules;
                const paidSum = schedules.filter(s => s.status === "Paid").reduce((s, m) => s + Number(m.amount), 0);
                const unpaid = schedules.filter(s => s.status !== "Paid");
                const balanceDue = rc(Number(estimate.totalAmount) - paidSum);
                let milestoneRepair: { milestone: string; from: number; to: number } | null = null;
                if (unpaid.length > 0) {
                    const otherUnpaid = unpaid.slice(0, -1).reduce((s, m) => s + Number(m.amount), 0);
                    const last = unpaid[unpaid.length - 1];
                    const correctLast = rc(balanceDue - otherUnpaid);
                    if (correctLast < 0) {
                        // Unrepairable: the other milestones alone already exceed the balance
                        // due. Refuse now with the exact mismatch instead of minting a token
                        // for a send that would fail after the user approves.
                        return {
                            ...textResult({
                                error: `Milestones don't fit the estimate: the unpaid milestones before "${last.name}" already total $${otherUnpaid.toFixed(2)}, but the balance due is $${balanceDue.toFixed(2)}. Fix the milestone amounts in ProBuild before sending.`,
                            }),
                            isError: true,
                        };
                    }
                    if (Math.abs(correctLast - Number(last.amount)) > 0.001) {
                        milestoneRepair = { milestone: last.name, from: Number(last.amount), to: correctLast };
                    }
                }

                // Fingerprint the full customer-visible content (items, milestones,
                // memo/terms, tax, message, pending repair) so ANY edit between preview
                // and confirm invalidates the token — total alone can't mask a change.
                const fingerprint = createHash("sha256").update(JSON.stringify({
                    items: estimate.items.map(i => [i.id, i.name, i.description, i.quantity, Number(i.unitCost), Number(i.total), i.parentId]),
                    schedules: schedules.map(s => [s.id, s.name, Number(s.amount), s.percentage, s.dueDate?.toISOString() ?? null, s.status]),
                    memo: estimate.memo, terms: estimate.termsAndConditions,
                    taxExempt: estimate.taxExempt,
                    taxRatePercent: estimate.taxRatePercent != null ? Number(estimate.taxRatePercent) : null,
                    taxRateName: estimate.taxRateName,
                    customMessage: customMessage ?? null,
                    milestoneRepair,
                })).digest("hex").slice(0, 24);
                const payload = JSON.stringify({ estimateId, recipient, code: estimate.code, total: Number(estimate.totalAmount), status: estimate.status, fingerprint });

                if (!verifyPreviewToken(confirmToken, payload)) {
                    return textResult({
                        preview: true,
                        estimate: { code: estimate.code, title: estimate.title, status: estimate.status, total: Number(estimate.totalAmount), taxExempt: estimate.taxExempt, balanceDue },
                        target: estimate.project?.name ?? estimate.lead?.name,
                        recipient,
                        clientName: client?.name,
                        ...(milestoneRepair ? {
                            milestoneAdjustmentOnSend: `Sending will adjust milestone "${milestoneRepair.milestone}" from $${milestoneRepair.from.toFixed(2)} to $${milestoneRepair.to.toFixed(2)} so the schedule matches the balance due — tell the user.`,
                        } : {}),
                        confirmToken: mintPreviewToken(payload),
                        instruction: "Show this to the user (including any milestone adjustment). Call again with this confirmToken ONLY after they explicitly approve.",
                    });
                }
                const { sendEstimateToClient } = await import("@/lib/actions");
                const result = await sendEstimateToClient(estimateId, undefined, overrideEmail, undefined, customMessage);
                if (!result.success) return { ...textResult({ error: result.error }), isError: true };
                return textResult({ ...result, note: "The customer reviews and signs via the portal link; signing auto-creates the invoice in ProBuild." });
            },
        );

        server.registerTool(
            "create_invoice_from_estimate",
            {
                title: "Create the project invoice from an estimate",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    "Creates the invoice (with its payment milestones) from a project estimate — the prerequisite for billing milestones or change orders on a project that has no invoice yet. " +
                    "Idempotent: if the estimate already has an invoice, that one is returned. Nothing is emailed.",
                inputSchema: {
                    estimateId: z.string().max(50).describe("Estimate id from list_project_billing"),
                },
            },
            async ({ estimateId }) => {
                const result = await createInvoiceFromEstimateGuarded(estimateId);
                if (!result.ok) return { ...textResult({ error: result.error }), isError: true };
                return textResult(result);
            },
        );

        server.registerTool(
            "list_receivables",
            {
                title: "Who owes us money (all projects)",
                annotations: { readOnlyHint: true },
                description:
                    "Accounts receivable across ALL projects: every invoice with a balance due, its unpaid milestones, age in days, and overdue flags (past due date or 30+ days old). " +
                    "Use for 'who owes us money?', 'what's overdue?', 'total outstanding?'.",
                inputSchema: {},
            },
            async () => textResult(await listReceivables()),
        );

        server.registerTool(
            "create_lead",
            {
                title: "Create a lead",
                annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
                description:
                    "Captures a new lead in ProBuild (finds or creates the client; duplicate leads within 24h are deduped). Use when the user meets a prospect in the field. " +
                    "The prospect is NOT emailed; an internal new-lead alert may go to the team.",
                inputSchema: {
                    name: z.string().min(1).max(200).describe("Lead name, e.g. 'Smith kitchen remodel'"),
                    clientName: z.string().min(1).max(200).describe("The prospect's name"),
                    clientEmail: z.string().email().optional(),
                    clientPhone: z.string().max(30).optional(),
                    location: z.string().max(300).optional().describe("City or address"),
                    projectType: z.string().max(100).optional().describe("e.g. Kitchen Remodeling, Bathroom, ADU"),
                    message: z.string().max(2000).optional().describe("Notes about the job"),
                },
            },
            async args => {
                const { createLead } = await import("@/lib/actions");
                const lead = await createLead(args);
                // Client matching is by exact name — if the caller supplied contact info
                // that differs from what's on the matched client, surface it so a
                // same-name collision doesn't silently attach to the wrong person.
                const created = await prisma.lead.findUnique({
                    where: { id: lead.id },
                    select: { client: { select: { name: true, email: true, primaryPhone: true } } },
                });
                const warnings: string[] = [];
                if (args.clientEmail) {
                    if (!created?.client?.email) {
                        warnings.push(`Matched existing client "${created?.client?.name}" who has NO email on file — the provided email (${args.clientEmail}) was NOT saved. Add it on the client record in ProBuild if it's them.`);
                    } else if (created.client.email.toLowerCase() !== args.clientEmail.toLowerCase()) {
                        warnings.push(`Attached to existing client "${created.client.name}" whose email on file is ${created.client.email}, not ${args.clientEmail} — verify it's the same person (the provided email was NOT saved).`);
                    }
                }
                if (args.clientPhone) {
                    const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
                    if (!created?.client?.primaryPhone) {
                        warnings.push(`Matched client has no phone on file — the provided phone was NOT saved; add it in ProBuild if it's them.`);
                    } else if (digits(created.client.primaryPhone) !== digits(args.clientPhone)) {
                        warnings.push(`Existing client's phone on file (${created.client.primaryPhone}) differs from the one provided — verify it's the same person.`);
                    }
                }
                return textResult({
                    leadId: lead.id,
                    url: `https://probuild.goldentouchremodeling.com/leads/${lead.id}`,
                    warnings,
                    note: "Lead created (or matched to an identical lead from the last 24h).",
                });
            },
        );

        server.registerTool(
            "bill_change_order",
            {
                title: "Bill an approved change order",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    "Adds an APPROVED change order to the project's invoice as a new payment milestone (idempotent — a CO can only be billed once). " +
                    "Nothing is emailed by this tool; it returns the milestone id so you can then run send_milestone_invoice (preview → user approval → confirm) " +
                    "to email the customer the QuickBooks payment link. Find change order ids and statuses via list_project_billing.",
                inputSchema: {
                    changeOrderId: z.string().max(50).describe("Change order id from list_project_billing (status must be Approved)"),
                },
            },
            async ({ changeOrderId }) => {
                const result = await billChangeOrderCore(changeOrderId);
                if (!result.ok) return { ...textResult({ error: result.error }), isError: true };
                return textResult(result);
            },
        );
    },
    {
        serverInfo: { name: "probuild", version: "1.4.0" },
        capabilities: { tools: {} },
        instructions:
            "ProBuild is Golden Touch Remodeling's construction management system. " +
            "TEMPLATE-FIRST workflow for estimates: 1) list_templates, 2) get_template for the closest room template (or compose from the '… Package' scope blocks), " +
            "3) scale quantities, allowances and prices to the actual job with the user — template numbers are starting points, " +
            "4) confirm the target with list_projects / list_leads, 5) create_estimate. " +
            "Every line item needs a costCode from get_estimating_codes. costType is just a line label (Labor / Material / Allowance / Subcontractor / Equipment / Other) — " +
            "the user estimates with allowances and lump-sum labor, so keep those labels accurate. " +
            "All prices are USD sell prices. Estimates arrive as private drafts for review in ProBuild. " +
            "ESTIMATE lifecycle: create_estimate (draft) → send_estimate (preview + user approval; customer signs via portal, which auto-creates the invoice). " +
            "If a project needs an invoice without a signed estimate, create_invoice_from_estimate. list_receivables answers 'who owes us money?' across all projects. " +
            "create_lead captures field prospects. " +
            "BILLING: list_project_billing shows a project's invoices/milestones/estimates. send_milestone_invoice, resend_invoice and send_estimate EMAIL THE CUSTOMER — " +
            "always run the preview step, show the user exactly what will be sent and to whom, and only echo back the preview's confirmToken after their explicit approval. Never self-confirm. " +
            "Change-order lifecycle: create_change_order (draft) → send_change_order (preview + user approval; customer signs via portal) → " +
            "once Approved, bill_change_order puts it on the invoice → send_milestone_invoice emails the payment link. " +
            "QuickBooks is handled server-side; never ask the user for QuickBooks credentials.",
    },
    { basePath: "/api/mcp", maxDuration: 60 },
);

// Shared-secret gate. Hash both sides to a fixed length before the timing-safe
// compare so neither content nor secret length leaks through timing.
function authorized(req: Request): boolean {
    const secret = process.env.MCP_SECRET;
    if (!secret) return false;
    const key = new URL(req.url).searchParams.get("key") ?? "";
    const a = createHash("sha256").update(key).digest();
    const b = createHash("sha256").update(secret).digest();
    return timingSafeEqual(a, b);
}

function guarded(req: Request) {
    if (!process.env.MCP_SECRET) {
        return Response.json({ error: "MCP connector not configured" }, { status: 503 });
    }
    if (!authorized(req)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
