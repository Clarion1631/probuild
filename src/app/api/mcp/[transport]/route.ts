import { createHash, createHmac, timingSafeEqual } from "crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createEstimateFromPhases, updateEstimateFromPhases, templateToPhases, estimateToPhases, CLOSED_PROJECT_STATUSES, CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { getProjectBilling, sendMilestoneInvoicesCore, resendInvoiceCore, createChangeOrderDraft, billChangeOrderCore, sendChangeOrderToClientCore, listReceivables, createInvoiceFromEstimateGuarded } from "@/lib/billing-core";
import { getCompanyPipeline, getStartCalendar, setProjectStartDate, parseStartDateInput, generateScheduleFromEstimate, setProjectCrew, getCrewConflicts } from "@/lib/schedule-core";
import { coTaxRate, coTaxLabel } from "@/lib/co-tax";
import { ALLOWED_FILE_EXTENSIONS, fileExtension, mimeTypeForFileName, saveProjectFile } from "@/lib/project-files";

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
    quantity: z.number().min(0).max(1_000_000).describe("Quantity in the given unit. 0 is allowed and marks an optional/alternate line shown at $0 — it adds nothing to the estimate total."),
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
            "find_job",
            {
                title: "Find a job (lead or project) and its estimates by name",
                annotations: { readOnlyHint: true },
                description:
                    "Search leads AND projects by name or client — INCLUDING closed/won ones that list_leads and list_projects omit — plus any estimate by its code (e.g. 'EST-00145'). " +
                    "Use this when you know the job or estimate by name/number but don't know whether it's still a lead or already a project (a won lead becomes a project). " +
                    "Each hit includes its estimates (code, title, status, total) so you can go straight to get_estimate / update_estimate / list_project_billing.",
                inputSchema: {
                    query: z.string().trim().min(1).max(200).describe("Job name, client name, or estimate code to search for"),
                },
            },
            async ({ query }) => {
                const like = { contains: query.trim(), mode: "insensitive" as const };
                const estSelect = { select: { id: true, code: true, title: true, status: true, totalAmount: true }, orderBy: { createdAt: "desc" as const } };
                const [projects, leads, estimates] = await Promise.all([
                    prisma.project.findMany({
                        where: { OR: [{ name: like }, { client: { name: like } }] },
                        take: 15,
                        orderBy: { createdAt: "desc" },
                        select: { id: true, name: true, status: true, type: true, location: true, client: { select: { name: true } }, estimates: estSelect },
                    }),
                    prisma.lead.findMany({
                        where: { OR: [{ name: like }, { client: { name: like } }] },
                        take: 15,
                        orderBy: { createdAt: "desc" },
                        select: { id: true, name: true, stage: true, projectType: true, location: true, client: { select: { name: true } }, estimates: estSelect },
                    }),
                    prisma.estimate.findMany({
                        where: { code: like },
                        take: 15,
                        orderBy: { createdAt: "desc" },
                        select: { id: true, code: true, title: true, status: true, totalAmount: true, project: { select: { id: true, name: true } }, lead: { select: { id: true, name: true } } },
                    }),
                ]);
                const mapEstimates = (es: { id: string; code: string; title: string; status: string; totalAmount: unknown }[]) =>
                    es.map(e => ({ estimateId: e.id, code: e.code, title: e.title, status: e.status, total: Number(e.totalAmount) }));
                return textResult({
                    projects: projects.map(p => ({
                        type: "project", projectId: p.id, name: p.name, client: p.client?.name ?? null,
                        status: p.status, projectType: p.type, location: p.location, estimates: mapEstimates(p.estimates),
                    })),
                    leads: leads.map(l => ({
                        type: "lead", leadId: l.id, name: l.name, client: l.client?.name ?? null,
                        stage: l.stage, projectType: l.projectType, location: l.location, estimates: mapEstimates(l.estimates),
                    })),
                    estimatesByCode: estimates.map(e => ({
                        estimateId: e.id, code: e.code, title: e.title, status: e.status, total: Number(e.totalAmount),
                        on: e.project ? { type: "project", projectId: e.project.id, name: e.project.name }
                            : e.lead ? { type: "lead", leadId: e.lead.id, name: e.lead.name } : null,
                    })),
                    note: projects.length + leads.length + estimates.length === 0
                        ? `Nothing matched "${query}". Try a shorter or different term (client last name, or the estimate code).`
                        : "Matches include closed/won jobs. Use projectId/leadId with the estimate tools.",
                });
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
            "get_estimate",
            {
                title: "Read an existing estimate's full line items",
                annotations: { readOnlyHint: true },
                description:
                    "Returns an existing estimate's phases, line items (with cost codes, quantities, unit costs) and payment milestones — the editable detail list_project_billing omits. " +
                    "Use to REVISE: read it here, then either update_estimate it in place, or create_estimate a new draft from the adjusted items.",
                inputSchema: {
                    estimate: z.string().min(1).max(50).describe("Estimate code (e.g. 'EST-00145') or id from list_project_billing"),
                },
            },
            async ({ estimate }) => {
                const result = await estimateToPhases(estimate);
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
            "update_estimate",
            {
                title: "Edit an existing (unsigned) estimate in place",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Revise an EXISTING estimate that the customer hasn't committed to yet — only Draft or Sent (unsigned, not-yet-invoiced) estimates. " +
                    "Refuses once it's signed/Approved or already has an invoice (use a change order for those). " +
                    "Workflow: get_estimate to read the current items, adjust, then call this. " +
                    "Pass `phases` to REPLACE all line items (totals + milestone amounts recompute automatically); " +
                    "pass tax fields (taxExempt, or taxRateName + taxRatePercent — e.g. change the tax jurisdiction from Vancouver to Camas) to reprice tax; " +
                    "pass title / memo / termsAndConditions to edit those. Only the fields you send change. " +
                    "paymentMilestones may only be sent together with phases. After editing, send_estimate to (re)deliver it.",
                inputSchema: {
                    estimate: z.string().min(1).max(50).describe("Estimate code (e.g. 'EST-00317') or id from get_estimate / list_project_billing"),
                    title: z.string().min(1).max(300).optional(),
                    phases: z.array(phaseSchema).min(1).max(50).optional().describe("If provided, REPLACES every line item on the estimate"),
                    paymentMilestones: z.array(milestoneSchema).max(20).optional().describe("Only valid together with phases; percentages must sum to 100"),
                    taxExempt: z.boolean().optional().describe("Mark the estimate tax-exempt (adds no tax) or clear it"),
                    taxRateName: z.string().max(100).nullable().optional().describe("Tax jurisdiction label shown to the customer, e.g. 'Camas'"),
                    taxRatePercent: z.number().min(0).max(30).nullable().optional().describe("Sales tax percent for that jurisdiction, e.g. 8.4"),
                    memo: z.string().max(5000).optional(),
                    termsAndConditions: z.string().max(20000).optional(),
                },
            },
            async args => {
                const result = await updateEstimateFromPhases(args);
                if (!result.ok) return { ...textResult({ error: result.error }), isError: true };
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
                title: "Send payment milestone(s) to the customer",
                description:
                    "Emails the customer a payment request listing ONLY the selected milestones (name + amount, never the whole invoice balance), with a portal link " +
                    "that opens their invoice focused on exactly those payments and a Pay Now button. QuickBooks is still the money rail: each milestone is pushed/verified " +
                    "against QBO before anything is emailed. TWO-STEP: call without confirmToken to get a preview " +
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
                const result = await sendMilestoneInvoicesCore(invoiceId, paymentScheduleIds, overrideEmail, { reconcile }, "ChatGPT connector", `mcp:${confirmToken}`);
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
                const result = await sendEstimateToClient(
                    estimateId,
                    undefined,
                    overrideEmail,
                    undefined,
                    customMessage,
                    undefined,
                    process.env.MCP_SECRET,
                );
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

        server.registerTool(
            "upload_file",
            {
                title: "Upload a document to a job's Files tab",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Parks a document (RFQ, RFI, spec sheet, spreadsheet, photo) on a project's or lead's Files tab in ProBuild. " +
                    "Send the file's raw bytes base64-encoded — max ~3 MB per file; larger files must be uploaded in ProBuild directly. " +
                    "Files are INTERNAL by default; visibility 'shared' makes the file visible to the CUSTOMER in their portal — only use it when the user explicitly asks. " +
                    "Optionally group files into a named top-level folder (created if it doesn't exist, e.g. 'RFQs').",
                inputSchema: {
                    projectId: z.string().max(50).optional().describe("Target project id from list_projects / find_job (omit if using leadId)"),
                    leadId: z.string().max(50).optional().describe("Target lead id from list_leads / find_job (omit if using projectId)"),
                    fileName: z.string().min(1).max(200).describe("File name WITH extension, e.g. 'RFQ-plumbing-sub.pdf'. Allowed: pdf, doc/docx, xls/xlsx, csv, jpg/png/gif/webp/heic, txt, rtf, dwg, dxf"),
                    contentBase64: z.string().min(1).max(4_400_000).describe("The file's raw bytes, standard base64-encoded (no data: URL prefix). Max ~3 MB decoded."),
                    folder: z.string().max(120).optional().describe("Optional top-level folder name on the job's Files tab, e.g. 'RFQs' — found case-insensitively or created"),
                    visibility: z.enum(["team", "shared"]).optional().describe("'team' = internal only (default); 'shared' = the customer sees it in their portal"),
                },
            },
            async ({ projectId, leadId, fileName, contentBase64, folder, visibility }) => {
                if ((projectId ? 1 : 0) + (leadId ? 1 : 0) !== 1) {
                    return { ...textResult({ error: "Provide exactly one of projectId or leadId (use find_job / list_projects / list_leads to resolve the target)." }), isError: true };
                }
                const ext = fileExtension(fileName);
                if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
                    return { ...textResult({ error: `File type "${ext || "(no extension)"}" not allowed. Allowed: ${[...ALLOWED_FILE_EXTENSIONS].join(", ")}.` }), isError: true };
                }
                // Closed/won jobs are accepted on purpose — find_job surfaces them and
                // parking documents on a finished job is a normal filing action.
                let targetProjectId: string | null = projectId ?? null;
                let targetLeadId: string | null = leadId ?? null;
                let movedToProjectNote: string | null = null;
                if (targetProjectId) {
                    const project = await prisma.project.findUnique({ where: { id: targetProjectId }, select: { id: true } });
                    if (!project) return { ...textResult({ error: `No project with id ${targetProjectId}. Use find_job or list_projects.` }), isError: true };
                } else {
                    const lead = await prisma.lead.findUnique({ where: { id: targetLeadId! }, select: { id: true } });
                    if (!lead) return { ...textResult({ error: `No lead with id ${targetLeadId}. Use find_job or list_leads.` }), isError: true };
                    // A won lead becomes a project, and the customer portal only reads
                    // project-owned folders — a "shared" folder filed on the lead would
                    // be unreachable. Normalize converted leads to their project.
                    const linkedProject = await prisma.project.findFirst({ where: { leadId: targetLeadId! }, select: { id: true, name: true } });
                    if (linkedProject) {
                        movedToProjectNote = `This lead was already converted to project "${linkedProject.name}" — the file was filed on the project.`;
                        targetProjectId = linkedProject.id;
                        targetLeadId = null;
                    }
                }

                const b64 = contentBase64.replace(/\s+/g, "");
                if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
                    return { ...textResult({ error: "contentBase64 is not valid base64 — send the file's raw bytes standard-base64-encoded, without a data: URL prefix." }), isError: true };
                }
                const buffer = Buffer.from(b64, "base64");
                if (buffer.length === 0) {
                    return { ...textResult({ error: "contentBase64 decoded to 0 bytes." }), isError: true };
                }
                const MAX_UPLOAD_BYTES = 3_300_000; // stays under Vercel's 4.5 MB request cap after base64 expansion
                if (buffer.length > MAX_UPLOAD_BYTES) {
                    return { ...textResult({ error: `File is ${(buffer.length / 1_000_000).toFixed(1)} MB — the connector accepts up to ~3 MB. Upload larger files in ProBuild directly.` }), isError: true };
                }

                // Always store an EXPLICIT visibility (never null/inherit): the portal
                // shows null-visibility files inside shared folders, so inheriting
                // could silently expose a file this tool just reported as internal.
                const fileVisibility = visibility ?? "team";

                let folderId: string | null = null;
                const folderName = folder?.trim();
                if (folderName) {
                    const scope = { projectId: targetProjectId, leadId: targetLeadId, parentId: null };
                    const existing = await prisma.fileFolder.findFirst({
                        where: { ...scope, name: { equals: folderName, mode: "insensitive" } },
                        select: { id: true, name: true, visibility: true },
                    });
                    // The portal only traverses SHARED folders — a shared file inside a
                    // team folder would be unreachable by the customer. Refuse the
                    // combination rather than silently flipping an existing folder to
                    // shared (that would expose everything already in it).
                    if (existing && fileVisibility === "shared" && existing.visibility !== "shared") {
                        return { ...textResult({ error: `Folder "${existing.name}" is not a shared folder, so the customer could never see a shared file inside it. Upload the shared file without a folder, use a folder that is already shared, or drop visibility to keep it internal.` }), isError: true };
                    }
                    folderId = existing
                        ? existing.id
                        // A folder created for a shared upload is created shared (it
                        // contains only what this tool puts in it); otherwise team.
                        : (await prisma.fileFolder.create({ data: { name: folderName, ...scope, visibility: fileVisibility === "shared" ? "shared" : "team" }, select: { id: true } })).id;
                }

                const saved = await saveProjectFile({
                    buffer,
                    fileName,
                    mimeType: mimeTypeForFileName(fileName),
                    projectId: targetProjectId,
                    leadId: targetLeadId,
                    folderId,
                    visibility: fileVisibility,
                });
                if (!saved.ok) return { ...textResult({ error: saved.error }), isError: true };

                const filesUrl = targetProjectId
                    ? `https://probuild.goldentouchremodeling.com/projects/${targetProjectId}/files`
                    : `https://probuild.goldentouchremodeling.com/leads/${targetLeadId}/files`;
                return textResult({
                    fileId: saved.file.id,
                    name: saved.file.name,
                    sizeBytes: saved.file.size,
                    folder: folderName ?? null,
                    visibility: fileVisibility,
                    url: filesUrl,
                    ...(movedToProjectNote ? { movedToProject: movedToProjectNote } : {}),
                    note: fileVisibility === "shared"
                        ? "This file IS visible to the customer (in the client portal, once the job has a project with the portal's Files section enabled)."
                        : "Internal file — the customer cannot see it.",
                });
            },
        );

        server.registerTool(
            "get_company_schedule",
            {
                title: "Company pipeline and upcoming project starts",
                annotations: { readOnlyHint: true },
                description:
                    "The company-wide book of work: pipeline counts (estimating / waiting to start / scheduled / in progress), " +
                    "the waiting-to-start list, and project + lead starts coming up in the next N days (default 90). " +
                    "Answers 'what jobs are waiting to start?' and 'show project starts for August'. Read surface stays lean — no milestone amounts.",
                inputSchema: {
                    days: z.number().int().min(1).max(365).optional().describe("How many days ahead to list upcoming starts (default 90)"),
                },
            },
            async ({ days }) => {
                const horizonDays = days ?? 90;
                const now = new Date();
                const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
                // getStartCalendar's `to` is exclusive, so from + N days lists
                // exactly N calendar days (today through today+N-1).
                const to = new Date(from.getTime() + horizonDays * 86_400_000);
                const [pipeline, calendar, crewConflicts] = await Promise.all([
                    getCompanyPipeline(),
                    getStartCalendar(from, to, { includeFinancials: false }),
                    getCrewConflicts(from, to),
                ]);
                // Crew per project (ids + names) — joined onto the start list too.
                const crewOf = new Map<string, { id: string; name: string }[]>();
                for (const p of [...pipeline.waitingToStart, ...pipeline.scheduled, ...pipeline.inProgress, ...pipeline.substantialCompletion]) {
                    crewOf.set(p.id, p.crew);
                }
                return textResult({
                    pipeline: {
                        estimating: pipeline.estimating.length,
                        waitingToStart: pipeline.waitingToStart.length,
                        scheduled: pipeline.scheduled.length,
                        inProgress: pipeline.inProgress.length,
                        substantialCompletion: pipeline.substantialCompletion.length,
                    },
                    waitingToStart: pipeline.waitingToStart.map(p => ({
                        projectId: p.id, name: p.name, client: p.client, contractValue: p.contractValue, crew: p.crew,
                    })),
                    upcomingStarts: {
                        windowDays: horizonDays,
                        projects: calendar.projectStarts.map(p => ({
                            projectId: p.id, name: p.name, client: p.client, status: p.status, startDate: p.startDate.slice(0, 10),
                            crew: crewOf.get(p.id) ?? [],
                        })),
                        leads: calendar.leadStarts.map(l => ({
                            leadId: l.id, name: l.name, client: l.client, stage: l.stage, expectedStartDate: l.expectedStartDate.slice(0, 10),
                        })),
                    },
                    // Double-booked crew from project windows (startDate →
                    // endDate ?? latest task end ?? startDate+1d, half-open).
                    crewConflicts,
                });
            },
        );

        server.registerTool(
            "set_project_start_date",
            {
                title: "Move (or clear) a project's company start date",
                description:
                    "Sets the project start marker shown on the company dashboard. For a project still 'Waiting to Start' that already " +
                    "had a start date, the whole job plan moves with it: every schedule task shifts by the same delta and linked payment " +
                    "milestones shift on both mirrors (estimate + invoice side) — EXCEPT any milestone group already pushed to QuickBooks, " +
                    "which is skipped entirely and reported in skippedQbMilestones for manual/QB-side fixing. In-progress projects only move " +
                    "the marker (tasks never shift). Closed projects are refused. Pass startDate null to clear the marker (tasks untouched). " +
                    "Internal and reversible — no customer email, no preview token needed.",
                inputSchema: {
                    projectId: z.string().max(50).describe("Project id from get_company_schedule or list_projects"),
                    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD (no time component)").nullable().describe("New start date as YYYY-MM-DD; null clears the start marker"),
                    shiftJobTasks: z.boolean().optional().describe("Shift the job's tasks and linked milestones by the same delta (default true)"),
                },
            },
            async ({ projectId, startDate, shiftJobTasks }) => {
                try {
                    const result = await setProjectStartDate({
                        projectId,
                        startDate: startDate === null ? null : parseStartDateInput(startDate),
                        shiftJobTasks: shiftJobTasks ?? true,
                        actor: { type: "SYSTEM", name: "ChatGPT connector" },
                    });
                    return textResult(result);
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to set project start date" }), isError: true };
                }
            },
        );

        server.registerTool(
            "generate_project_schedule",
            {
                title: "Generate a project's schedule from its estimate",
                description:
                    "Builds the job's schedule from an estimate: phase parent tasks with children (or flat tasks for phase-less " +
                    "estimates) apportioned across the project window by labor-dollar share, plus milestone tasks — and links the " +
                    "payment milestones to them. Preconditions: the estimate must be Approved, Invoiced, Partially Paid, or Paid, " +
                    "owned by a PROJECT (not a lead), and the project must have a start date first (set_project_start_date). " +
                    "mode 'merge' (default) skips items already task-linked; 'regenerate' deletes untouched generated tasks and rebuilds. " +
                    "Idempotent — safe to re-run.",
                inputSchema: {
                    estimateId: z.string().max(50).describe("Estimate id (from find_job or list_project_billing) — must be Approved+ and on a project with a start date"),
                    mode: z.enum(["merge", "regenerate"]).optional().describe("'merge' (default) fills gaps; 'regenerate' rebuilds untouched generated tasks"),
                },
            },
            async ({ estimateId, mode }) => {
                try {
                    const result = await generateScheduleFromEstimate({
                        estimateId,
                        mode: mode ?? "merge",
                        actor: { type: "SYSTEM", name: "ChatGPT connector" },
                    });
                    return textResult(result);
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to generate schedule" }), isError: true };
                }
            },
        );

        server.registerTool(
            "assign_project_crew",
            {
                title: "Assign crew to a project (idempotent replace)",
                description:
                    "Replaces the project's crew with exactly the given user ids (connect/disconnect diff — re-running with the " +
                    "same list is a no-op). Every id must be an ACTIVATED team member. Crew drives the company-calendar chips and " +
                    "the crewConflicts block in get_company_schedule (double-bookings across overlapping project windows).",
                inputSchema: {
                    projectId: z.string().max(50).describe("Project id from get_company_schedule or list_projects"),
                    userIds: z.array(z.string().max(50)).max(50).describe("ACTIVATED user ids to assign — the FULL crew (not a delta); empty array clears the crew"),
                },
            },
            async ({ projectId, userIds }) => {
                try {
                    const result = await setProjectCrew({
                        projectId,
                        userIds,
                        actor: { type: "SYSTEM", name: "ChatGPT connector" },
                    });
                    return textResult(result);
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to assign crew" }), isError: true };
                }
            },
        );
    },
    {
        serverInfo: { name: "probuild", version: "1.8.0" },
        capabilities: { tools: {} },
        instructions:
            "ProBuild is Golden Touch Remodeling's construction management system. " +
            "TEMPLATE-FIRST workflow for estimates: 1) list_templates, 2) get_template for the closest room template (or compose from the '… Package' scope blocks), " +
            "3) scale quantities, allowances and prices to the actual job with the user — template numbers are starting points, " +
            "4) confirm the target with list_projects / list_leads, 5) create_estimate. " +
            "Every line item needs a costCode from get_estimating_codes. costType is just a line label (Labor / Material / Allowance / Subcontractor / Equipment / Other) — " +
            "the user estimates with allowances and lump-sum labor, so keep those labels accurate. " +
            "Quantity 0 is valid and is how the user presents OPTIONAL/alternate scope: the line shows at $0 and adds nothing to the total — preserve such lines when revising an estimate. " +
            "All prices are USD sell prices. Estimates arrive as private drafts for review in ProBuild. " +
            "ESTIMATE lifecycle: create_estimate (draft) → [get_estimate to read, update_estimate to revise in place while still Draft/Sent] → send_estimate (preview + user approval; customer signs via portal, which auto-creates the invoice). "
            + "update_estimate edits an existing unsigned estimate (line items, tax jurisdiction/rate, title, terms); once signed or invoiced, revisions go through a change order. " +
            "If a project needs an invoice without a signed estimate, create_invoice_from_estimate. list_receivables answers 'who owes us money?' across all projects. " +
            "create_lead captures field prospects. "
            + "To locate a job or estimate you only know by name/number (and don't know if it's still a lead or already a project), use find_job — it searches leads AND projects including closed/won ones, plus estimates by code. " +
            "BILLING: list_project_billing shows a project's invoices/milestones/estimates. send_milestone_invoice, resend_invoice and send_estimate EMAIL THE CUSTOMER — " +
            "always run the preview step, show the user exactly what will be sent and to whom, and only echo back the preview's confirmToken after their explicit approval. Never self-confirm. " +
            "Change-order lifecycle: create_change_order (draft) → send_change_order (preview + user approval; customer signs via portal) → " +
            "once Approved, bill_change_order puts it on the invoice → send_milestone_invoice emails the payment link. " +
            "FILES: upload_file parks documents (RFQs, RFIs, spec sheets, generated spreadsheets) on a project's or lead's Files tab — base64 content, ~3 MB max, optional folder. " +
            "Uploads default to internal visibility; only pass visibility 'shared' (customer-visible in the portal) when the user explicitly asks. " +
            "SCHEDULING: get_company_schedule answers 'what jobs are waiting to start?' and lists upcoming project starts (plus lead expected starts) " +
            "for the next N days, with each project's crew and a crewConflicts block (double-bookings across overlapping project windows). " +
            "set_project_start_date moves a project's company start date — for a project still Waiting to Start it also shifts " +
            "the job's tasks and linked milestones by the same delta (pass shiftJobTasks false to move only the marker); milestone groups already pushed " +
            "to QuickBooks are never shifted and come back in skippedQbMilestones for manual fixing. " +
            "generate_project_schedule builds a project's schedule from its estimate (the estimate must be Approved/Invoiced/Partially Paid/Paid and " +
            "the project needs a start date first — set one with set_project_start_date); default 'merge' mode is idempotent, 'regenerate' rebuilds untouched generated tasks. " +
            "assign_project_crew replaces a project's crew with the given ACTIVATED user ids (full list, not a delta). " +
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
