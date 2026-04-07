import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as any).role;
  if (role !== "ADMIN") {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  const userId = (session.user as any).id;
  const { title, description, currentPage, conversationId } = await req.json();

  if (!title || !description) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    if (conversationId) {
      const conversation = await prisma.chatConversation.findFirst({
        where: { id: conversationId, userId },
        select: { id: true },
      });

      if (!conversation) {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }
    }

    const ghIssue = await createHelpChatGitHubIssue({
      title,
      description,
      currentPage,
      labelPrefix: "Feature Request",
      labels: ["feature-request", "from-chat"],
      metadata: conversationId
        ? [`**Conversation ID:** \`${conversationId}\``]
        : [],
    });
    const externalIssueRef = ghIssue ? `github-issue:${ghIssue.number}` : null;

    const result = await prisma.$queryRaw<any[]>`
      INSERT INTO "HelpRequest" (
        "userId",
        "type",
        "question",
        "response",
        "currentPage",
        "status",
        "changeLocation",
        "externalIssueRef",
        "conversationId"
      )
      VALUES (
        ${userId},
        'feature_request',
        ${title},
        ${description},
        ${currentPage || null},
        'submitted',
        ${ghIssue?.url || null},
        ${externalIssueRef},
        ${conversationId || null}
      )
      RETURNING *
    `;

    return NextResponse.json({
      request: result[0],
      githubIssue: ghIssue
        ? { number: ghIssue.number, url: ghIssue.url }
        : null,
    });
  } catch (error) {
    console.error("Feature request error:", error);
    return NextResponse.json(
      { error: "Failed to save request" },
      { status: 500 }
    );
  }
}
