import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

interface ScheduleTask {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    progress: number;
    status: string;
    type: string;
    estimatedHours: number | null;
    actualHours: number;
    dependencies: Array<{ predecessorId: string }>;
}

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const { projectId, tasks }: { projectId: string; tasks: ScheduleTask[] } = await req.json();
    if (!projectId || !tasks) return NextResponse.json({ error: "projectId and tasks required" }, { status: 400 });

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, type: true, status: true },
    });

    const today = new Date().toISOString().split("T")[0];

    const taskSummary = tasks.map(t => {
        const start = new Date(t.startDate);
        const end = new Date(t.endDate);
        const durationDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        const isPast = end < new Date();
        const isActive = start <= new Date() && end >= new Date();
        const hoursVariance = t.estimatedHours && t.actualHours > 0
            ? `${t.actualHours.toFixed(0)}/${t.estimatedHours}h actual/est`
            : "";

        return `- ${t.name} | ${t.startDate} → ${t.endDate} (${durationDays}d) | ${t.progress}% done | ${t.status}${isPast && t.progress < 100 ? " ⚠️OVERDUE" : ""}${isActive ? " 🔵ACTIVE" : ""} ${hoursVariance} | deps: ${t.dependencies.length}`;
    }).join("\n");

    const prompt = `You are an expert construction project manager analyzing a schedule for a residential remodeling project in Vancouver, WA.

Project: ${project?.name || projectId} (${project?.type || "Remodel"})
Today: ${today}
Total Tasks: ${tasks.length}

SCHEDULE:
${taskSummary}

Analyze this schedule and identify risks, bottlenecks, and recommendations.

Format your response as:

OVERALL RISK LEVEL: [Low | Medium | High | Critical]

CRITICAL RISKS (must address immediately):
- [risk + recommended action]
- [risk + recommended action]

SCHEDULE GAPS & BOTTLENECKS:
- [gap or bottleneck with impact analysis]
- [gap or bottleneck]

OVERDUE TASKS (${tasks.filter(t => new Date(t.endDate) < new Date() && t.progress < 100).length} detected):
- [list each overdue task with recommended recovery action]

BUFFER RECOMMENDATIONS:
- [where to add schedule buffer and how much]
- [buffer recommendation]

RESOURCE RISKS:
- [dependency chains that create risk if one task slips]

FORECAST: At this pace, the project is [on track | X days behind | X days ahead].
Recommended completion adjustment: [date or "none needed"].`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const textBlock = response.content.find(b => b.type === 'text');
    const analysis = (textBlock && 'text' in textBlock ? (textBlock as any).text as string : '').trim();

    return NextResponse.json({ success: true, analysis });
}
