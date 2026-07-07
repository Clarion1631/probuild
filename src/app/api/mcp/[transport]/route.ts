import { createHash, timingSafeEqual } from "crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createEstimateFromPhases, CLOSED_PROJECT_STATUSES, CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";

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
                title: "Get ProBuild cost codes and cost types",
                description: "Returns the active cost codes and cost types. ALWAYS call this before create_estimate and put a valid costCode + costType on every line item.",
                inputSchema: {},
            },
            async () => {
                const [costCodes, costTypes] = await Promise.all([
                    prisma.costCode.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { code: true, name: true, description: true } }),
                    prisma.costType.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { name: true } }),
                ]);
                return textResult({ costCodes, costTypes: costTypes.map(t => t.name) });
            },
        );

        server.registerTool(
            "create_estimate",
            {
                title: "Create a draft estimate in ProBuild",
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
    },
    {
        serverInfo: { name: "probuild", version: "1.0.0" },
        capabilities: { tools: {} },
        instructions:
            "ProBuild is Golden Touch Remodeling's construction management system. " +
            "To build an estimate: call get_estimating_codes, draft phases with line items using those cost codes and cost types, " +
            "confirm the target project or lead with the user (list_projects / list_leads), then create_estimate. " +
            "All prices are USD sell prices. Estimates arrive as private drafts for review in ProBuild.",
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
