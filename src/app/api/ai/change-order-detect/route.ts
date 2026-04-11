import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const { projectId }: { projectId: string } = await req.json();
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, type: true, status: true },
    });

    const dailyLogs = await prisma.dailyLog.findMany({
        where: { projectId },
        orderBy: { date: "asc" },
        select: {
            id: true,
            date: true,
            workPerformed: true,
            materialsDelivered: true,
            issues: true,
            crewOnSite: true,
        },
    });

    if (dailyLogs.length === 0) {
        return NextResponse.json({ error: "No daily logs found for this project" }, { status: 404 });
    }

    const logSummary = dailyLogs.map(log => {
        const date = new Date(log.date).toISOString().split("T")[0];
        let entry = `[${date}] Work: ${log.workPerformed}`;
        if (log.materialsDelivered) entry += ` | Materials: ${log.materialsDelivered}`;
        if (log.issues) entry += ` | Issues: ${log.issues}`;
        if (log.crewOnSite) entry += ` | Crew: ${log.crewOnSite}`;
        return entry;
    }).join("\n");

    const prompt = `You are an expert construction project manager reviewing daily logs for potential change orders on a remodeling project.

Project: ${project?.name || projectId} (${project?.type || "Remodel"})
Total Daily Logs: ${dailyLogs.length}

DAILY LOG ENTRIES:
${logSummary}

Carefully analyze every daily log entry and identify any mentions of:
- Scope changes (work added or removed from original scope)
- Client requests or change requests
- Additions or modifications to the original plan
- Unexpected conditions requiring extra work
- Material substitutions that affect cost
- Work stoppages or delays caused by design changes
- Any "extras" or work beyond the contracted scope

For each potential change order detected, provide:
1. The date it was mentioned
2. A description of the scope change
3. Why it qualifies as a potential change order
4. Recommended action (document, price, discuss with client)
5. Estimated impact (Low / Medium / High)

Format your response as:

SUMMARY
Total potential change orders detected: [number]
Overall risk level: [Low | Medium | High]

DETECTED CHANGE ORDERS:

CO-1: [Title]
Date: [date from log]
Description: [what changed]
Justification: [why this is a change order]
Impact: [Low | Medium | High]
Action: [recommended next step]

CO-2: [Title]
...

RECOMMENDATIONS:
- [overall recommendations for managing these change orders]
- [suggestions for documentation improvements]

If no potential change orders are detected, state that clearly and provide tips for what to watch for in future daily logs.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const detections = response.content[0].type === "text" ? response.content[0].text.trim() : "";

    return NextResponse.json({ success: true, detections });
}
