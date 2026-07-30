import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserWithPermissions } from "@/lib/permissions";
import { runHelpAgent } from "@/lib/help-agent";

export const maxDuration = 300;

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

  const user = await getCurrentUserWithPermissions();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { question, currentPage, conversationId } = await req.json();

  if (!question) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    let convoId = conversationId;
    if (convoId) {
      const existing = await prisma.chatConversation.findFirst({
        where: { id: convoId, userId: user.id },
      });
      if (!existing) convoId = null;
    }

    if (!convoId) {
      const convo = await prisma.chatConversation.create({
        data: {
          userId: user.id,
          title: question.slice(0, 80),
        },
      });
      convoId = convo.id;
    }

    // Load prior messages BEFORE persisting the current question, so it
    // doesn't end up duplicated (once in priorMessages, once appended below).
    const priorMessages = await prisma.chatMessage.findMany({
      where: { conversationId: convoId },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { role: true, content: true },
    });

    await prisma.chatMessage.create({
      data: {
        conversationId: convoId,
        role: "user",
        content: question,
      },
    });

    const { text, activity } = await runHelpAgent({
      user,
      question,
      priorMessages: priorMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      currentPage,
    });

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
      activity,
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
