import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const { id: leadId } = await context.params;

    if (!leadId) {
        return NextResponse.json({ error: "leadId required" }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "AI not configured" }, { status: 500 });
    }

    try {
        // Fetch context
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: {
                client: true,
                estimates: { select: { title: true, totalAmount: true, status: true } },
                meetings: { select: { title: true, scheduledAt: true, status: true } },
                clientMessages: {
                    // Exclude SYSTEM activity banners — they'd show up as
                    // `[SYSTEM] - 📄 Contract "X" sent...` in the AI memo prompt.
                    where: { direction: { in: ["INBOUND", "OUTBOUND"] } },
                    select: { direction: true, body: true, createdAt: true },
                    orderBy: { createdAt: "asc" },
                },
                notes: { select: { content: true, createdAt: true }, orderBy: { createdAt: "asc" } }
            }
        });

        if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

        const messageHistory = lead.clientMessages.map((m: any) =>
            `[${m.direction}] - ${m.body}`
        ).join("\n");

        const meetingsContext = lead.meetings.map((m: any) =>
            `- ${m.title} (${m.status}) at ${new Date(m.scheduledAt).toLocaleString()}`
        ).join("\n");

        const notesContext = lead.notes.map((n: any) =>
            `- Note at ${new Date(n.createdAt).toLocaleDateString()}: ${n.content}`
        ).join("\n");

        const prompt = `You are a professional AI assistant analyzing a CRM Lead. Please summarize the current state of this lead into a clear, concise bulleted internal memo.

LEAD DETAILS:
Name: ${lead.client?.name || "Client"}
Project Type: ${lead.projectType || "Unknown"}
Location: ${lead.location || "Unknown"}

PREVIOUS NOTES:
${notesContext || "None"}

MEETINGS:
${meetingsContext || "None"}

CONVERSATIONS:
${messageHistory || "None"}

Please provide a short, factual summary of exactly what the client wants, where we are in the pipeline, and the logical next action. Do NOT write an email prompt, just internal notes. Format as a pure string.`;

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        });

        const suggestion = (response.content[0] as { type: "text"; text: string }).text?.trim() || "";
        return NextResponse.json({ suggestion });

    } catch (e: any) {
        console.error("[AI Note] Failed:", e?.message || e);
        return NextResponse.json({ error: "AI generation failed" }, { status: 500 });
    }
}
