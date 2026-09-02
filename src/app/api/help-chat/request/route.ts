import { NextRequest, NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";
import { authorizeBugWidgetUser } from "@/lib/help-chat/bug-widget-auth";
import {
  checkHelpSubmission,
  HELP_THROTTLED_MESSAGE,
  readJsonBody,
  reserveHelpRequest,
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

  const { title, description, currentPage, conversationId } = submission;

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

    // Claim a slot and create the row FIRST, in one statement. The report is
    // durable before anything external is called, so a GitHub failure cannot
    // lose it, and the throttle is decided by the database rather than by a
    // read-then-write that five concurrent requests all pass.
    const requestId = await reserveHelpRequest({
      userId,
      type: "feature_request",
      question: title,
      response: description,
      currentPage,
      conversationId,
    });
    if (!requestId) {
      return NextResponse.json({ error: HELP_THROTTLED_MESSAGE }, { status: 429 });
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

    // Attach the issue to the row that already exists — a retry updates it
    // instead of filing a second report.
    const [request] = await prisma.$queryRaw<any[]>`
      UPDATE "HelpRequest"
      SET "status" = ${ghIssue ? "submitted" : "submitted_no_issue"},
          "changeLocation" = ${ghIssue?.url ?? null},
          "externalIssueRef" = ${ghIssue ? `github-issue:${ghIssue.number}` : null}
      WHERE "id" = ${requestId}
      RETURNING *
    `;

    return NextResponse.json({
      request,
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
