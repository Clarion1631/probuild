import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

// POST /api/client-messages/suggest — AI-generated message suggestion
// Accepts leadId or projectId
export async function POST(request: Request) {
    const body = await request.json();
    const { leadId, projectId, context } = body; // context: "initial", "followup", "estimate", "schedule_update"

    if (!leadId && !projectId) {
        return NextResponse.json({ error: "leadId or projectId required" }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "AI not configured" }, { status: 500 });
    }

    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Our company";

    let clientName = "Client";
    let clientEmail: string | null = null;
    let clientPhone: string | null = null;
    let location: string | null = null;
    let projectType: string | null = null;
    let source: string | null = null;
    let initialMessage: string | null = null;
    let estimates: { title: string; code: string; totalAmount: unknown; status: string }[] = [];
    let meetings: { title: string; scheduledAt: Date }[] = [];
    let messageHistory = "";
    let scheduleContext = "";

    if (leadId) {
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: {
                client: true,
                estimates: {
                    select: { id: true, code: true, title: true, status: true, totalAmount: true, createdAt: true },
                    orderBy: { createdAt: "desc" },
                },
                clientMessages: {
                    // Exclude SYSTEM activity banners (contract sent/signed etc.) —
                    // they'd otherwise show up in AI prompts as fake client utterances.
                    where: { direction: { in: ["INBOUND", "OUTBOUND"] } },
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

        if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

        clientName = lead.client?.name || "Client";
        clientEmail = lead.client?.email ?? null;
        clientPhone = lead.client?.primaryPhone ?? null;
        location = lead.location;
        projectType = lead.projectType;
        source = lead.source;
        initialMessage = lead.message;
        estimates = lead.estimates;
        meetings = lead.meetings;
        messageHistory = lead.clientMessages.map((m: any) =>
            `[${m.direction === "OUTBOUND" ? "TEAM" : "CLIENT"} - ${new Date(m.createdAt).toLocaleDateString()}]: ${m.body}`
        ).join("\n");

        // Also check linked project for schedule
        const linkedProject = await prisma.project.findUnique({
            where: { leadId },
            select: {
                scheduleTasks: {
                    where: { startDate: { lte: new Date(Date.now() + 14 * 86400000) }, endDate: { gte: new Date() } },
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
    } else {
        const project = await prisma.project.findUnique({
            where: { id: projectId! },
            include: {
                client: true,
                estimates: {
                    select: { id: true, code: true, title: true, status: true, totalAmount: true, createdAt: true },
                    orderBy: { createdAt: "desc" },
                },
                clientMessages: {
                    // Exclude SYSTEM activity banners — see leadId branch above.
                    where: { direction: { in: ["INBOUND", "OUTBOUND"] } },
                    orderBy: { createdAt: "asc" },
                    take: 20,
                },
                scheduleTasks: {
                    where: { startDate: { lte: new Date(Date.now() + 14 * 86400000) }, endDate: { gte: new Date() } },
                    select: { name: true, startDate: true, endDate: true, status: true, progress: true, assignee: true },
                    orderBy: { startDate: "asc" },
                    take: 10,
                },
            },
        });

        if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

        clientName = project.client?.name || "Client";
        clientEmail = project.client?.email ?? null;
        clientPhone = project.client?.primaryPhone ?? null;
        location = project.location;
        projectType = project.type;
        estimates = project.estimates;
        messageHistory = project.clientMessages.map((m: any) =>
            `[${m.direction === "OUTBOUND" ? "TEAM" : "CLIENT"} - ${new Date(m.createdAt).toLocaleDateString()}]: ${m.body}`
        ).join("\n");
        if (project.scheduleTasks?.length) {
            scheduleContext = `\n\nUPCOMING SCHEDULE (next 2 weeks):\n${project.scheduleTasks.map(t =>
                `- ${t.name}: ${t.startDate.toLocaleDateString()} to ${t.endDate.toLocaleDateString()} (${t.status}, ${t.progress}% done${t.assignee ? `, assigned to ${t.assignee}` : ""})`
            ).join("\n")}`;
        }
    }

    const estimatesSummary = estimates.map((e: any) =>
        `- ${e.title} (${e.code}): $${Number(e.totalAmount || 0).toLocaleString()} — Status: ${e.status}`
    ).join("\n");

    const meetingsSummary = meetings.map((m: any) =>
        `- ${m.title}: ${new Date(m.scheduledAt).toLocaleDateString()} at ${new Date(m.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
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
Name: ${clientName}
Email: ${clientEmail || "Not provided"}
Phone: ${clientPhone || "Not provided"}
Project Location: ${location || "Not specified"}
Project Type: ${projectType || "Not specified"}
${source ? `Lead Source: ${source}` : ""}
${initialMessage ? `Initial Inquiry: ${initialMessage}` : ""}

${estimatesSummary ? `ESTIMATES:\n${estimatesSummary}` : "No estimates yet."}

${meetingsSummary ? `UPCOMING MEETINGS:\n${meetingsSummary}` : ""}

${messageHistory ? `CONVERSATION HISTORY:\n${messageHistory}` : "No previous messages."}
${scheduleContext}

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
