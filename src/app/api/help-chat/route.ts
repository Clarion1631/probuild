import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI service not configured" },
      { status: 503 }
    );
  }

  const { question, currentPage, userId, userRole, conversationId } =
    await req.json();

  if (!question || !userId) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    // Resolve or create conversation
    let convoId = conversationId;
    if (convoId) {
      // Verify the conversation belongs to this user
      const existing = await prisma.chatConversation.findFirst({
        where: { id: convoId, userId },
      });
      if (!existing) convoId = null;
    }

    if (!convoId) {
      const convo = await prisma.chatConversation.create({
        data: {
          userId,
          title: question.slice(0, 80),
        },
      });
      convoId = convo.id;
    }

    // Save user message
    await prisma.chatMessage.create({
      data: {
        conversationId: convoId,
        role: "user",
        content: question,
      },
    });

    // Load conversation history for context (last 20 messages to stay within token limits)
    const priorMessages = await prisma.chatMessage.findMany({
      where: { conversationId: convoId },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { role: true, content: true },
    });

    // Call Claude with full conversation context
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: `You are a ProBuild help assistant. ProBuild is a construction/remodeling management platform with features for projects, estimates, invoices, leads, time tracking, daily logs, schedules, and reports. The user is on page "${currentPage || "unknown"}". Their role is ${userRole || "USER"}. Answer their question about how to use ProBuild concisely. If the question is about a feature that doesn't exist yet, respond with ONLY a valid JSON object: {"type": "feature_request", "title": "short title", "description": "detailed description"} — nothing else, no markdown wrapping.`,
        messages: priorMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Anthropic API error:", err);
      return NextResponse.json(
        { error: "AI service error" },
        { status: 502 }
      );
    }

    const data = await response.json();
    const text =
      data.content?.[0]?.type === "text" ? data.content[0].text : "";

    // Save assistant response
    await prisma.chatMessage.create({
      data: {
        conversationId: convoId,
        role: "assistant",
        content: text,
      },
    });

    // Update conversation timestamp
    await prisma.chatConversation.update({
      where: { id: convoId },
      data: { updatedAt: new Date() },
    });

    // Check if the response is a feature request JSON
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed.type === "feature_request") {
        return NextResponse.json({
          answer: `This looks like a feature request: "${parsed.title}"`,
          type: "feature_request",
          title: parsed.title,
          description: parsed.description,
          conversationId: convoId,
        });
      }
    } catch {
      // Not JSON — it's a normal help response
    }

    return NextResponse.json({
      answer: text,
      type: "help",
      conversationId: convoId,
    });
  } catch (error) {
    console.error("Help chat error:", error);
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
