import { NextRequest, NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";
import { authorizeBugWidgetUser } from "@/lib/help-chat/bug-widget-auth";

function buildBugFixDetails(description: string, steps?: string) {
  const details = [description.trim()];

  if (steps?.trim()) {
    details.push(`Steps to reproduce:\n${steps.trim()}`);
  }

  return details.join("\n\n");
}

// Phase 5 G5: any ACTIVATED staff member can report a bug, from the web or
// from the crew app's Bearer token (authenticateMobileOrSession, allowlisted in
// src/proxy.ts). Everything downstream — the GitHub issue and the HelpRequest
// row — is unchanged.
export async function POST(req: NextRequest) {
  const auth = await authenticateMobileOrSession(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const allowed = authorizeBugWidgetUser(auth.user);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  const userId = auth.user.id;
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
