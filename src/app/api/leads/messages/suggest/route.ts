import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

// POST /api/leads/messages/suggest — AI-generated message suggestion
export async function POST(request: Request) {
    const body = await request.json();
    const { leadId, context } = body; // context: "initial", "followup", "estimate", "schedule_update"

    if (!leadId) {
        return NextResponse.json({ error: "leadId required" }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "AI not configured" }, { status: 500 });
    }

    // Fetch all relevant lead context
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: {
            client: true,
            estimates: {
                select: { id: true, code: true, title: true, status: true, totalAmount: true, createdAt: true },
                orderBy: { createdAt: "desc" },
            },
            leadMessages: {
                orderBy: { createdAt: "asc" },
                take: 20,
            },
            meetings: {
                where: { status: "Scheduled" },
                orderBy: { scheduledAt: "asc" },
                take: 5,
            },
        },
    });

    if (!lead) {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    // Schedule + daily log context populated from the linked project below
    let scheduleContext = "";
    const dailyLogContext = "";

    // Also check if this lead was converted and has a linked project
    const linkedProject = await prisma.project.findUnique({
        where: { leadId },
        select: {
            id: true,
            name: true,
            scheduleTasks: {
                where: {
                    startDate: { lte: new Date(Date.now() + 14 * 86400000) }, // Next 2 weeks
                    endDate: { gte: new Date() },
                },
                select: { name: true, startDate: true, endDate: true, status: true, progress: true, assignee: true },
                orderBy: { startDate: "asc" },
                take: 10,
            },
        },
    });

    if (linkedProject?.scheduleTasks?.length) {
        scheduleContext = `\n\nUPCOMING SCHEDULE (next 2 weeks):\n${linkedProject.scheduleTasks.map(t =>
            `- ${t.name}: ${t.startDate.toLocaleDateString()} to ${t.endDate.toLocaleDateString()} (${t.status}, ${t.progress}% done${t.assignee ? `, assigned to ${t.assignee}` : ""})`
        ).join("\n")}`;
    }

    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Our company";

    // Build conversation history for AI context
    const messageHistory = lead.leadMessages.map((m: any) =>
        `[${m.direction === "OUTBOUND" ? "TEAM" : "CLIENT"} - ${m.createdAt.toLocaleDateString()}]: ${m.body}`
    ).join("\n");

    const estimatesSummary = lead.estimates.map((e: any) =>
        `- ${e.title} (${e.code}): $${Number(e.totalAmount || 0).toLocaleString()} — Status: ${e.status}`
    ).join("\n");

    const meetingsSummary = lead.meetings.map((m: any) =>
        `- ${m.title}: ${m.scheduledAt.toLocaleDateString()} at ${m.scheduledAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    ).join("\n");

    let contextPrompt = "";
    switch (context) {
        case "initial":
            contextPrompt = "Write an initial professional outreach message to this lead. Keep it warm, concise, and action-oriented. Mention what you can help with based on their inquiry.";
            break;
        case "estimate":
            contextPrompt = "Write a message to accompany an estimate being sent. Reference the estimate details. Keep it professional and encourage the client to review and reach out with questions.";
            break;
        case "followup":
            contextPrompt = "Write a professional follow-up message. Reference the conversation history and any pending items. Be polite but encourage a response.";
            break;
        case "schedule_update":
            contextPrompt = "Write a project update message. Include relevant schedule information for this/next week. Keep the client informed about progress and upcoming work.";
            break;
        default:
            contextPrompt = "Write a professional and concise reply based on the conversation context. Be helpful and action-oriented.";
    }

    const systemPrompt = `You are a professional message assistant for ${companyName}, a construction/remodeling company.
Write messages on behalf of the team to send to clients. Keep messages:
- Professional but warm and personable
- Concise (2-4 sentences max, unless schedule update)
- Action-oriented with clear next steps
- Natural sounding (not robotic)

Do NOT include a subject line. Just write the message body.
Do NOT include greetings like "Dear" - use the client's first name casually.
Do NOT include signatures — those are added automatically.`;

    const userPrompt = `CLIENT INFO:
Name: ${lead.client.name}
Email: ${lead.client.email || "Not provided"}
Phone: ${lead.client.primaryPhone || "Not provided"}
Project Location: ${lead.location || "Not specified"}
Project Type: ${lead.projectType || "Not specified"}
Lead Source: ${lead.source || "Unknown"}
Initial Inquiry: ${lead.message || "No initial message"}

${estimatesSummary ? `ESTIMATES:\n${estimatesSummary}` : "No estimates yet."}

${meetingsSummary ? `UPCOMING MEETINGS:\n${meetingsSummary}` : ""}

${messageHistory ? `CONVERSATION HISTORY:\n${messageHistory}` : "No previous messages."}
${scheduleContext}
${dailyLogContext}

TASK: ${contextPrompt}`;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 512,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
        });

        const suggestion = (response.content[0] as { type: "text"; text: string }).text?.trim() || "";

        return NextResponse.json({ suggestion });
    } catch (e: any) {
        console.error("[AI Suggest] Failed:", e?.message || e);
        return NextResponse.json({ error: `AI generation failed: ${e?.message || "Unknown error"}` }, { status: 500 });
    }
}
