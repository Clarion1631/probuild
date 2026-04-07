import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const { subcontractorId } = await req.json();
    if (!subcontractorId) return NextResponse.json({ error: "subcontractorId required" }, { status: 400 });

    const sub = await prisma.subcontractor.findUnique({
        where: { id: subcontractorId },
        include: {
            taskAssignments: {
                include: {
                    task: {
                        include: {
                            project: { select: { name: true } },
                            timeEntries: { select: { startTime: true, endTime: true, durationHours: true } },
                        },
                    },
                },
            },
            projectAccess: {
                include: {
                    project: { select: { name: true, status: true, type: true } },
                },
            },
        },
    });

    if (!sub) return NextResponse.json({ error: "Subcontractor not found" }, { status: 404 });

    const today = new Date().toISOString().split("T")[0];

    const taskSummary = sub.taskAssignments.map(ta => {
        const t = ta.task;
        const start = new Date(t.startDate);
        const end = new Date(t.endDate);
        const durationDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        const isPastDue = end < new Date() && t.progress < 100;
        const isComplete = t.progress === 100;
        const totalHoursLogged = t.timeEntries.reduce((sum, te) => sum + (te.durationHours || 0), 0);
        const hoursInfo = t.estimatedHours
            ? `${totalHoursLogged.toFixed(1)}/${t.estimatedHours}h logged/est`
            : totalHoursLogged > 0 ? `${totalHoursLogged.toFixed(1)}h logged` : "";

        return `- ${t.name} (${t.project?.name || "No project"}) | ${t.startDate.toISOString().split("T")[0]} to ${t.endDate.toISOString().split("T")[0]} (${durationDays}d) | ${t.progress}% done | ${t.status}${isPastDue ? " OVERDUE" : ""}${isComplete ? " COMPLETE" : ""} ${hoursInfo}`;
    }).join("\n");

    const projectSummary = sub.projectAccess.map(pa =>
        `- ${pa.project.name} (${pa.project.status}, ${pa.project.type || "General"})`
    ).join("\n");

    const prompt = `You are an expert construction project manager evaluating a subcontractor's performance for a residential remodeling company in Vancouver, WA (Golden Touch Remodeling).

SUBCONTRACTOR:
Company: ${sub.companyName}
Contact: ${sub.contactName || `${sub.firstName || ""} ${sub.lastName || ""}`.trim() || "N/A"}
Trade: ${sub.trade || "Not specified"}
Status: ${sub.status}
License: ${sub.licenseNumber || "Not on file"}
COI: ${sub.coiUploaded ? `Uploaded${sub.coiExpiresAt ? `, expires ${new Date(sub.coiExpiresAt).toLocaleDateString()}` : ""}` : "Missing"}
Internal Notes: ${sub.internalNotes || "None"}

Today: ${today}
Total Assigned Tasks: ${sub.taskAssignments.length}
Projects with Access: ${sub.projectAccess.length}

ASSIGNED TASKS:
${taskSummary || "No tasks assigned yet."}

PROJECT ACCESS:
${projectSummary || "No project access granted."}

Based on the available data, score this subcontractor and provide a performance evaluation.

Return your analysis in this exact format:

ON-TIME DELIVERY: [X]%
WORK QUALITY RATING: [X]/5
RESPONSIVENESS: [X]/5
OVERALL SCORE: [X]/100

STRENGTHS:
- [strength 1]
- [strength 2]
- [strength 3]

AREAS FOR IMPROVEMENT:
- [area 1]
- [area 2]

RECOMMENDATION: [1-3 sentences — should you continue using this sub, increase their workload, put them on probation, etc.]

DATA CONFIDENCE: [Low | Medium | High] — [1 sentence explaining what additional data would improve this score]`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const analysis = (response.content[0] as { type: "text"; text: string }).text.trim();

    return NextResponse.json({ success: true, analysis });
}
