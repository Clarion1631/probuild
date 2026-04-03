import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const { leadId } = await req.json();
    if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });

    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: {
            client: true,
            notes: { orderBy: { createdAt: "desc" }, take: 10 },
            estimates: { select: { status: true, totalAmount: true } },
            tasks: { select: { status: true, title: true } },
        },
    });

    if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

    const context = `
Lead: ${lead.name}
Stage: ${lead.stage}
Source: ${lead.source || "Unknown"}
Project Type: ${lead.projectType || "Unknown"}
Target Revenue: ${lead.targetRevenue ? `$${lead.targetRevenue.toLocaleString()}` : "Not set"}
Expected Start: ${lead.expectedStartDate ? new Date(lead.expectedStartDate).toLocaleDateString() : "Not set"}
Created: ${new Date(lead.createdAt).toLocaleDateString()}
Last Activity: ${new Date(lead.lastActivityAt).toLocaleDateString()}

Notes (${lead.notes.length}):
${lead.notes.map(n => `- ${n.content}`).join("\n") || "None"}

Estimates (${lead.estimates.length}):
${lead.estimates.map(e => `- ${e.status}: $${(e.totalAmount || 0).toLocaleString()}`).join("\n") || "None"}

Open Tasks: ${lead.tasks.filter(t => t.status !== "Done").length}
`;

    const prompt = `You are an expert construction sales analyst for a residential remodeling company in Vancouver, WA (Golden Touch Remodeling).

Analyze this lead and provide a scoring and recommendations report.

${context}

Return your analysis in this exact format:

CLOSE PROBABILITY: [X]%
QUALITY RATING: [Excellent | Good | Fair | Poor]
DEAL SIZE: [Small <$10k | Medium $10-50k | Large $50-150k | Major >$150k]

KEY STRENGTHS:
- [strength 1]
- [strength 2]

KEY RISKS:
- [risk 1]
- [risk 2]

RECOMMENDED NEXT ACTIONS:
1. [action 1 — specific and time-bound]
2. [action 2]
3. [action 3]

CONFIDENCE NOTE: [1-2 sentences on what would increase or decrease this score]`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const analysis = response.content[0].text.trim();

    // Parse probability
    const probMatch = analysis.match(/CLOSE PROBABILITY:\s*(\d+)%/);
    const probability = probMatch ? parseInt(probMatch[1]) : null;

    return NextResponse.json({ success: true, analysis, probability });
}
