import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const { id } = await params;

    const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
            client: { select: { name: true } },
            estimates: { select: { totalAmount: true, status: true } },
            notes: { orderBy: { createdAt: "desc" }, take: 5, select: { content: true } },
            meetings: { select: { status: true, meetingType: true } },
            tasks: { where: { status: { not: "Done" } }, select: { title: true } },
        },
    });

    if (!lead) {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    const daysSinceActivity = Math.floor(
        (Date.now() - new Date(lead.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    const estimateTotal = lead.estimates.reduce((sum, e) => sum + (e.totalAmount || 0), 0);
    const hasSignedEstimate = lead.estimates.some(e => e.status === "Approved");
    const meetingCount = lead.meetings.filter(m => m.status === "Completed").length;
    const recentNotes = lead.notes.map(n => n.content).join(" | ").slice(0, 500);

    const prompt = `You are a sales scoring AI for a remodeling contractor. Score this lead from 0-100 based on close probability.

Lead data:
- Name: ${lead.name}
- Stage: ${lead.stage}
- Project type: ${lead.projectType || "Unknown"}
- Target revenue: ${lead.targetRevenue ? `$${lead.targetRevenue.toLocaleString()}` : "Not specified"}
- Days since last activity: ${daysSinceActivity}
- Estimate total: ${estimateTotal > 0 ? `$${estimateTotal.toLocaleString()}` : "No estimates yet"}
- Has approved estimate: ${hasSignedEstimate ? "Yes" : "No"}
- Completed meetings: ${meetingCount}
- Recent notes: ${recentNotes || "None"}
- Expected start: ${lead.expectedStartDate ? new Date(lead.expectedStartDate).toLocaleDateString() : "Not set"}

Scoring criteria:
- Stage progression (New=10pts, Followed Up=25pts, Connected=40pts, Estimate Sent=60pts, Won=100pts)
- Budget size bonus (>50k=+15, >20k=+10, >10k=+5)
- Recent activity (0-7 days=+10, 8-14 days=+5, >30 days=-10)
- Completed meetings (+5 each, max +15)
- Approved estimate (+20)
- Open tasks penalty (-5 each, max -15)

Return ONLY a JSON object with these exact fields:
{
  "score": <number 0-100>,
  "rating": "<Hot|Warm|Cold>",
  "summary": "<one sentence, max 120 chars>",
  "topFactors": ["<factor 1>", "<factor 2>", "<factor 3>"]
}`;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 512,
            messages: [{ role: "user", content: prompt }],
        });

        const text = (response.content[0] as { type: "text"; text: string }).text || "{}";

        let result: { score?: number; rating?: string; summary?: string; topFactors?: string[] };
        try {
            result = JSON.parse(text);
        } catch {
            const match = text.match(/\{[\s\S]*\}/);
            result = match ? JSON.parse(match[0]) : {};
        }

        return NextResponse.json({
            score: Math.min(100, Math.max(0, result.score || 0)),
            rating: result.rating || "Cold",
            summary: result.summary || "",
            topFactors: result.topFactors || [],
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message || "Scoring failed" }, { status: 500 });
    }
}
