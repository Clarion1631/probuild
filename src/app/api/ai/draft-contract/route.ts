import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(req: NextRequest) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });

    const { projectId, estimateId } = await req.json();
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

    const [project, estimate, companySettings] = await Promise.all([
        prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true },
        }),
        estimateId
            ? prisma.estimate.findUnique({
                where: { id: estimateId },
                include: { items: { where: { parentId: null }, orderBy: { order: "asc" } } },
              })
            : prisma.estimate.findFirst({
                where: { projectId, status: { in: ["Approved", "Sent"] } },
                include: { items: { where: { parentId: null }, orderBy: { order: "asc" } } },
              }),
        prisma.companySettings.findUnique({ where: { id: "singleton" } }),
    ]);

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const scopeItems = (estimate?.items || [])
        .filter(i => i.type !== "Note")
        .map(i => `- ${i.name}: $${i.total.toLocaleString()}`)
        .join("\n");

    const prompt = `You are an expert construction contract attorney and contractor for residential remodeling in Vancouver, WA (Clark County).

Draft a professional construction contract for the following project. Use plain HTML with clear headings and numbered sections. Make it legally sound but readable for homeowners.

COMPANY: ${companySettings?.companyName || "Golden Touch Remodeling"}
ADDRESS: ${companySettings?.address || "Vancouver, WA"}
PHONE: ${companySettings?.phone || ""}

CLIENT: {{client_name}}
CLIENT ADDRESS: {{client_address}}
PROJECT: {{project_name}}
LOCATION: ${project.location || "{{location}}"}
DATE: {{date}}

CONTRACT AMOUNT: $${(estimate?.totalAmount || 0).toLocaleString()}

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

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const contractHtml = result.response.text().trim()
        .replace(/^```html\n?/, "")
        .replace(/\n?```$/, "");

    return NextResponse.json({ success: true, contractHtml, estimateTotal: estimate?.totalAmount || 0 });
}
