import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const { projectId, subcontractorId } = await req.json();
    if (!projectId || !subcontractorId) {
        return NextResponse.json({ error: "projectId and subcontractorId required" }, { status: 400 });
    }

    // Fetch project details
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, status: true, location: true },
    });

    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Fetch subcontractor details
    const sub = await prisma.subcontractor.findUnique({
        where: { id: subcontractorId },
        select: { companyName: true, contactName: true, trade: true },
    });

    if (!sub) {
        return NextResponse.json({ error: "Subcontractor not found" }, { status: 404 });
    }

    // Fetch assigned tasks for this sub on this project
    const assignments = await prisma.subTaskAssignment.findMany({
        where: {
            subcontractorId,
            task: { projectId },
        },
        include: {
            task: {
                select: {
                    id: true,
                    name: true,
                    status: true,
                    progress: true,
                    startDate: true,
                    endDate: true,
                    estimatedHours: true,
                    type: true,
                },
            },
        },
        orderBy: { task: { startDate: "asc" } },
    });

    const tasks = assignments.map((a) => a.task);
    const today = new Date().toISOString().split("T")[0];

    const taskDetails = tasks.map((t) => {
        const start = new Date(t.startDate).toISOString().split("T")[0];
        const end = new Date(t.endDate).toISOString().split("T")[0];
        const isOverdue = new Date(t.endDate) < new Date() && t.status !== "Completed";
        return `- ${t.name} | Status: ${t.status} | Progress: ${t.progress}% | ${start} to ${end}${isOverdue ? " [OVERDUE]" : ""} | Est hours: ${t.estimatedHours ?? "N/A"}`;
    }).join("\n");

    const completed = tasks.filter((t) => t.status === "Completed").length;
    const inProgress = tasks.filter((t) => t.status === "In Progress").length;
    const notStarted = tasks.filter((t) => t.status === "Not Started").length;
    const overdue = tasks.filter((t) => new Date(t.endDate) < new Date() && t.status !== "Completed").length;

    const prompt = `You are an AI assistant for a construction management platform. Provide a clear, concise summary for a subcontractor about their tasks on a project.

Subcontractor: ${sub.companyName} (${sub.contactName || "N/A"})
Trade: ${sub.trade || "General"}
Project: ${project.name} (${project.status})
Today: ${today}

Task Stats: ${tasks.length} total | ${completed} completed | ${inProgress} in progress | ${notStarted} not started | ${overdue} overdue

ASSIGNED TASKS:
${taskDetails || "No tasks assigned."}

Write a brief, actionable summary (3-5 short paragraphs) covering:
1. Overall status - how things are going at a high level
2. What's been completed recently
3. What's coming up next and upcoming deadlines
4. Any overdue items that need immediate attention (flag these clearly)
5. Top priorities and recommended focus areas

Keep the tone professional but friendly. Use plain language, not jargon. Be specific about task names and dates.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    return NextResponse.json({ success: true, result: text.trim() });
}
