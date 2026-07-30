import { createHash, createHmac, timingSafeEqual } from "crypto";
import { createMcpHandler } from "mcp-handler";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createEstimateFromPhases, updateEstimateFromPhases, templateToPhases, estimateToPhases, CLOSED_PROJECT_STATUSES, CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { getProjectBilling, sendMilestoneInvoicesCore, resendInvoiceCore, createChangeOrderDraft, billChangeOrderCore, sendChangeOrderToClientCore, listReceivables, createInvoiceFromEstimateGuarded, previewCostPlusChangeOrderCore, billCostPlusChangeOrderCore } from "@/lib/billing-core";
import { getCompanyPipeline, getStartCalendar, getUnappliedChangeOrders, getCrewConflicts } from "@/lib/schedule-core";
import { coTaxRate, coTaxLabel } from "@/lib/co-tax";
import { ALLOWED_FILE_EXTENSIONS, fileExtension, mimeTypeForFileName, saveProjectFile } from "@/lib/project-files";
import { calculateCrewTimeCosts, createExpenseCore, createTimeEntryCore, findCrewMatches } from "@/lib/time-expense-core";
import { downloadDocBytes, resolveDocUrl, isSecureRef, secureRefPath } from "@/lib/secure-storage";
import { logActivity } from "@/lib/activity-log";
import {
    MAX_UPLOAD_BASE64_CHARS,
    uploadProjectFileCore,
    uploadProjectFilesCore,
} from "@/lib/project-file-core";
import {
    MCP_ACTOR_EMAILS,
    mcpActivityActorName,
    type McpActorLabel,
} from "@/lib/mcp-actor";
import {
    applyChangeOrderToScheduleWithConfirmation,
    assignProjectCrewWithConfirmation,
    assignTaskCrew,
    generateProjectScheduleWithConfirmation,
    getProjectSchedule,
    listCrewAvailability,
    planSchedule,
    setProjectStartDateWithConfirmation,
    setTaskStatus,
    updateTaskDates,
} from "@/lib/mcp-schedule-tools";
import {
    addPunchItemsWithConfirmation,
    createDailyLogWithConfirmation,
    createFolderWithConfirmation,
    getProjectContacts,
    listDailyLogs,
    listProjectFiles,
    listPunchItems,
    moveFileWithConfirmation,
} from "@/lib/mcp-pm-tools";

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

type RouteMcpActor = {
    actorLabel: McpActorLabel;
    resolveActorUserId: () => Promise<string | null>;
    // Resolves the signed-in human help-agent.ts is acting for (via the
    // trusted onBehalfOf query param — see guarded() below), so the audit
    // trail can credit the actual person instead of just the connector.
    resolveOnBehalfOf: () => Promise<{ id: string; name: string } | null>;
};

// The secret for the key that authenticated THIS request. Passing it to a send
// action is what proves the actor server-side — the action derives the audit
// label from whichever secret matches, so it can never be spoofed by an argument.
function secretForActor(actorLabel: McpActorLabel): string | undefined {
    return actorLabel === "richard-ai" ? process.env.MCP_SECRET_RICHARD : process.env.MCP_SECRET;
}

function createRouteMcpActor(actorLabel: McpActorLabel, onBehalfOfId?: string | null): RouteMcpActor {
    let actorUserId: Promise<string | null> | null = null;
    let onBehalfOf: Promise<{ id: string; name: string } | null> | null = null;
    return {
        actorLabel,
        resolveActorUserId: () => {
            actorUserId ??= prisma.user.findUnique({
                where: { email: MCP_ACTOR_EMAILS[actorLabel] },
                select: { id: true },
            }).then(user => user?.id ?? null);
            return actorUserId;
        },
        resolveOnBehalfOf: () => {
            if (!onBehalfOfId) return Promise.resolve(null);
            onBehalfOf ??= prisma.user.findUnique({
                where: { id: onBehalfOfId },
                select: { id: true, name: true, email: true },
            }).then(user => (user ? { id: user.id, name: user.name || user.email || "a teammate" } : null))
                .catch(() => null);
            return onBehalfOf;
        },
    };
}

// Same convention as FileBrowser.tsx's formatBytes — human-readable size for
// read_file / get_file_link output and error messages.
function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ── Audit trail for connector writes ────────────────────────────────────────
// Every write tool call gets an ActivityLog row (actorName/actorUserId identify
// who — see src/lib/mcp-actor.ts), read back via get_activity_log below.
// Derived by enumerating every server.registerTool(...) call below and taking
// every tool WITHOUT annotations.readOnlyHint === true, plus read_file and
// get_file_link (content access is worth an audit row even though they're reads).
const WRITE_TOOLS = new Set([
    "create_estimate", "update_estimate", "send_estimate",
    "send_milestone_invoice", "resend_invoice", "create_invoice_from_estimate",
    "create_change_order", "send_change_order", "bill_change_order",
    "create_lead", "log_time", "log_expense",
    "upload_file", "upload_files", "create_folder", "move_file",
    "create_daily_log", "add_punch_items",
    "create_contract", "update_contract", "send_contract",
    "plan_schedule", "update_task_dates", "set_task_status", "assign_task_crew",
    "set_project_start_date", "generate_project_schedule", "assign_project_crew",
    "apply_change_order_to_schedule", "read_file", "get_file_link",
]);
// bill_change_order is deliberately NOT here: fixed-price orders bill without
// emailing anyone, so "mcp_send_bill_change_order" would misreport a plain
// billing action as a customer send. It stays in WRITE_TOOLS for auditing.
const SEND_TOOLS = new Set([
    "send_estimate", "send_contract", "send_change_order",
    "send_milestone_invoice", "resend_invoice",
]);
const ENTITY_TYPE_BY_TOOL: Record<string, string> = {
    create_contract: "contract", update_contract: "contract", send_contract: "contract",
    create_estimate: "estimate", update_estimate: "estimate", send_estimate: "estimate",
    create_invoice_from_estimate: "invoice", send_milestone_invoice: "invoice", resend_invoice: "invoice",
    create_change_order: "change_order", send_change_order: "change_order", bill_change_order: "change_order",
    apply_change_order_to_schedule: "change_order",
    create_lead: "lead",
    plan_schedule: "task", update_task_dates: "task", set_task_status: "task", assign_task_crew: "task",
    upload_file: "file", upload_files: "file", read_file: "file", get_file_link: "file",
    create_folder: "folder", move_file: "file",
    create_daily_log: "daily_log",
    add_punch_items: "punch_item",
};

// Args whose VALUE is payload rather than intent — recording even a prefix
// would turn the activity log into a document store readable by anyone with
// ADMIN/MANAGER via get_activity_log. Logged as a marker, never the content.
const AUDIT_REDACTED_ARGS = new Set(["contentBase64", "fileBase64", "bodyHtml", "body", "customMessage"]);

// Recursive sanitize (depth-capped): drop anything that looks like a
// confirmation token, redact payload-bearing args outright, and cap remaining
// string values so a huge line-item dump (or a nested payload like
// upload_files' files[].contentBase64) can't blow up the log row or leak
// content that only lives at a nested level.
const SANITIZE_MAX_DEPTH = 5;
function sanitizeMcpValue(value: unknown, depth: number): unknown {
    if (depth > SANITIZE_MAX_DEPTH) {
        if (Array.isArray(value)) return `[array: ${value.length} items, depth limit reached]`;
        if (value && typeof value === "object") return "[object omitted: depth limit reached]";
        // Still truncate primitives at the cap — returning them raw would let a
        // payload nested one level past the limit through intact.
        return typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeMcpValue(item, depth + 1));
    }
    if (value && typeof value === "object") {
        const clean: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            if (/token/i.test(key)) continue;
            if (AUDIT_REDACTED_ARGS.has(key)) {
                clean[key] = typeof v === "string" ? `[redacted: ${v.length} chars]` : "[redacted]";
                continue;
            }
            clean[key] = sanitizeMcpValue(v, depth + 1);
        }
        return clean;
    }
    if (typeof value === "string" && value.length > 200) return `${value.slice(0, 200)}…`;
    return value;
}
function sanitizeMcpArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!args || typeof args !== "object") return {};
    return sanitizeMcpValue(args, 0) as Record<string, unknown>;
}

// Every tool result is a textResult({...}) — a single JSON-text content block.
// Reading the RESULT body is the only honest way to label a row: a junk or
// expired confirmToken still returns a preview (nothing was written), and some
// tools (sendMilestoneInvoicesCore, resendInvoiceCore) report a failed send as
// an ordinary result with no top-level isError.
function parseResultJson(result: unknown): any | null {
    const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
    const text = content?.find(c => c?.type === "text")?.text;
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// Two-step tools answer an unconfirmed call with either { preview: true, ... }
// (the send tools, minted here in the route) or { confirmationRequired: true,
// ... } (issueConfirmation, used by the schedule/PM tools) — nothing was
// written in either case.
function isPreviewBody(body: any): boolean {
    return !!body && (body.preview === true || body.confirmationRequired === true);
}

// A result body can report failure without ever setting isError — e.g.
// sendMilestoneInvoicesCore/resendInvoiceCore return { success: false, error }
// inside a plain textResult when the send didn't go out.
function bodyReportsFailure(body: any): boolean {
    return !!body && (body.success === false || (typeof body.error === "string" && body.error.length > 0));
}

function buildMcpAuditMetadata(toolName: string, actorLabel: McpActorLabel, args: Record<string, unknown> | undefined, errorText: string | undefined) {
    const metadata: Record<string, unknown> = {
        tool: toolName,
        actorLabel,
        args: sanitizeMcpArgs(args),
        ...(errorText ? { error: errorText.slice(0, 500) } : {}),
    };
    if (JSON.stringify(metadata).length > 4000) {
        metadata.args = "[omitted: too large]";
    }
    return metadata;
}

type AuditOwner = { projectId: string | null; leadId: string | null; entityId?: string; entityName?: string };

// Attributes a tool call to a project/lead (and, where cheap, a human-readable
// entity name) so get_activity_log can find it. A literal projectId/leadId arg
// wins outright; otherwise resolve the owner from whichever entity id is
// present — one findUnique for whichever matched. Every model here selects
// only the owner columns it actually has (Invoice/ChangeOrder: projectId only;
// Estimate/Contract/ScheduleTask/ProjectFile: both). Never throws — a failed
// lookup degrades to nulls rather than breaking the tool call or the audit write.
// pdfjs (under pdf-parse) touches browser globals at MODULE LOAD time. Vercel's
// server runtime resolves a build that needs DOMMatrix/Path2D/ImageData, which
// a bare local `node` import does not — hence "DOMMatrix is not defined" only
// once deployed, after passing locally and in CI. These stubs exist purely so
// the module can load; pure text extraction never exercises them, and each is
// installed only when genuinely absent so a real implementation always wins.
function ensurePdfDomGlobals() {
    const g = globalThis as any;
    if (typeof g.DOMMatrix === "undefined") {
        g.DOMMatrix = class DOMMatrix {
            a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
            m11 = 1; m12 = 0; m21 = 0; m22 = 1; m41 = 0; m42 = 0;
            constructor(init?: number[] | string) {
                if (Array.isArray(init) && init.length >= 6) {
                    [this.a, this.b, this.c, this.d, this.e, this.f] = init as number[];
                    this.m11 = this.a; this.m12 = this.b;
                    this.m21 = this.c; this.m22 = this.d;
                    this.m41 = this.e; this.m42 = this.f;
                }
            }
            multiply() { return this; }
            translate() { return this; }
            scale() { return this; }
            inverse() { return this; }
        };
    }
    if (typeof g.Path2D === "undefined") {
        g.Path2D = class Path2D {
            addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {}
            quadraticCurveTo() {} closePath() {} rect() {} arc() {}
        };
    }
    if (typeof g.ImageData === "undefined") {
        g.ImageData = class ImageData {
            data: Uint8ClampedArray; width: number; height: number;
            constructor(width: number, height: number) {
                this.width = width; this.height = height;
                this.data = new Uint8ClampedArray(Math.max(0, width * height * 4));
            }
        };
    }
}

async function resolveAuditOwner(toolName: string, args: Record<string, unknown>): Promise<AuditOwner> {
    const projectIdArg = typeof args.projectId === "string" && args.projectId ? args.projectId : null;
    const leadIdArg = typeof args.leadId === "string" && args.leadId ? args.leadId : null;
    if (projectIdArg || leadIdArg) {
        return { projectId: projectIdArg, leadId: leadIdArg };
    }

    try {
        if (typeof args.fileId === "string" && args.fileId) {
            const file = await prisma.projectFile.findUnique({
                where: { id: args.fileId },
                select: { projectId: true, leadId: true, name: true },
            });
            if (file) return { projectId: file.projectId ?? null, leadId: file.leadId ?? null, entityId: args.fileId, entityName: file.name };
        } else if (typeof args.estimateId === "string" && args.estimateId) {
            const estimate = await prisma.estimate.findUnique({
                where: { id: args.estimateId },
                select: { projectId: true, leadId: true },
            });
            if (estimate) return { projectId: estimate.projectId ?? null, leadId: estimate.leadId ?? null, entityId: args.estimateId };
        } else if (typeof args.invoiceId === "string" && args.invoiceId) {
            const invoice = await prisma.invoice.findUnique({
                where: { id: args.invoiceId },
                select: { projectId: true },
            });
            if (invoice) return { projectId: invoice.projectId ?? null, leadId: null, entityId: args.invoiceId };
        } else if (typeof args.contractId === "string" && args.contractId) {
            const contract = await prisma.contract.findUnique({
                where: { id: args.contractId },
                select: { projectId: true, leadId: true, title: true },
            });
            if (contract) return { projectId: contract.projectId ?? null, leadId: contract.leadId ?? null, entityId: args.contractId, entityName: contract.title };
        } else if (typeof args.changeOrderId === "string" && args.changeOrderId) {
            const co = await prisma.changeOrder.findUnique({
                where: { id: args.changeOrderId },
                select: { projectId: true },
            });
            if (co) return { projectId: co.projectId ?? null, leadId: null, entityId: args.changeOrderId };
        } else if (typeof args.taskId === "string" && args.taskId) {
            const task = await prisma.scheduleTask.findUnique({
                where: { id: args.taskId },
                select: { projectId: true, leadId: true },
            });
            if (task) return { projectId: task.projectId ?? null, leadId: task.leadId ?? null, entityId: args.taskId };
        } else if (typeof args.estimate === "string" && args.estimate) {
            // update_estimate names its arg `estimate` and accepts either the
            // code ("EST-00317") or the id — without this branch those writes
            // log projectId:null and can't be found by job.
            const estimate = await prisma.estimate.findFirst({
                where: { OR: [{ id: args.estimate }, { code: args.estimate }] },
                select: { id: true, projectId: true, leadId: true, code: true },
            });
            if (estimate) return { projectId: estimate.projectId ?? null, leadId: estimate.leadId ?? null, entityId: estimate.id, entityName: estimate.code };
        }
    } catch (err) {
        console.error(`[MCP AUDIT] owner lookup for ${toolName} failed:`, err);
    }
    return { projectId: null, leadId: null };
}

async function logMcpAudit(toolName: string, args: Record<string, unknown> | undefined, actor: RouteMcpActor, result: unknown, thrown: unknown) {
    const a = (args ?? {}) as Record<string, unknown>;
    const resultIsError = !!result && typeof result === "object" && (result as { isError?: boolean }).isError === true;
    const parsedBody = parseResultJson(result);
    const bodyFailed = bodyReportsFailure(parsedBody);
    const failed = thrown !== undefined || resultIsError || bodyFailed;
    const isPreview = !failed && isPreviewBody(parsedBody);

    // Preview labelling generalizes to every write tool (not just SEND_TOOLS):
    // any two-step tool that answered with a preview/confirmationRequired body
    // wrote nothing. Otherwise SEND_TOOLS get the "send" label (executed or
    // attempted-and-failed), everything else gets the plain mcp_<tool> label.
    let action: string;
    if (isPreview) {
        action = `mcp_preview_${toolName}`;
    } else if (SEND_TOOLS.has(toolName)) {
        action = `mcp_send_${toolName}`;
    } else {
        action = `mcp_${toolName}`;
    }
    if (failed) action += "_failed";

    const owner = await resolveAuditOwner(toolName, a);

    let errorText: string | undefined;
    if (thrown !== undefined) {
        errorText = thrown instanceof Error ? thrown.message : String(thrown);
    } else if (resultIsError) {
        const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
        errorText = content?.find(c => c?.type === "text")?.text ?? "Tool reported an error";
    } else if (bodyFailed && typeof parsedBody?.error === "string") {
        errorText = parsedBody.error;
    }

    // onBehalfOf (help-agent.ts's trusted side-channel) credits the actual
    // human who typed in-app chat, instead of always naming the connector.
    const onBehalfOf = await actor.resolveOnBehalfOf();
    const actorName = onBehalfOf
        ? `${mcpActivityActorName(actor.actorLabel)} (via ${onBehalfOf.name})`
        : mcpActivityActorName(actor.actorLabel);
    const actorUserId = onBehalfOf?.id ?? (await actor.resolveActorUserId()) ?? undefined;

    await logActivity({
        projectId: owner.projectId,
        leadId: owner.leadId,
        actorType: "TEAM",
        actorName,
        actorUserId,
        action,
        entityType: ENTITY_TYPE_BY_TOOL[toolName],
        entityId: owner.entityId || undefined,
        entityName: owner.entityName,
        metadata: buildMcpAuditMetadata(toolName, actor.actorLabel, a, errorText),
    });
}

// Monkeypatches registerTool so WRITE_TOOLS get an audit-log wrapper without
// touching any of the tool bodies below. Must run before the first
// registerTool call in the initializer.
function wrapWriteTools(server: { registerTool: (...args: any[]) => unknown }, actor: RouteMcpActor) {
    const originalRegisterTool = server.registerTool.bind(server);
    server.registerTool = (name: string, config: unknown, cb: (...cbArgs: any[]) => unknown) => {
        if (!WRITE_TOOLS.has(name)) {
            return originalRegisterTool(name, config, cb);
        }
        const wrapped = async (args: Record<string, unknown>, extra?: unknown) => {
            let result: unknown;
            let thrown: unknown;
            try {
                result = await cb(args, extra);
            } catch (err) {
                thrown = err;
            }
            try {
                await logMcpAudit(name, args, actor, result, thrown);
            } catch (auditErr) {
                // Logging must never break a tool call — but an audit trail
                // that fails silently is worse than none, so make the gap
                // loud enough to find in Vercel/Sentry logs.
                console.error(
                    `[MCP AUDIT FAILURE] tool=${name} actor=${actor.actorLabel} — the action ran but was NOT recorded:`,
                    auditErr
                );
            }
            if (thrown !== undefined) throw thrown;
            return result;
        };
        return originalRegisterTool(name, config, wrapped);
    };
}

function createHandler(actor: RouteMcpActor) {
    return createMcpHandler(
    server => {
        wrapWriteTools(server, actor);

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
                const result = await sendMilestoneInvoicesCore(
                    invoiceId,
                    paymentScheduleIds,
                    overrideEmail,
                    { reconcile },
                    `SYSTEM:${actor.actorLabel}`,
                );
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
                    "Say 'cost plus 10' with pricingType COST_PLUS and markupPercent 10. Say 'two payments, half up front' with two paymentSchedules. " +
                    "Line items follow the same costCode/costType rules as estimates. Cost-plus scope items are optional. It is NOT sent to the customer — review and send happen in ProBuild.",
                inputSchema: {
                    projectId: z.string().max(50),
                    estimateId: z.string().max(50).describe("Estimate on the project this change order amends (from list_project_billing)"),
                    title: z.string().min(1).max(300).describe("e.g. 'Add recessed lighting in kitchen'"),
                    description: z.string().max(2000).optional(),
                    pricingType: z.enum(["FIXED", "COST_PLUS"]).default("FIXED"),
                    markupPercent: z.number().min(0).max(1000).nullable().optional(),
                    items: z.array(z.object({
                        name: z.string().min(1).max(300),
                        description: z.string().max(2000).optional(),
                        costCode: z.string().max(50).optional(),
                        costType: z.string().max(50).optional(),
                        quantity: z.number().min(0).max(1_000_000),
                        unitCost: z.number().min(0).max(10_000_000),
                    })).max(100).optional(),
                    paymentSchedules: z.array(z.object({
                        name: z.string().min(1).max(300),
                        amount: z.number().positive().max(10_000_000),
                        dueDate: z.string().optional(),
                        order: z.number().int().min(0).optional(),
                    })).max(20).optional(),
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
                        code: true, title: true, status: true, pricingType: true, markupPercent: true, totalAmount: true, updatedAt: true,
                        paymentSchedules: { orderBy: { order: "asc" }, select: { id: true, name: true, amount: true, dueDate: true, order: true } },
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
                const payload = JSON.stringify({ changeOrderId, recipient, code: co.code, title: co.title, pricingType: co.pricingType, markupPercent: co.markupPercent, total: Number(co.totalAmount), schedules: co.paymentSchedules.map(row => [row.id, row.name, Number(row.amount), row.dueDate?.toISOString(), row.order]), status: co.status, updatedAt: co.updatedAt.toISOString() });
                if (!verifyPreviewToken(confirmToken, payload)) {
                    const subtotal = Number(co.totalAmount);
                    const taxAmount = Math.round(subtotal * coTaxRate(co.estimate) * 100) / 100;
                    return textResult({
                        preview: true,
                        changeOrder: {
                            code: co.code, title: co.title, status: co.status,
                            pricingType: co.pricingType,
                            markupPercent: co.markupPercent,
                            paymentSchedules: co.paymentSchedules.map(row => ({ ...row, amount: Number(row.amount) })),
                            ...(co.pricingType === "COST_PLUS"
                                ? { terms: `cost + ${co.markupPercent ?? 10}% + tax, billed from actuals` }
                                : { subtotal, tax: taxAmount, taxTreatment: coTaxLabel(co.estimate), revisedAmountCustomerSigns: Math.round((subtotal + taxAmount) * 100) / 100 }),
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
                    secretForActor(actor.actorLabel),
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
            "list_change_orders",
            {
                title: "List project change orders and actuals",
                annotations: { readOnlyHint: true },
                description: "Lists change orders with pricing type, signature state, unbilled billable actuals, hours, and billed-to-date. Use this before logging or billing cost-plus work.",
                inputSchema: { projectId: z.string().max(50) },
            },
            async ({ projectId }) => {
                const orders = await prisma.changeOrder.findMany({
                    where: { projectId },
                    orderBy: { createdAt: "desc" },
                    include: {
                        timeEntries: { where: { isBillable: true, invoiceId: null, invoicedAt: null }, select: { durationHours: true, laborCost: true, burdenCost: true } },
                        expenses: { where: { isBillable: true, invoiceId: null, invoicedAt: null }, select: { amount: true } },
                        billings: { select: { totalCents: true, laborCents: true, expenseCents: true, markupCents: true, taxCents: true } },
                        paymentSchedules: { orderBy: { order: "asc" }, select: { id: true, name: true, amount: true, dueDate: true } },
                    },
                });
                return textResult(orders.map((co) => ({
                    id: co.id,
                    code: co.code,
                    title: co.title,
                    status: co.status,
                    pricingType: co.pricingType,
                    markupPercent: co.markupPercent,
                    subtotal: Number(co.totalAmount),
                    signature: { approvedBy: co.approvedBy, approvedAt: co.approvedAt, signed: Boolean(co.approvedAt && co.clientSignatureUrl) },
                    paymentSchedules: co.paymentSchedules.map((row) => ({ ...row, amount: Number(row.amount) })),
                    actualsToDate: {
                        hours: co.timeEntries.reduce((sum, row) => sum + (row.durationHours ?? 0), 0),
                        laborAndBurden: co.timeEntries.reduce((sum, row) => sum + Number(row.laborCost) + Number(row.burdenCost ?? 0), 0),
                        expenses: co.expenses.reduce((sum, row) => sum + Number(row.amount), 0),
                    },
                    billedToDate: co.billings.reduce((sum, row) => sum + row.totalCents, 0) / 100,
                })));
            },
        );

        server.registerTool(
            "log_time",
            {
                title: "Log crew time to a project or cost-plus change order",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description: "Logs time for an explicitly named crew member. Provide projectId or changeOrderId. A cost-plus tag is billable automatically; ambiguous crew names return the project crew list.",
                inputSchema: {
                    projectId: z.string().max(50).optional(),
                    changeOrderId: z.string().max(50).optional(),
                    crewMember: z.string().trim().min(1).max(200),
                    date: z.string().min(10).max(40),
                    hours: z.number().positive().max(24),
                    note: z.string().max(2000).optional(),
                    burdenCost: z.number().min(0).max(1_000_000).optional().describe("Optional total burden cost for this entry"),
                },
            },
            async ({ projectId, changeOrderId, crewMember, date, hours, note, burdenCost }) => {
                if ((projectId ? 1 : 0) + (changeOrderId ? 1 : 0) !== 1) {
                    return { ...textResult({ error: "Provide exactly one of projectId or changeOrderId." }), isError: true };
                }
                const co = changeOrderId ? await prisma.changeOrder.findUnique({ where: { id: changeOrderId }, select: { projectId: true } }) : null;
                const resolvedProjectId = projectId ?? co?.projectId;
                if (!resolvedProjectId) return { ...textResult({ error: "Change order not found" }), isError: true };
                const project = await prisma.project.findUnique({
                    where: { id: resolvedProjectId },
                    select: { name: true, crew: { select: { id: true, name: true, email: true, hourlyRate: true, burdenRate: true } } },
                });
                if (!project) return { ...textResult({ error: "Project not found" }), isError: true };
                const matches = findCrewMatches(project.crew, crewMember);
                if (matches.length !== 1) {
                    return { ...textResult({ error: matches.length ? `Crew name "${crewMember}" is ambiguous.` : `Crew member "${crewMember}" was not found.`, crew: project.crew.map(row => ({ name: row.name, email: row.email })) }), isError: true };
                }
                const member = matches[0];
                const costs = calculateCrewTimeCosts(hours, Number(member.hourlyRate ?? 0), Number(member.burdenRate ?? 0), burdenCost);
                const entry = await createTimeEntryCore({
                    projectId: resolvedProjectId,
                    changeOrderId: changeOrderId ?? null,
                    userId: member.id,
                    date,
                    durationHours: hours,
                    laborCost: costs.laborCost,
                    burdenCost: costs.burdenCost,
                    notes: note,
                    isBillable: Boolean(changeOrderId),
                }, "ChatGPT connector");
                return textResult({ id: entry.id, projectId: resolvedProjectId, changeOrderId: entry.changeOrderId, crewMember: member.name || member.email, hours, laborCost: Number(entry.laborCost), burdenCost: Number(entry.burdenCost ?? 0), url: `https://probuild.goldentouchremodeling.com/projects/${resolvedProjectId}/time-expenses` });
            },
        );

        server.registerTool(
            "log_expense",
            {
                title: "Log an expense to a project estimate or cost-plus change order",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description: "Logs an expense. Use changeOrderId for cost-plus actuals, or estimateId for an ordinary project expense. receiptFileId accepts the id returned by upload_file.",
                inputSchema: {
                    changeOrderId: z.string().max(50).optional(),
                    estimateId: z.string().max(50).optional(),
                    amount: z.number().positive().max(10_000_000),
                    vendor: z.string().max(300).optional(),
                    date: z.string().max(40).optional(),
                    description: z.string().max(2000).optional(),
                    receiptFileId: z.string().max(80).optional(),
                },
            },
            async ({ changeOrderId, estimateId, amount, vendor, date, description, receiptFileId }) => {
                if ((changeOrderId ? 1 : 0) + (estimateId ? 1 : 0) !== 1) {
                    return { ...textResult({ error: "Provide exactly one of changeOrderId or estimateId." }), isError: true };
                }
                try {
                    const expense = await createExpenseCore({ changeOrderId, estimateId, amount, vendor, date, description, receiptFileId, isBillable: Boolean(changeOrderId) }, "ChatGPT connector");
                    const estimate = await prisma.estimate.findUnique({ where: { id: expense.estimateId }, select: { projectId: true } });
                    return textResult({ id: expense.id, changeOrderId: expense.changeOrderId, amount: Number(expense.amount), receiptUrl: expense.receiptUrl, url: estimate?.projectId ? `https://probuild.goldentouchremodeling.com/projects/${estimate.projectId}/time-expenses` : null });
                } catch (err: any) {
                    return { ...textResult({ error: err?.message || "Expense could not be logged" }), isError: true };
                }
            },
        );

        server.registerTool(
            "bill_change_order",
            {
                title: "Bill an approved change order",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    "Bills an APPROVED change order. Fixed-price orders bill immediately. COST_PLUS uses a bound TWO-STEP preview: call with throughDate, show the itemized totals, then echo confirmToken. " +
                    "Nothing is emailed by this tool; it returns the milestone id so you can then run send_milestone_invoice (preview → user approval → confirm) " +
                    "to email the customer the QuickBooks payment link. Find change order ids and statuses via list_project_billing.",
                inputSchema: {
                    changeOrderId: z.string().max(50).describe("Change order id from list_project_billing (status must be Approved)"),
                    throughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Required for cost-plus: local company date through which actuals are included"),
                    confirmToken: z.string().max(40).optional(),
                },
            },
            async ({ changeOrderId, throughDate, confirmToken }) => {
                const co = await prisma.changeOrder.findUnique({ where: { id: changeOrderId }, select: { pricingType: true } });
                if (!co) return { ...textResult({ error: "Change order not found" }), isError: true };
                if (co.pricingType === "COST_PLUS") {
                    if (!throughDate) return { ...textResult({ error: "throughDate is required for a cost-plus billing run" }), isError: true };
                    try {
                        const preview = await previewCostPlusChangeOrderCore(changeOrderId, { throughDate });
                        const payload = JSON.stringify({ changeOrderId, throughDate: preview.throughDate, invoiceId: preview.invoiceId, markupPercent: preview.markupPercent, taxRate: preview.taxRate, fingerprint: preview.fingerprint });
                        if (!verifyPreviewToken(confirmToken, payload)) {
                            return textResult({ preview: true, ...preview, confirmToken: mintPreviewToken(payload), instruction: "Show labor (including burden), expenses, markup, tax, total, and the through date. Call again with this token only after explicit approval." });
                        }
                        const result = await billCostPlusChangeOrderCore(changeOrderId, {
                            throughDate,
                            actor: "ChatGPT connector",
                            expectedFingerprint: preview.fingerprint,
                            expectedInvoiceId: preview.invoiceId,
                            expectedMarkupPercent: preview.markupPercent,
                            expectedTaxRate: preview.taxRate,
                        });
                        return textResult({ ...result, backupUrlNote: "The itemized backup link appears on the invoice portal and is emailed when this milestone is sent." });
                    } catch (err: any) {
                        let freshPreview: unknown = null;
                        try { freshPreview = await previewCostPlusChangeOrderCore(changeOrderId, { throughDate }); } catch {}
                        return { ...textResult({ error: err?.message || "Cost-plus billing failed", freshPreview }), isError: true };
                    }
                }
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
                    contentBase64: z.string().min(1).max(MAX_UPLOAD_BASE64_CHARS).describe("The file's raw bytes, standard base64-encoded (no data: URL prefix). Max ~3 MB decoded."),
                    folder: z.string().max(120).optional().describe("Optional top-level folder name on the job's Files tab, e.g. 'RFQs' — found case-insensitively or created"),
                    visibility: z.enum(["team", "shared"]).optional().describe("'team' = internal only (default); 'shared' = the customer sees it in their portal"),
                },
            },
            async args => {
                const actorUserId = actor.actorLabel === "richard-ai"
                    ? await actor.resolveActorUserId()
                    : null;
                const result = await uploadProjectFileCore({
                    ...args,
                    actor: { actorLabel: actor.actorLabel, actorUserId },
                });
                if (!result.ok) {
                    return { ...textResult({ error: result.error }), isError: true };
                }
                return textResult(result.data);
            },
        );

        server.registerTool(
            "upload_files",
            {
                title: "Upload multiple documents to a job's Files tab",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Uploads 1–8 documents to a project's or lead's Files tab in one call, with a combined decoded limit of ~3 MB. " +
                    "The whole batch is validated before storage starts; storage failures are returned per file so only failures need retrying. " +
                    "Files are INTERNAL by default. visibility 'shared' is customer-visible and must only be used when the user explicitly asks. " +
                    "Standard project folders are created implicitly when the project has no folders.",
                inputSchema: {
                    projectId: z.string().max(50).optional().describe("Target project id (omit if using leadId)"),
                    leadId: z.string().max(50).optional().describe("Target lead id (omit if using projectId)"),
                    defaultFolder: z.string().max(120).optional().describe("Default top-level folder for files that omit their own folder"),
                    files: z.array(z.object({
                        fileName: z.string().min(1).max(200),
                        contentBase64: z.string().min(1).max(MAX_UPLOAD_BASE64_CHARS),
                        folder: z.string().max(120).optional(),
                        visibility: z.enum(["team", "shared"]).optional(),
                    })).min(1).max(8),
                },
            },
            async args => {
                const actorUserId = actor.actorLabel === "richard-ai"
                    ? await actor.resolveActorUserId()
                    : null;
                const result = await uploadProjectFilesCore({
                    ...args,
                    actor: { actorLabel: actor.actorLabel, actorUserId },
                });
                if (!result.ok) {
                    return { ...textResult({ error: result.error }), isError: true };
                }
                return textResult(result.results);
            },
        );

        server.registerTool(
            "list_project_files",
            {
                title: "List a job's folder tree and files",
                annotations: { readOnlyHint: true },
                description:
                    "Returns a project's or lead's folder tree and file metadata (id, name, size, mime type, visibility, folder, created date) — metadata only, no URLs. " +
                    "Standard project folders are created implicitly when a project has no folders. " +
                    "Pass a file's id to read_file for its extracted text, or to get_file_link for a view/download link.",
                inputSchema: {
                    projectId: z.string().max(50).optional(),
                    leadId: z.string().max(50).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await listProjectFiles(args));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to list project files" }), isError: true };
                }
            },
        );

        const READ_FILE_MAX_BYTES = 25_000_000;

        function extractedTextResult(rawText: string, maxChars: number, sizeBytes?: number) {
            const normalized = rawText.replace(/\n{3,}/g, "\n\n").trim();
            const totalChars = normalized.length;
            const truncated = totalChars > maxChars;
            // A big PDF that yields almost no text is a drawing or a scan, not a
            // document — the page content is vector/raster with no text layer.
            // Verified: a 495 KB architectural foundation plan extracts 36 chars
            // (just the title block). Say so, or the caller reports the tool as
            // broken when it worked exactly as designed.
            const looksLikeNoTextLayer = !!sizeBytes && sizeBytes > 100_000 && totalChars < 200;
            return {
                readable: true as const,
                truncated,
                totalChars,
                ...(looksLikeNoTextLayer
                    ? {
                          likelyNoTextLayer: true,
                          note:
                              "Almost no text came out of a large file — this is very likely a drawing, plan sheet, or scanned page with no embedded text layer. What's below is all there is; the visual content can't be read this way. Open it in ProBuild to view it.",
                      }
                    : {}),
                text: truncated ? normalized.slice(0, maxChars) : normalized,
            };
        }

        server.registerTool(
            "read_file",
            {
                title: "Read a file's contents",
                annotations: { readOnlyHint: true },
                description:
                    "Returns extracted text for PDFs, Word docs (.docx) and plain-text/CSV/JSON files on a job's Files tab, so the assistant can actually read a spec, scope sheet, or signed document. " +
                    "Images and other binary formats return a description instead of content, plus a viewUrl link. Use the id from list_project_files.",
                inputSchema: {
                    fileId: z.string().max(50).describe("File id from list_project_files"),
                    maxChars: z.number().int().min(500).max(50_000).optional().describe("Max characters of extracted text to return (default 20000)"),
                    linkMinutes: z.number().int().min(1).max(120).optional().describe("How long the returned viewUrl stays valid, minutes (default 30)"),
                },
            },
            async ({ fileId, maxChars, linkMinutes }) => {
                const file = await prisma.projectFile.findUnique({
                    where: { id: fileId },
                    select: {
                        id: true, name: true, url: true, size: true, mimeType: true, visibility: true,
                        folderId: true, projectId: true, leadId: true,
                        folder: { select: { id: true, name: true, visibility: true } },
                    },
                });
                if (!file) return { ...textResult({ error: `No file with id ${fileId}. Use list_project_files.` }), isError: true };

                const ext = fileExtension(file.name);
                const mime = file.mimeType || "";
                const isGenericMime = mime === "application/octet-stream" || !mime;
                const effectiveMaxChars = maxChars ?? 20_000;
                const effectiveLinkMinutes = linkMinutes ?? 30;
                const viewUrl = await resolveDocUrl(file.url, effectiveLinkMinutes * 60);
                // Only a `secure:` ref is actually a time-limited signed URL — an
                // ordinary project upload's stored value is a permanent public URL
                // that resolveDocUrl returns unchanged, so don't claim it expires.
                // Prefix alone is not enough: a malformed ref like "secure:/bad"
                // passes isSecureRef but fails secureRefPath and falls through to
                // public resolution, so it must not be labelled as expiring.
                const linkIsSigned = isSecureRef(file.url) && !!secureRefPath(file.url);
                const base = {
                    id: file.id, name: file.name, mimeType: file.mimeType, size: file.size, folder: file.folder?.name ?? null,
                    viewUrl,
                    ...(!viewUrl
                        ? { viewUrlNote: "Could not generate a link for this file." }
                        : linkIsSigned
                            ? { expiresInMinutes: effectiveLinkMinutes }
                            : { expires: false as const, viewUrlNote: "This is a permanent public link — it does not expire." }),
                };

                const isPdf = mime === "application/pdf" || (isGenericMime && ext === ".pdf");
                const isDocx = mime.includes("wordprocessingml.document") || (isGenericMime && ext === ".docx");
                const isPlainText = mime.startsWith("text/") || mime === "application/json" || [".txt", ".md", ".csv", ".json"].includes(ext);

                // Decide readability from mimeType/extension BEFORE downloading
                // anything — a 20MB photo should never be fetched just to be
                // told "it's an image". Both branches still carry viewUrl — for
                // an image or an unsupported type, the link IS the useful output.
                if (!isPdf && !isDocx && !isPlainText) {
                    if (mime.startsWith("image/")) {
                        return textResult({ ...base, readable: false, kind: "image", note: "Images can't be converted to text. Open the link in viewUrl to view the photo." });
                    }
                    return textResult({ ...base, readable: false, kind: mime || ext || "unknown", note: "No text extractor for this type — use viewUrl to open it." });
                }

                // DB `size` ceiling check. This is now the ONLY size guard: the
                // download below goes through downloadDocBytes against our own
                // bucket, not an attacker-controlled endpoint, so there's no
                // untrusted content-length header to double-check against.
                if (file.size > READ_FILE_MAX_BYTES) {
                    return { ...textResult({ error: `File is ${formatBytes(file.size)} — too large to read inline (max ${formatBytes(READ_FILE_MAX_BYTES)}).` }), isError: true };
                }

                const buffer = await downloadDocBytes(file.url);
                if (!buffer) {
                    return { ...textResult({ error: "Could not read the file's bytes from storage." }), isError: true };
                }
                // `ProjectFile.size` defaults to 0 and can be stale, so the check
                // above is only a cheap early-out. Enforce the real ceiling here
                // too — the memory is already spent (downloadDocBytes just read
                // the whole object), but this still stops extraction from running
                // against an oversized buffer. The bytes came from our own bucket,
                // not an attacker-controlled endpoint, so there's no untrusted
                // content-length to check earlier instead.
                if (buffer.length > READ_FILE_MAX_BYTES) {
                    return { ...textResult({ error: `File is ${formatBytes(buffer.length)} — too large to read inline (max ${formatBytes(READ_FILE_MAX_BYTES)}).` }), isError: true };
                }

                try {
                    if (isPdf) {
                        ensurePdfDomGlobals();
                        const pdfParseMod: any = await import("pdf-parse");
                        const PDFParseCtor = pdfParseMod.PDFParse ?? pdfParseMod.default?.PDFParse;
                        const parser = new PDFParseCtor({ data: buffer });
                        let text: string;
                        try {
                            const result = await parser.getText();
                            text = result?.text ?? "";
                        } finally {
                            await parser.destroy?.();
                        }
                        return textResult({ ...base, ...extractedTextResult(text, effectiveMaxChars, file.size) });
                    }
                    if (isDocx) {
                        const mammothMod: any = await import("mammoth");
                        const extractRawText = mammothMod.extractRawText ?? mammothMod.default?.extractRawText;
                        const result = await extractRawText({ buffer });
                        return textResult({ ...base, ...extractedTextResult(result?.value ?? "", effectiveMaxChars, file.size) });
                    }
                    // isPlainText is the only remaining possibility — isPdf,
                    // isDocx and isPlainText are the sole gates past the early
                    // return above.
                    return textResult({ ...base, ...extractedTextResult(buffer.toString("utf-8"), effectiveMaxChars) });
                } catch (err: any) {
                    // Degrade usefully rather than surfacing an internal error:
                    // the link still works even when the text extractor can't
                    // load or the PDF is malformed, and for drawings/scans the
                    // link was always the answer anyway.
                    return {
                        ...textResult({
                            error: `Could not extract text from "${file.name}": ${err?.message || "unknown error"}`,
                            readable: false,
                            viewUrl: base.viewUrl ?? null,
                            note: base.viewUrl
                                ? "Text extraction failed, but the file itself is fine — open viewUrl to view or download it."
                                : "Text extraction failed. Use get_file_link to get a link to the file.",
                        }),
                        isError: true,
                    };
                }
            },
        );

        server.registerTool(
            "get_file_link",
            {
                title: "Get a viewable link to a file",
                annotations: { readOnlyHint: true },
                description:
                    "Returns a link to open or download any file on a job's Files tab — use this for photos, drawings, and scans that read_file can't turn into text, " +
                    "or whenever the user wants the actual document rather than its extracted text. The link expires after linkMinutes (default 30). Use the id from list_project_files.",
                inputSchema: {
                    fileId: z.string().max(50).describe("File id from list_project_files"),
                    linkMinutes: z.number().int().min(1).max(120).optional().describe("How long the returned link stays valid, minutes (default 30)"),
                },
            },
            async ({ fileId, linkMinutes }) => {
                const file = await prisma.projectFile.findUnique({
                    where: { id: fileId },
                    select: {
                        id: true, name: true, url: true, size: true, mimeType: true, visibility: true,
                        folderId: true, projectId: true, leadId: true,
                        folder: { select: { id: true, name: true, visibility: true } },
                    },
                });
                if (!file) return { ...textResult({ error: `No file with id ${fileId}. Use list_project_files.` }), isError: true };

                const effectiveLinkMinutes = linkMinutes ?? 30;
                const viewUrl = await resolveDocUrl(file.url, effectiveLinkMinutes * 60);
                if (!viewUrl) {
                    return { ...textResult({ error: "Could not generate a viewable link for this file." }), isError: true };
                }
                // Only a `secure:` ref is actually a time-limited signed URL — an
                // ordinary project upload's stored value is a permanent public URL
                // that resolveDocUrl returns unchanged, so don't claim it expires.
                // Prefix alone is not enough: a malformed ref like "secure:/bad"
                // passes isSecureRef but fails secureRefPath and falls through to
                // public resolution, so it must not be labelled as expiring.
                const linkIsSigned = isSecureRef(file.url) && !!secureRefPath(file.url);
                return textResult({
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    size: formatBytes(file.size),
                    folder: file.folder?.name ?? null,
                    viewUrl,
                    ...(linkIsSigned
                        ? { expiresInMinutes: effectiveLinkMinutes }
                        : { expires: false as const, note: "This is a permanent public link — it does not expire." }),
                });
            },
        );

        server.registerTool(
            "create_folder",
            {
                title: "Create a folder on a job's Files tab",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Creates a top-level or nested team/shared folder on one project or lead. A shared child cannot be placed under a team folder. " +
                    "TWO-STEP, SINGLE-USE: call without confirmToken for a preview, show it to the user, then repeat the exact arguments with the token after approval.",
                inputSchema: {
                    projectId: z.string().max(50).optional(),
                    leadId: z.string().max(50).optional(),
                    name: z.string().trim().min(1).max(120),
                    parentFolderId: z.string().max(50).optional(),
                    visibility: z.enum(["team", "shared"]).optional(),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await createFolderWithConfirmation(
                        args,
                        { actorLabel: actor.actorLabel, actorUserId: null },
                    ));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to create folder" }), isError: true };
                }
            },
        );

        server.registerTool(
            "move_file",
            {
                title: "Move a file within the same job",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Moves a ProjectFile to another folder (or the top level) on the SAME project/lead. Cross-job moves are refused. " +
                    "A team file cannot move into a shared folder unless the same call explicitly passes visibility 'shared'; shared files cannot be hidden inside team folders. " +
                    "TWO-STEP, SINGLE-USE: preview first, show the user, then repeat the exact arguments with confirmToken after approval.",
                inputSchema: {
                    fileId: z.string().max(50),
                    folderId: z.string().max(50).nullable().describe("Destination folder id, or null for the job's top level"),
                    visibility: z.enum(["team", "shared"]).optional().describe("Explicitly pass 'shared' to approve a customer-visibility change"),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await moveFileWithConfirmation(
                        args,
                        { actorLabel: actor.actorLabel, actorUserId: null },
                    ));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to move file" }), isError: true };
                }
            },
        );

        server.registerTool(
            "list_daily_logs",
            {
                title: "List project daily logs",
                annotations: { readOnlyHint: true },
                description:
                    "Lists one project's daily logs with date, weather, crew on site, work performed, deliveries, issues, photo count, and portal-sharing state.",
                inputSchema: {
                    projectId: z.string().max(50),
                    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
                    limit: z.number().int().min(1).max(100).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await listDailyLogs(args));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to list daily logs" }), isError: true };
                }
            },
        );

        server.registerTool(
            "create_daily_log",
            {
                title: "Create a project daily log",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Creates an internal daily log on a project. sharedToPortal is deliberately not exposed; portal sharing remains a human in-app decision. " +
                    "Attach photos by ProjectFile id after upload_files—bytes are not re-sent. Every photo must be an image on the same project. " +
                    "TWO-STEP, SINGLE-USE: preview first, show the user, then repeat the exact arguments with confirmToken after approval.",
                inputSchema: {
                    projectId: z.string().max(50),
                    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
                    weather: z.string().max(300).optional(),
                    crewOnSite: z.string().max(1000).optional(),
                    workPerformed: z.string().trim().min(1).max(20_000),
                    materialsDelivered: z.string().max(20_000).optional(),
                    issues: z.string().max(20_000).optional(),
                    photos: z.array(z.object({
                        fileId: z.string().max(50),
                        caption: z.string().max(500).optional(),
                    })).max(20).optional(),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    const actorUserId = await actor.resolveActorUserId();
                    return textResult(await createDailyLogWithConfirmation(
                        args,
                        { actorLabel: actor.actorLabel, actorUserId },
                    ));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to create daily log" }), isError: true };
                }
            },
        );

        server.registerTool(
            "list_punch_items",
            {
                title: "List punch items by task or project",
                annotations: { readOnlyHint: true },
                description:
                    "Lists open, completed, or all punch items for exactly one task or project, including completedAt. This is read-only field evidence.",
                inputSchema: {
                    taskId: z.string().max(50).optional(),
                    projectId: z.string().max(50).optional(),
                    status: z.enum(["open", "completed", "all"]).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await listPunchItems(args));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to list punch items" }), isError: true };
                }
            },
        );

        server.registerTool(
            "add_punch_items",
            {
                title: "Add punch items to a task",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Adds 1–30 ordered punch items to one schedule task. TWO-STEP, SINGLE-USE: preview the entire list, show it to the user, then repeat the exact arguments with confirmToken after approval.",
                inputSchema: {
                    taskId: z.string().max(50),
                    items: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    const actorUserId = await actor.resolveActorUserId();
                    return textResult(await addPunchItemsWithConfirmation(
                        args,
                        { actorLabel: actor.actorLabel, actorUserId },
                    ));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to add punch items" }), isError: true };
                }
            },
        );

        // complete_punch_item is deliberately cut/not registered: completion is
        // direct field evidence and must only follow a human-reported completion,
        // never a model "tidying up" a punch list.

        server.registerTool(
            "get_project_contacts",
            {
                title: "Get project contacts",
                annotations: { readOnlyHint: true },
                description:
                    "Returns the client, manager, assigned crew, and task subcontractors for one project. PII boundary: no rates, budgets, licenses, or addresses beyond the project location.",
                inputSchema: {
                    projectId: z.string().max(50),
                },
            },
            async args => {
                try {
                    return textResult(await getProjectContacts(args));
                } catch (error) {
                    return { ...textResult({ error: error instanceof Error ? error.message : "Failed to get project contacts" }), isError: true };
                }
            },
        );

        // ── Contracts ──────────────────────────────────────────────────────
        // Standalone legal documents (separate from estimates): HTML body with
        // {{merge_field}} placeholders, client e-sign via portal magic link,
        // optional contractor pre-sign + company countersign. Creation resolves
        // data merge fields immediately; signing keys ({{SIGNATURE_BLOCK}} etc.)
        // stay raw in the body — the portal renders them as tap-to-sign fields.

        const CONTRACTOR_BLOCK_RE = /\{\{CONTRACTOR_SIGNATURE_BLOCK\}\}|data-merge-field=["']CONTRACTOR_SIGNATURE_BLOCK["']/i;
        const CLIENT_SIGN_BLOCK_RE = /\{\{SIGNATURE_BLOCK\}\}/;
        const contractSummary = (c: {
            id: string; title: string; status: string; sentAt: Date | null;
            approvedBy: string | null; approvedAt: Date | null;
            contractorSignedAt: Date | null; requiresCountersign: boolean; companySignedAt: Date | null;
            recurringDays: number | null; originalPdfPath: string | null; createdAt: Date;
        }) => ({
            contractId: c.id,
            title: c.title,
            status: c.status, // Draft, Sent, Viewed, Signed, Declined (+ Finalized after countersign)
            sentAt: c.sentAt,
            signedBy: c.approvedBy,
            signedAt: c.approvedAt,
            contractorSignedAt: c.contractorSignedAt,
            requiresCountersign: c.requiresCountersign,
            companyCountersignedAt: c.companySignedAt,
            recurringDays: c.recurringDays,
            isPdfContract: !!c.originalPdfPath,
            createdAt: c.createdAt,
        });

        server.registerTool(
            "list_contract_templates",
            {
                title: "List contract/document templates",
                annotations: { readOnlyHint: true },
                description:
                    "Lists the document templates saved in ProBuild (type: contract, terms, or disclaimer). " +
                    "Pass a template's id to create_contract to generate a contract from it with the job's client/company/pricing data merged in.",
                inputSchema: {},
            },
            async () => {
                const templates = await prisma.documentTemplate.findMany({
                    orderBy: [{ type: "asc" }, { name: "asc" }],
                    select: { id: true, name: true, type: true, isDefault: true, updatedAt: true },
                });
                return textResult(templates);
            },
        );

        server.registerTool(
            "list_contracts",
            {
                title: "List contracts for a job (or company-wide)",
                annotations: { readOnlyHint: true },
                description:
                    "Lists contracts with their signing status. Filter by projectId or leadId (from find_job), or omit both for the 50 most recent across the company. " +
                    "Statuses: Draft → Sent → Viewed → Signed (→ Finalized once the company countersigns, when required).",
                inputSchema: {
                    projectId: z.string().max(50).optional(),
                    leadId: z.string().max(50).optional(),
                },
            },
            async ({ projectId, leadId }) => {
                const contracts = await prisma.contract.findMany({
                    where: { ...(projectId ? { projectId } : {}), ...(leadId ? { leadId } : {}) },
                    take: 50,
                    orderBy: { createdAt: "desc" },
                    include: {
                        project: { select: { name: true, client: { select: { name: true } } } },
                        lead: { select: { name: true, client: { select: { name: true } } } },
                    },
                });
                return textResult(contracts.map(c => ({
                    ...contractSummary(c),
                    job: c.project?.name ?? c.lead?.name ?? null,
                    client: c.project?.client?.name ?? c.lead?.client?.name ?? null,
                })));
            },
        );

        server.registerTool(
            "get_contract",
            {
                title: "Read a contract (full text + signing state)",
                annotations: { readOnlyHint: true },
                description:
                    "Returns one contract's full HTML body and signing state. Signing placeholders appear raw in the body " +
                    "({{SIGNATURE_BLOCK}}, {{INITIAL_BLOCK}}, {{DATE_BLOCK}}, {{CONTRACTOR_SIGNATURE_BLOCK}}) — the client portal renders them as signature fields.",
                inputSchema: {
                    contractId: z.string().max(50).describe("Contract id from list_contracts or create_contract"),
                },
            },
            async ({ contractId }) => {
                const c = await prisma.contract.findUnique({
                    where: { id: contractId },
                    include: {
                        project: { select: { name: true, client: { select: { name: true, email: true } } } },
                        lead: { select: { name: true, client: { select: { name: true, email: true } } } },
                    },
                });
                if (!c) return { ...textResult({ error: "Contract not found" }), isError: true };
                const MAX_BODY = 60_000;
                const body = c.body || "";
                return textResult({
                    ...contractSummary(c),
                    job: c.project?.name ?? c.lead?.name ?? null,
                    client: c.project?.client?.name ?? c.lead?.client?.name ?? null,
                    clientEmail: c.project?.client?.email ?? c.lead?.client?.email ?? null,
                    hasClientSignatureBlock: CLIENT_SIGN_BLOCK_RE.test(body),
                    hasContractorSignatureBlock: CONTRACTOR_BLOCK_RE.test(body),
                    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
                    ...(body.length > MAX_BODY ? { bodyTruncated: `Body is ${body.length} chars; showing the first ${MAX_BODY}.` } : {}),
                });
            },
        );

        server.registerTool(
            "create_contract",
            {
                title: "Create a contract (Draft)",
                annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
                description:
                    "Creates a Draft contract on a project or lead — nothing is emailed until send_contract. " +
                    "EITHER pass templateId (from list_contract_templates) to instantiate a saved template, OR pass title + bodyHtml to write one from scratch. " +
                    "In bodyHtml, use merge placeholders and they resolve from the job's data at creation: {{client_name}}, {{client_address}}, {{company_name}}, {{company_license}}, " +
                    "{{project_name}}, {{location}}, {{estimate_total}}, {{estimate_number}}, {{payment_schedule}} (formatted milestone table), {{date}}. " +
                    "Include the signing fields where signatures belong: {{SIGNATURE_BLOCK}} (client signs), {{DATE_BLOCK}}, and optionally {{INITIAL_BLOCK}} per section " +
                    "and {{CONTRACTOR_SIGNATURE_BLOCK}} (company must pre-sign in ProBuild before the contract can be sent).",
                inputSchema: {
                    projectId: z.string().max(50).optional().describe("Project id from find_job (use exactly one of projectId/leadId)"),
                    leadId: z.string().max(50).optional().describe("Lead id from find_job, for jobs with no project yet"),
                    templateId: z.string().max(50).optional().describe("Template id from list_contract_templates"),
                    title: z.string().min(1).max(300).optional().describe("Contract title (required without templateId; optional override with one)"),
                    bodyHtml: z.string().min(1).max(400_000).optional().describe("Full HTML body of the agreement (required without templateId; ignored with one)"),
                },
            },
            async ({ projectId, leadId, templateId, title, bodyHtml }) => {
                if (!!projectId === !!leadId) return { ...textResult({ error: "Pass exactly one of projectId or leadId." }), isError: true };
                if (!templateId && (!title || !bodyHtml)) return { ...textResult({ error: "Without templateId, both title and bodyHtml are required." }), isError: true };
                const context = projectId ? { type: "project" as const, id: projectId } : { type: "lead" as const, id: leadId! };
                const exists = projectId
                    ? await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
                    : await prisma.lead.findUnique({ where: { id: leadId! }, select: { id: true } });
                if (!exists) return { ...textResult({ error: `${context.type} not found: ${context.id}` }), isError: true };

                const { createContractFromTemplate, createContractBlank } = await import("@/lib/actions");
                const contract = templateId
                    ? await createContractFromTemplate(templateId, context, title)
                    : await createContractBlank(context, title!, bodyHtml!);

                const warnings: string[] = [];
                if (!CLIENT_SIGN_BLOCK_RE.test(contract.body || "")) {
                    warnings.push("The body has no {{SIGNATURE_BLOCK}} — the client can still finalize via the portal's confirm step, but there will be no signature line in the document. Add one via update_contract if a drawn signature should appear.");
                }
                if (CONTRACTOR_BLOCK_RE.test(contract.body || "")) {
                    warnings.push("The body has a {{CONTRACTOR_SIGNATURE_BLOCK}} — someone at the company must sign it in ProBuild (Contracts tab) before send_contract will send it.");
                }
                return textResult({
                    contractId: contract.id,
                    title: contract.title,
                    status: contract.status,
                    requiresCountersign: contract.requiresCountersign,
                    url: projectId
                        ? `https://probuild.goldentouchremodeling.com/projects/${projectId}/contracts`
                        : `https://probuild.goldentouchremodeling.com/leads/${leadId}/contracts`,
                    warnings,
                    note: "Draft only — review with get_contract, edit with update_contract, then send_contract to email it for signature.",
                });
            },
        );

        server.registerTool(
            "update_contract",
            {
                title: "Edit a contract's title or body",
                annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
                description:
                    "Updates a contract's title and/or HTML body. Refused once the contract is Signed or Finalized. " +
                    "Note: merge placeholders like {{client_name}} in an updated body resolve when the client OPENS the contract, not at save time (signing blocks always stay raw until signed).",
                inputSchema: {
                    contractId: z.string().max(50),
                    title: z.string().min(1).max(300).optional(),
                    bodyHtml: z.string().min(1).max(400_000).optional(),
                },
            },
            async ({ contractId, title, bodyHtml }) => {
                if (title === undefined && bodyHtml === undefined) return { ...textResult({ error: "Pass title and/or bodyHtml." }), isError: true };
                // Same save-time normalization as updateContract in actions.ts: the portal
                // locates signing blocks by grepping for raw {{KEY}}, so any TipTap
                // merge-field spans must be folded back before the body is stored.
                const normalizedBody = bodyHtml === undefined
                    ? undefined
                    : bodyHtml.replace(/<span[^>]*data-merge-field=["'](\w+)["'][^>]*>[\s\S]*?<\/span>/g, "{{$1}}");
                // Atomic guard (not read-then-write): the update only lands while the row is
                // still unsigned by ANYONE. Editing after the contractor pre-signed would send
                // an altered document over their signature; after the client signed it's the
                // executed agreement. A signature landing concurrently makes count = 0.
                const res = await prisma.contract.updateMany({
                    where: { id: contractId, contractorSignedAt: null, status: { notIn: ["Signed", "Finalized"] } },
                    data: {
                        ...(title !== undefined ? { title } : {}),
                        ...(normalizedBody !== undefined ? { body: normalizedBody } : {}),
                    },
                });
                if (res.count === 0) {
                    const now = await prisma.contract.findUnique({ where: { id: contractId }, select: { status: true, contractorSignedAt: true } });
                    if (!now) return { ...textResult({ error: "Contract not found" }), isError: true };
                    if (now.contractorSignedAt) {
                        return { ...textResult({ error: "The contractor has already signed this contract, so its text can no longer be edited here — the signature would misrepresent what was signed. Edit it in ProBuild (job → Contracts) where the signature can be redone, or create a new contract." }), isError: true };
                    }
                    return { ...textResult({ error: `Cannot edit a contract that is already ${now.status}.` }), isError: true };
                }
                const updated = await prisma.contract.findUnique({ where: { id: contractId }, select: { id: true, title: true, status: true } });
                revalidatePath("/");
                return textResult({
                    contractId: updated!.id,
                    title: updated!.title,
                    status: updated!.status,
                    ...(updated!.status !== "Draft" ? { note: `This contract was already ${updated!.status} — anyone opening the previously emailed link now sees the updated text.` } : {}),
                });
            },
        );

        server.registerTool(
            "send_contract",
            {
                title: "Send a contract to the client for signature",
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                description:
                    "Emails the client a magic link to review and e-sign the contract in their portal. " +
                    "TWO-STEP: call without confirmToken for a preview (recipient, cc, title); show the user, then echo the confirmToken after they explicitly approve. " +
                    "Sends to the client on file (cc: their additional email + the assigned manager). Resending an already-signed contract re-emails the link without reopening it.",
                inputSchema: {
                    contractId: z.string().max(50).describe("Contract id from list_contracts or create_contract"),
                    confirmToken: z.string().max(40).optional().describe("Token from the preview response; supplying it executes the send"),
                },
            },
            async ({ contractId, confirmToken }) => {
                const c = await prisma.contract.findUnique({
                    where: { id: contractId },
                    include: {
                        project: { include: { client: { select: { name: true, email: true, additionalEmail: true } }, manager: { select: { email: true } } } },
                        lead: { include: { client: { select: { name: true, email: true, additionalEmail: true } }, manager: { select: { email: true } } } },
                    },
                });
                if (!c) return { ...textResult({ error: "Contract not found" }), isError: true };
                const client = c.project?.client ?? c.lead?.client;
                if (!client?.email) return { ...textResult({ error: "The client has no email on file — add one in ProBuild first." }), isError: true };
                if (CONTRACTOR_BLOCK_RE.test(c.body || "") && !c.contractorSignedAt) {
                    return { ...textResult({ error: "This contract has a contractor signature block that hasn't been signed yet. Someone at the company must sign it in ProBuild (job → Contracts) before it can be sent." }), isError: true };
                }

                // Bind the token to exactly what the preview showed: recipient set + full document text.
                const fingerprint = createHash("sha256")
                    .update(JSON.stringify({ title: c.title, body: c.body, status: c.status, requiresCountersign: c.requiresCountersign }))
                    .digest("hex").slice(0, 24);
                // Same normalization as buildCc in sendContractToClient (trim, case-insensitive
                // dedupe, drop the primary recipient) so the preview's cc list is exactly what
                // the email will carry.
                const primaryKey = client.email.trim().toLowerCase();
                const ccSeen = new Set<string>();
                const cc: string[] = [];
                for (const candidate of [client.additionalEmail, c.project?.manager?.email || c.lead?.manager?.email || null]) {
                    const e = candidate?.trim();
                    if (!e) continue;
                    const key = e.toLowerCase();
                    if (key === primaryKey || ccSeen.has(key)) continue;
                    ccSeen.add(key);
                    cc.push(e);
                }
                const payload = JSON.stringify({ contractId, recipient: client.email, cc, fingerprint });

                if (!verifyPreviewToken(confirmToken, payload)) {
                    return textResult({
                        preview: true,
                        contract: { title: c.title, status: c.status, requiresCountersign: c.requiresCountersign },
                        job: c.project?.name ?? c.lead?.name,
                        recipient: client.email,
                        clientName: client.name,
                        cc,
                        confirmToken: mintPreviewToken(payload),
                        instruction: "Show this to the user. Call again with this confirmToken ONLY after they explicitly approve the send.",
                    });
                }
                const { sendContractToClient } = await import("@/lib/actions");
                try {
                    // Pass the approved snapshot's fingerprint — the send action re-reads the
                    // contract and refuses if the text no longer matches what the user confirmed.
                    const result = await sendContractToClient(contractId, undefined, fingerprint, secretForActor(actor.actorLabel));
                    return textResult({ ...result, note: "The client reviews and signs via the emailed portal link. Track status with list_contracts / get_contract." });
                } catch (e) {
                    return { ...textResult({ error: e instanceof Error ? e.message : "Send failed" }), isError: true };
                }
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
                const openProjects = [...pipeline.waitingToStart, ...pipeline.scheduled, ...pipeline.inProgress];
                const unappliedChangeOrders = await getUnappliedChangeOrders(openProjects.map(project => project.id));
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
                        unappliedChangeOrders: unappliedChangeOrders[p.id] ?? { count: 0, items: [] },
                    })),
                    projects: openProjects.map(p => ({
                        projectId: p.id,
                        name: p.name,
                        status: p.status,
                        startDate: p.startDate?.slice(0, 10) ?? null,
                        crew: p.crew,
                        unappliedChangeOrders: unappliedChangeOrders[p.id] ?? { count: 0, items: [] },
                    })),
                    upcomingStarts: {
                        windowDays: horizonDays,
                        projects: calendar.projectStarts.map(p => ({
                            projectId: p.id, name: p.name, client: p.client, status: p.status, startDate: p.startDate.slice(0, 10),
                            crew: crewOf.get(p.id) ?? [],
                            unappliedChangeOrders: unappliedChangeOrders[p.id] ?? { count: 0, items: [] },
                        })),
                        leads: calendar.leadStarts.map(l => ({
                            leadId: l.id, name: l.name, client: l.client, stage: l.stage, expectedStartDate: l.expectedStartDate.slice(0, 10),
                        })),
                    },
                    // Conflict v2: assigned task windows plus per-(user,project)
                    // effective-work-window fallback, deduped per project pair.
                    crewConflicts,
                });
            },
        );

        server.registerTool(
            "get_project_schedule",
            {
                title: "Get one project's detailed schedule",
                annotations: { readOnlyHint: true },
                description:
                    "Returns every task for exactly one project, including YYYY-MM-DD dates, status, progress, crew names and lead, task/appointment fields, completion criteria, and material counts. " +
                    "Pass exactly one of projectId or the project's exact jobName. This read-only tool never returns rates or financial data.",
                inputSchema: {
                    projectId: z.string().max(50).optional().describe("Exact project id from list_projects, find_job, or get_company_schedule"),
                    jobName: z.string().trim().min(1).max(300).optional().describe("Exact project name, case-insensitive; use projectId if names are duplicated"),
                },
            },
            async args => {
                try {
                    return textResult(await getProjectSchedule(args));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to get project schedule" }), isError: true };
                }
            },
        );

        server.registerTool(
            "plan_schedule",
            {
                title: "Plan and bulk-create project schedule tasks",
                description:
                    "Creates 1–50 tasks atomically on a project. Dates must be real YYYY-MM-DD values; scheduledTime is 24-hour HH:MM and appointment-only. " +
                    "crewNames and leadName match ACTIVATED users by exact full name or first name; ambiguous names return candidates, and leadName must also appear in crewNames. " +
                    "TWO-STEP, SINGLE-USE: first call without confirmToken, show the complete task/date/crew preview, then call again with the returned 64-character confirmation token only after explicit user approval. Any invalid task rolls back the whole plan.",
                inputSchema: {
                    projectId: z.string().max(50).describe("Target project id"),
                    tasks: z.array(z.object({
                        name: z.string().trim().min(1).max(300),
                        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
                        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
                        type: z.enum(["task", "milestone", "appointment"]).optional(),
                        crewNames: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
                        leadName: z.string().trim().min(1).max(200).optional(),
                        doneWhen: z.string().max(2000).optional(),
                        scheduledTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM").optional(),
                        estimatedHours: z.number().min(0).max(100_000).optional(),
                    })).min(1).max(50),
                    confirmToken: z.string().length(64).optional().describe("Single-use token from this exact plan_schedule preview"),
                },
            },
            async args => {
                try {
                    return textResult(await planSchedule(args, actor.actorLabel));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to plan schedule" }), isError: true };
                }
            },
        );

        server.registerTool(
            "update_task_dates",
            {
                title: "Update a schedule task's dates",
                description:
                    "Moves one task's startDate and/or endDate. Dates must use YYYY-MM-DD; normal tasks require endDate after startDate and milestones stay on one day. " +
                    "TWO-STEP, SINGLE-USE: call without confirmToken for the exact before/after preview, obtain user approval, then repeat the same arguments with that token.",
                inputSchema: {
                    taskId: z.string().max(50),
                    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
                    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await updateTaskDates(args, actor.actorLabel));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to update task dates" }), isError: true };
                }
            },
        );

        server.registerTool(
            "set_task_status",
            {
                title: "Set a schedule task's status",
                description:
                    "Sets status to Not Started, In Progress, Complete, or Blocked. Blocked requires a non-empty blockedReason; moving away from Blocked clears it. " +
                    "TWO-STEP, SINGLE-USE: call without confirmToken for a preview, show it to the user, then repeat the exact arguments with the returned token after approval.",
                inputSchema: {
                    taskId: z.string().max(50),
                    status: z.enum(["Not Started", "In Progress", "Complete", "Blocked"]),
                    blockedReason: z.string().trim().max(2000).optional(),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await setTaskStatus(args, actor.actorLabel));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to set task status" }), isError: true };
                }
            },
        );

        server.registerTool(
            "assign_task_crew",
            {
                title: "Replace a task's crew and lead",
                description:
                    "Replaces one task's complete crew list using ACTIVATED first-name or exact full-name matches; ambiguous names return candidates. leadName is optional but must also appear in crewNames. " +
                    "TWO-STEP, SINGLE-USE: call without confirmToken for the replacement preview, show it to the user, then repeat the exact arguments with the token after approval.",
                inputSchema: {
                    taskId: z.string().max(50),
                    crewNames: z.array(z.string().trim().min(1).max(200)).max(50),
                    leadName: z.string().trim().min(1).max(200).optional(),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await assignTaskCrew(args, actor.actorLabel));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to assign task crew" }), isError: true };
                }
            },
        );

        server.registerTool(
            "list_crew_availability",
            {
                title: "List field-crew availability",
                annotations: { readOnlyHint: true },
                description:
                    "For each ACTIVATED FIELD_CREW member and each requested day, returns booked task names or free. startDate must be YYYY-MM-DD and days must be 1–14. " +
                    "This read-only output deliberately excludes emails, rates, costs, budgets, and every other financial field.",
                inputSchema: {
                    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
                    days: z.number().int().min(1).max(14),
                },
            },
            async args => {
                try {
                    return textResult(await listCrewAvailability(args));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to list crew availability" }), isError: true };
                }
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
                    "TWO-STEP, SINGLE-USE: call without confirmToken for the effect preview, show it to the user, then repeat the exact arguments with that token after approval.",
                inputSchema: {
                    projectId: z.string().max(50).describe("Project id from get_company_schedule or list_projects"),
                    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD (no time component)").nullable().describe("New start date as YYYY-MM-DD; null clears the start marker"),
                    shiftJobTasks: z.boolean().optional().describe("Shift the job's tasks and linked milestones by the same delta (default true)"),
                    confirmToken: z.string().length(64).optional().describe("Single-use token from this exact preview"),
                },
            },
            async args => {
                try {
                    return textResult(await setProjectStartDateWithConfirmation(args, actor.actorLabel));
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
                    "TWO-STEP, SINGLE-USE: call without confirmToken for a preview, then repeat the exact arguments with that token only after explicit approval.",
                inputSchema: {
                    estimateId: z.string().max(50).describe("Estimate id (from find_job or list_project_billing) — must be Approved+ and on a project with a start date"),
                    mode: z.enum(["merge", "regenerate"]).optional().describe("'merge' (default) fills gaps; 'regenerate' rebuilds untouched generated tasks"),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await generateProjectScheduleWithConfirmation(args, actor.actorLabel));
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
                    "the crewConflicts block in get_company_schedule. TWO-STEP, SINGLE-USE: preview first, then repeat the exact arguments with confirmToken after approval.",
                inputSchema: {
                    projectId: z.string().max(50).describe("Project id from get_company_schedule or list_projects"),
                    userIds: z.array(z.string().max(50)).max(50).describe("ACTIVATED user ids to assign — the FULL crew (not a delta); empty array clears the crew"),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await assignProjectCrewWithConfirmation(args, actor.actorLabel));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to assign crew" }), isError: true };
                }
            },
        );

        server.registerTool(
            "apply_change_order_to_schedule",
            {
                title: "Apply an approved change order to the project schedule",
                description:
                    "Adds an Approved change order's positive-scope tasks and payment milestones to its project's schedule. " +
                    "Deductions are reported for manual trimming and never remove existing tasks automatically. " +
                    "Default merge mode is idempotent; regenerate rebuilds only untouched CO-generated task subtrees. " +
                    "TWO-STEP, SINGLE-USE: preview first, then repeat the exact arguments with confirmToken after approval.",
                inputSchema: {
                    changeOrderId: z.string().max(50).describe("Approved change-order id"),
                    mode: z.enum(["merge", "regenerate"]).optional().describe("'merge' (default) applies once; 'regenerate' rebuilds only untouched generated work"),
                    confirmToken: z.string().length(64).optional(),
                },
            },
            async args => {
                try {
                    return textResult(await applyChangeOrderToScheduleWithConfirmation(args, actor.actorLabel));
                } catch (e: any) {
                    return { ...textResult({ error: e?.message ?? "Failed to apply change order to schedule" }), isError: true };
                }
            },
        );

        server.registerTool(
            "get_activity_log",
            {
                title: "Review recent ProBuild activity",
                annotations: { readOnlyHint: true },
                description:
                    "Returns the audit trail of actions taken through connectors and the app — newest first: who did what, on which project/lead, and whether a customer-facing send " +
                    "actually went out or was only previewed. Use to answer 'what did I just do?' or 'what changed on this project recently?'.",
                inputSchema: {
                    limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 25)"),
                    projectId: z.string().max(50).optional().describe("Restrict to one project's activity"),
                    leadId: z.string().max(50).optional().describe("Restrict to one lead's activity"),
                    actionContains: z.string().max(60).optional().describe("Case-insensitive substring filter on the action, e.g. 'send'"),
                    sinceDays: z.number().int().min(1).max(90).optional().describe("How many days back to look (default 7)"),
                },
            },
            async ({ limit, projectId, leadId, actionContains, sinceDays }) => {
                const effectiveSinceDays = sinceDays ?? 7;
                const where: Record<string, unknown> = {
                    createdAt: { gte: new Date(Date.now() - effectiveSinceDays * 24 * 60 * 60 * 1000) },
                };
                if (projectId) where.projectId = projectId;
                if (leadId) where.leadId = leadId;
                if (actionContains) where.action = { contains: actionContains, mode: "insensitive" };

                const logs = await prisma.activityLog.findMany({
                    where,
                    orderBy: { createdAt: "desc" },
                    take: limit ?? 25,
                    select: {
                        createdAt: true,
                        actorName: true,
                        action: true,
                        entityType: true,
                        entityName: true,
                        projectId: true,
                        leadId: true,
                        metadata: true,
                    },
                });

                const projectIds = [...new Set(logs.map(l => l.projectId).filter((id): id is string => !!id))];
                const projects = projectIds.length
                    ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
                    : [];
                const projectNameById = new Map(projects.map(p => [p.id, p.name]));

                return textResult(logs.map(l => ({
                    createdAt: l.createdAt,
                    actorName: l.actorName,
                    action: l.action,
                    entityType: l.entityType,
                    entityName: l.entityName,
                    projectId: l.projectId,
                    projectName: l.projectId ? (projectNameById.get(l.projectId) ?? null) : null,
                    leadId: l.leadId,
                    metadata: l.metadata ? JSON.parse(l.metadata) : null,
                })));
            },
        );
    },
    {
        serverInfo: { name: "probuild", version: "1.14.0" },
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
            "Change-order lifecycle: create_change_order (draft, including cost-plus and fixed milestone schedules) → send_change_order (preview + user approval; customer signs via portal) → " +
            "once Approved, log_time/log_expense record cost-plus actuals and bill_change_order previews then bills them; fixed orders bill directly → send_milestone_invoice emails the payment link and T&M backup. " +
            "FILES: upload_file parks documents (RFQs, RFIs, spec sheets, generated spreadsheets) on a project's or lead's Files tab — base64 content, ~3 MB max, optional folder. " +
            "Uploads default to internal visibility; only pass visibility 'shared' (customer-visible in the portal) when the user explicitly asks. " +
            "PROJECT MANAGEMENT: use find_job to resolve the project/lead; standard project folders are ensured implicitly by list_project_files and upload_files when needed. " +
            "Use upload_files for up to 8 files / ~3 MB total, then create_daily_log with already-uploaded photo ProjectFile ids so image bytes are not sent twice. " +
            "Use list_punch_items and add_punch_items for punch lists; punch completion is intentionally human-only. " +
            "FILE ROUND TRIP: upload_file/upload_files puts documents in, list_project_files shows what's there (metadata and folder structure only, no URLs), " +
            "read_file pulls a PDF/Word/text file's actual extracted text, and get_file_link returns a view/download link for anything "
            + "(signed and expiring for private documents, a permanent public URL otherwise — the response says which). " +
            "Photos, drawings, scans and signed PDFs typically have no text layer to extract, so get_file_link (not read_file) is the right tool for them. " +
            "get_activity_log reviews the audit trail of connector actions — who did what, and whether a customer-facing send actually went out or was only previewed. " +
            "SCHEDULING: get_company_schedule answers 'what jobs are waiting to start?' and lists upcoming project starts (plus lead expected starts) " +
            "for the next N days, with each project's crew and a crewConflicts block (double-bookings across overlapping project windows). " +
            "get_project_schedule returns one job's task-level plan; list_crew_availability returns only field-crew bookings/free days and never rates or financials. " +
            "plan_schedule bulk-creates up to 50 tasks; update_task_dates, set_task_status, and assign_task_crew refine individual tasks. " +
            "Every schedule-writing tool uses a single-use TWO-STEP confirmation: call without confirmToken, show the returned preview, and only repeat the exact arguments with that token after explicit user approval. Never self-confirm. " +
            "set_project_start_date moves a project's company start date — for a project still Waiting to Start it also shifts " +
            "the job's tasks and linked milestones by the same delta (pass shiftJobTasks false to move only the marker); milestone groups already pushed " +
            "to QuickBooks are never shifted and come back in skippedQbMilestones for manual fixing. " +
            "generate_project_schedule builds a project's schedule from its estimate (the estimate must be Approved/Invoiced/Partially Paid/Paid and " +
            "the project needs a start date first — set one with set_project_start_date); default 'merge' mode is idempotent, 'regenerate' rebuilds untouched generated tasks. " +
            "change orders adjust the schedule — approve in ProBuild (auto) or call apply_change_order_to_schedule; deductions never auto-remove tasks. " +
            "assign_project_crew replaces a project's crew with the given ACTIVATED user ids (full list, not a delta). " +
            "QuickBooks is handled server-side; never ask the user for QuickBooks credentials.",
    },
        { basePath: "/api/mcp", maxDuration: 60 },
    );
}

// Shared-secret gate. Hash both sides to a fixed length before the timing-safe
// compare so neither content nor secret length leaks through timing.
export function resolveMcpActorLabel(req: Request): McpActorLabel | null {
    const key = new URL(req.url).searchParams.get("key") ?? "";
    const suppliedHash = createHash("sha256").update(key).digest();
    let matched: McpActorLabel | null = null;
    const candidates: Array<[McpActorLabel, string | undefined]> = [
        ["justin-ai", process.env.MCP_SECRET],
        ["richard-ai", process.env.MCP_SECRET_RICHARD],
    ];
    for (const [actorLabel, secret] of candidates) {
        const configuredHash = createHash("sha256").update(secret ?? "").digest();
        const equal = timingSafeEqual(suppliedHash, configuredHash);
        if (key.length > 0 && secret && equal && matched === null) matched = actorLabel;
    }
    return matched;
}

function guarded(req: Request) {
    if (!process.env.MCP_SECRET && !process.env.MCP_SECRET_RICHARD) {
        return Response.json({ error: "MCP connector not configured" }, { status: 503 });
    }
    const actorLabel = resolveMcpActorLabel(req);
    if (!actorLabel) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    // onBehalfOf rewrites the AUDIT attribution — actorUserId and the
    // "(via <person>)" label — so a bare query param is not enough: an external
    // connector holding a key could stamp any teammate's id onto its own writes
    // and the audit trail would swear that person did it. Only help-agent.ts
    // may set it, and it proves it is server-side code by sending a digest of a
    // secret that never leaves the server. No proof → the param is ignored and
    // attribution falls back to the key's own account (fail closed, not fatal).
    const onBehalfOfId = new URL(req.url).searchParams.get("onBehalfOf");
    const honoredOnBehalfOf =
        onBehalfOfId && isInternalOnBehalfProof(req.headers.get("x-probuild-internal"))
            ? onBehalfOfId
            : null;
    return createHandler(createRouteMcpActor(actorLabel, honoredOnBehalfOf))(req);
}

function isInternalOnBehalfProof(header: string | null): boolean {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret || !header) return false;
    const expected = createHash("sha256").update(`mcp-onbehalf:${secret}`).digest();
    const provided = Buffer.from(header, "hex");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
