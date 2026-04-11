import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type StructuredHelpResponse =
  | {
      answer: string;
      type: "feature_request";
      title: string;
      description: string;
    }
  | {
      answer: string;
      type: "bug_report";
      title: string;
      description: string;
      steps: string;
    }
  | {
      answer: string;
      type: "help";
    };

function parseStructuredResponse(text: string): StructuredHelpResponse {
  try {
    const parsed = JSON.parse(text.trim());

    if (
      parsed.type === "feature_request" &&
      typeof parsed.title === "string" &&
      typeof parsed.description === "string"
    ) {
      return {
        answer: `This looks like a feature request: "${parsed.title}"`,
        type: "feature_request",
        title: parsed.title,
        description: parsed.description,
      };
    }

    if (
      parsed.type === "bug_report" &&
      typeof parsed.title === "string" &&
      typeof parsed.description === "string"
    ) {
      return {
        answer: `It sounds like you've found a bug: "${parsed.title}". ${parsed.description}`,
        type: "bug_report",
        title: parsed.title,
        description: parsed.description,
        steps: typeof parsed.steps === "string" ? parsed.steps : "",
      };
    }
  } catch {
    // Not structured JSON. Treat it as a normal help response.
  }

  return {
    answer: text,
    type: "help",
  };
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI service not configured" },
      { status: 503 }
    );
  }

  const session = await getServerSession(authOptions);
  const sessionUserId = (session?.user as any)?.id;
  const sessionUserRole = (session?.user as any)?.role;

  const { question, currentPage, userId, userRole, conversationId } =
    await req.json();
  const effectiveUserId = sessionUserId || userId;
  const effectiveUserRole = sessionUserRole || userRole || "USER";

  if (!question || !effectiveUserId) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    let convoId = conversationId;
    if (convoId) {
      const existing = await prisma.chatConversation.findFirst({
        where: { id: convoId, userId: effectiveUserId },
      });
      if (!existing) convoId = null;
    }

    if (!convoId) {
      const convo = await prisma.chatConversation.create({
        data: {
          userId: effectiveUserId,
          title: question.slice(0, 80),
        },
      });
      convoId = convo.id;
    }

    await prisma.chatMessage.create({
      data: {
        conversationId: convoId,
        role: "user",
        content: question,
      },
    });

    const priorMessages = await prisma.chatMessage.findMany({
      where: { conversationId: convoId },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { role: true, content: true },
    });

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
        system: `You are a ProBuild help assistant. ProBuild is a construction/remodeling management platform with features for projects, estimates, invoices, leads, time tracking, daily logs, schedules, and reports. The user is on page "${currentPage || "unknown"}". Their role is ${effectiveUserRole}. Answer their question about how to use ProBuild concisely. If the question is about a feature that does not exist yet, respond with ONLY a valid JSON object: {"type":"feature_request","title":"short title","description":"detailed description"} If the user is describing a product bug or broken behavior, respond with ONLY a valid JSON object: {"type":"bug_report","title":"short title","description":"what is broken","steps":"how to reproduce"}. Return only JSON for those two cases, with no markdown wrapping.`,
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
    const structuredResponse = parseStructuredResponse(text);

    await prisma.chatMessage.create({
      data: {
        conversationId: convoId,
        role: "assistant",
        content: structuredResponse.answer,
      },
    });

    await prisma.chatConversation.update({
      where: { id: convoId },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json({
      ...structuredResponse,
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
