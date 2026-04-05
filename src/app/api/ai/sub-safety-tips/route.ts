import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const { subcontractorId } = await req.json();
    if (!subcontractorId) {
        return NextResponse.json({ error: "subcontractorId required" }, { status: 400 });
    }

    // Fetch subcontractor details
    const sub = await prisma.subcontractor.findUnique({
        where: { id: subcontractorId },
        select: { companyName: true, contactName: true, trade: true },
    });

    if (!sub) {
        return NextResponse.json({ error: "Subcontractor not found" }, { status: 404 });
    }

    // Fetch current assigned tasks across all projects
    const assignments = await prisma.subTaskAssignment.findMany({
        where: { subcontractorId },
        include: {
            task: {
                select: {
                    name: true,
                    status: true,
                    startDate: true,
                    endDate: true,
                },
            },
        },
    });

    // Filter to active/upcoming tasks only
    const now = new Date();
    const activeTasks = assignments
        .filter((a) => a.task.status !== "Completed")
        .map((a) => a.task);

    const taskList = activeTasks.map((t) => `- ${t.name} (${t.status})`).join("\n");

    const prompt = `You are a construction safety expert providing daily safety tips for a subcontractor crew.

Subcontractor: ${sub.companyName}
Trade/Specialty: ${sub.trade || "General Construction"}
Current Active Tasks:
${taskList || "No active tasks currently."}

Generate exactly 4 safety tips that are:
1. Specific to the trade "${sub.trade || "General Construction"}" and the types of tasks listed above
2. Practical and actionable (not generic advice)
3. Relevant to current season/weather considerations
4. Focused on OSHA compliance where applicable

Format your response as a JSON array of objects with "title" (short, 3-6 words) and "tip" (1-2 sentences, specific and actionable) fields. Example:
[
  {"title": "Ladder Safety Check", "tip": "Inspect all ladders for damaged rungs before each use. Maintain 3-point contact and set at a 4:1 angle ratio."}
]

Return ONLY the JSON array, no other text.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // Parse the JSON response, falling back to raw text
    let tips: Array<{ title: string; tip: string }> = [];
    try {
        // Handle potential markdown code block wrapping
        const cleaned = text.trim().replace(/^```json?\s*/, "").replace(/\s*```$/, "");
        tips = JSON.parse(cleaned);
    } catch {
        // If parsing fails, create a single tip from the raw text
        tips = [{ title: "Safety Reminder", tip: text.trim() }];
    }

    return NextResponse.json({ success: true, tips });
}
