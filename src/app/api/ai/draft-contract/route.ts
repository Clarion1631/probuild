import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAnthropicText } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";

const ESTIMATE_ITEM_SELECT = {
    id: true, code: true, title: true, status: true,
    totalAmount: true, balanceDue: true, createdAt: true,
    items: { where: { parentId: null }, orderBy: { order: "asc" }, select: { name: true, type: true, total: true } },
} as const;

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const body = await req.json();
    const { projectId, leadId, estimateId } = body as { projectId?: string; leadId?: string; estimateId?: string };

    if (!projectId && !leadId) {
        return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
    }
    if (projectId && leadId) {
        return NextResponse.json({ error: "Provide projectId or leadId, not both" }, { status: 400 });
    }

    const companySettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

    let clientName = "{{client_name}}";
    let clientAddress = "{{client_address}}";
    let entityName = "{{project_name}}";
    let entityLocation: string | null = null;
    let estimate: any = null;

    if (projectId) {
        // ── PROJECT PATH ──
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true },
        });
        if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

        clientName = project.client?.name || "{{client_name}}";
        clientAddress = [project.client?.addressLine1, project.client?.city, project.client?.state, project.client?.zipCode].filter(Boolean).join(", ") || "{{client_address}}";
        entityName = project.name;
        entityLocation = project.location;

        estimate = estimateId
            ? await prisma.estimate.findUnique({ where: { id: estimateId }, select: ESTIMATE_ITEM_SELECT })
            : await prisma.estimate.findFirst({
                where: { projectId, status: { in: ["Approved", "Sent"] } },
                select: ESTIMATE_ITEM_SELECT,
              });

        // Fall back to any estimate if no approved/sent one
        if (!estimate) {
            estimate = await prisma.estimate.findFirst({
                where: { projectId },
                orderBy: { createdAt: "desc" },
                select: ESTIMATE_ITEM_SELECT,
            });
        }
    } else {
        // ── LEAD PATH ──
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: { client: true },
        });
        if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

        clientName = lead.client?.name || "{{client_name}}";
        clientAddress = [lead.client?.addressLine1, lead.client?.city, lead.client?.state, lead.client?.zipCode].filter(Boolean).join(", ") || "{{client_address}}";
        entityName = lead.name;
        entityLocation = lead.location ?? null;

        estimate = await prisma.estimate.findFirst({
            where: { leadId, status: { in: ["Approved", "Sent"] } },
            orderBy: { createdAt: "desc" },
            select: ESTIMATE_ITEM_SELECT,
        });

        // Fall back to any estimate on the lead
        if (!estimate) {
            estimate = await prisma.estimate.findFirst({
                where: { leadId },
                orderBy: { createdAt: "desc" },
                select: ESTIMATE_ITEM_SELECT,
            });
        }

        // No estimate at all — reject with a clear, actionable message
        if (!estimate) {
            return NextResponse.json({
                error: "No estimate found for this lead. Create an estimate first so the AI can draft a contract with accurate scope and pricing.",
            }, { status: 422 });
        }
    }

    const scopeItems = (estimate?.items || [])
        .filter((i: any) => i.type !== "Note")
        .map((i: any) => `- ${i.name}: $${Number(i.total).toLocaleString()}`)
        .join("\n");

    const prompt = `You are an expert construction contract attorney and contractor for residential remodeling in Vancouver, WA (Clark County).

Draft a professional construction contract for the following project. Use plain HTML with clear headings and numbered sections. Make it legally sound but readable for homeowners.

COMPANY: ${companySettings?.companyName || "Golden Touch Remodeling"}
ADDRESS: ${companySettings?.address || "Vancouver, WA"}
PHONE: ${companySettings?.phone || ""}

CLIENT: {{client_name}}
CLIENT ADDRESS: {{client_address}}
PROJECT: {{project_name}}
LOCATION: ${entityLocation || "{{location}}"}
DATE: {{date}}

CONTRACT AMOUNT: $${Number(estimate?.totalAmount || 0).toLocaleString()}

SCOPE OF WORK:
${scopeItems || "As detailed in the attached estimate"}

PAYMENT SCHEDULE: Per the attached estimate payment schedule

Include these sections:
1. Parties and Project Description
2. Scope of Work (reference the attached estimate — use {{project_name}} as the project reference)
3. Contract Price and Payment Terms
4. Project Schedule and Timeline
5. Materials and Labor
6. Change Orders
7. Permits and Inspections
8. Warranty (1 year workmanship, manufacturer warranties pass-through)
9. Insurance and Liability
10. Dispute Resolution (Clark County, WA jurisdiction)
11. Termination
12. Entire Agreement
13. Signature Block: {{SIGNATURE_BLOCK}} for both contractor and client

Use HTML formatting with <h2> for sections, <p> for paragraphs, <ul>/<li> for lists.
Use {{client_name}}, {{project_name}}, {{date}}, {{SIGNATURE_BLOCK}} as merge fields.
Write in a professional but accessible tone appropriate for Clark County, WA homeowners.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const contractHtml = getAnthropicText(response.content)
        .replace(/^```html\n?/, "")
        .replace(/\n?```$/, "");

    return NextResponse.json({ success: true, contractHtml, estimateTotal: estimate?.totalAmount || 0 });
}
