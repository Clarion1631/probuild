import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";

function buildBugFixDetails(description: string, steps?: string) {
  const details = [description.trim()];

  if (steps?.trim()) {
    details.push(`Steps to reproduce:\n${steps.trim()}`);
  }

  return details.join("\n\n");
}

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
  const { title, description, steps, currentPage, conversationId } =
    await req.json();

  if (!title || !description || !conversationId) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

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

  try {
    const issueDetails = buildBugFixDetails(description, steps);
    const ghIssue = await createHelpChatGitHubIssue({
      title,
      description: issueDetails,
      currentPage: currentPage || null,
      labelPrefix: "Bug Fix",
      labels: ["bug-fix", "agent-task"],
      metadata: [
        steps?.trim() ? `**Steps to Reproduce:**\n${steps.trim()}` : "",
        `**Conversation ID:** \`${conversationId}\``,
      ],
    });

    if (!ghIssue) {
      return NextResponse.json(
        { error: "Failed to create GitHub issue for Phantom" },
        { status: 502 }
      );
    }

    const externalIssueRef = `github-issue:${ghIssue.number}`;

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
        'bug_fix',
        ${title},
        ${issueDetails},
        ${currentPage || null},
        'submitted',
        ${ghIssue.url},
        ${externalIssueRef},
        ${conversationId}
      )
      RETURNING *
    `;

    return NextResponse.json({
      request: result[0],
      issueNumber: ghIssue.number,
      issueUrl: ghIssue.url,
    });
  } catch (error) {
    console.error("Bug fix submission error:", error);
    return NextResponse.json(
      { error: "Failed to submit bug fix" },
      { status: 500 }
    );
  }
}
