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

  const { title, description, steps, currentPage, conversationId, submissionId } = submission;
  if (!conversationId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
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
    const issueDetails = buildBugFixDetails(description, steps ?? undefined);

    // Claim a slot and create the row FIRST, in one statement. The report is
    // durable before anything external is called, so a GitHub failure cannot
    // lose it, and the throttle is decided by the database rather than by a
    // read-then-write that five concurrent requests all pass.
    const reserved = await reserveHelpRequest({
      userId,
      type: "bug_fix",
      question: title,
      response: issueDetails,
      currentPage,
      conversationId,
      submissionId,
    });
    if (!reserved.ok) {
      return NextResponse.json({ error: HELP_THROTTLED_MESSAGE }, { status: 429 });
    }
    if (reserved.existing) {
      const prior = await prisma.helpRequest.findUnique({ where: { id: reserved.id } });
      return NextResponse.json({ request: prior, duplicate: true });
    }
    const requestId = reserved.id;

    const ghIssue = await createHelpChatGitHubIssue({
      title,
      description: issueDetails,
      currentPage: currentPage || null,
      labelPrefix: "Bug Fix",
      labels: ["bug-fix", "agent-task"],
      metadata: [
        steps ? `**Steps to Reproduce:**\n${steps}` : "",
        `**Conversation ID:** \`${conversationId}\``,
      ],
    });

    if (!ghIssue) {
      // The report is already saved; only the Phantom hand-off failed.
      await prisma.$executeRaw`
        UPDATE "HelpRequest" SET "status" = 'submitted_no_issue' WHERE "id" = ${requestId}
      `;
      return NextResponse.json(
        { error: "Failed to create GitHub issue for Phantom" },
        { status: 502 }
      );
    }

    // Attach the issue to the row that already exists — a retry updates it
    // instead of filing a second report.
    const [request] = await prisma.$queryRaw<any[]>`
      UPDATE "HelpRequest"
      SET "status" = 'submitted',
          "changeLocation" = ${ghIssue.url},
          "externalIssueRef" = ${`github-issue:${ghIssue.number}`}
      WHERE "id" = ${requestId}
      RETURNING *
    `;

    return NextResponse.json({
      request,
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
