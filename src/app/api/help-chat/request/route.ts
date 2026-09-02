import { NextRequest, NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";
import { authorizeBugWidgetUser } from "@/lib/help-chat/bug-widget-auth";
import {
  checkHelpSubmission,
  HELP_THROTTLED_MESSAGE,
  isThrottled,
  readJsonBody,
  throttleWindowStart,
} from "@/lib/help-chat/submission-guard";

// Phase 5 G5: any ACTIVATED staff member can file, from the web or from the
// crew app's "Report a bug" screen (Bearer token via authenticateMobileOrSession,
// allowlisted in src/proxy.ts). conversationId stays optional — the app has no
// chat thread behind its report.
export async function POST(req: NextRequest) {
  const auth = await authenticateMobileOrSession(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const allowed = authorizeBugWidgetUser(auth.user);
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: allowed.status });

  const userId = auth.user.id;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    // 400, not a 500 — the crew app retries 5xx, so an unparseable body would
    // become a retry loop.
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }
  const submission = checkHelpSubmission(parsed.body);
  if (!submission.ok) {
    return NextResponse.json({ error: submission.error }, { status: submission.status });
  }

  // Per-user throttle. Every submission opens a GitHub issue, and this endpoint
  // is now reachable by every activated staff account and by the phone.
  const recent = await prisma.helpRequest.count({
    where: { userId, createdAt: { gte: throttleWindowStart() } },
  });
  if (isThrottled(recent)) {
    return NextResponse.json({ error: HELP_THROTTLED_MESSAGE }, { status: 429 });
  }
  const { title, description, currentPage } = submission;
  const conversationId = parsed.body.conversationId;

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
