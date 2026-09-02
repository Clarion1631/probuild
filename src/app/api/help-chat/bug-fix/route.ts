import { NextRequest, NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";
import { authorizeBugWidgetUser } from "@/lib/help-chat/bug-widget-auth";
import {
  checkHelpSubmission,
  claimProviderLease,
  HELP_THROTTLED_MESSAGE,
  isMobileClient,
  MOBILE_SUBMISSION_ID_REQUIRED,
  readJsonBody,
  reserveHelpRequest,
  submissionMarker,
} from "@/lib/help-chat/submission-guard";
import { findIssueByMarker } from "@/lib/help-chat/github";

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

  // Every mobile-JWT submission needs an idempotency key, on BOTH routes: the
  // app retries on network failure, and without one each retry is a new report
  // and a new GitHub issue.
  if (isMobileClient(auth) && !submissionId) {
    return NextResponse.json(
      {
        error: "This version of the app can't report bugs safely. Please update it.",
        code: MOBILE_SUBMISSION_ID_REQUIRED,
      },
      { status: 400 }
    );
  }
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
    // See the request route: a stale `submitting` row is resumed, not returned.
    if (reserved.existing && !reserved.resume) {
      const prior = await prisma.helpRequest.findUnique({ where: { id: reserved.id } });
      return NextResponse.json({ request: prior, duplicate: true });
    }
    const requestId = reserved.id;

    // Same provider-reconciliation protocol as /api/help-chat/request. A resume
    // happens precisely because the previous attempt's outcome is unknown — it
    // may have created the issue and crashed before recording it — so ask
    // GitHub for the marker before filing anything.
    // Claim the right to call GitHub. Two attempts can reach this point at
    // once — a double-tap, or a retry overlapping the first request — and both
    // would file, because neither issue exists yet when they both search.
    if (!(await claimProviderLease(requestId))) {
      const inFlight = await prisma.helpRequest.findUnique({ where: { id: requestId } });
      return NextResponse.json({ request: inFlight, duplicate: true, inFlight: true });
    }

    const marker = submissionMarker(requestId);
    const alreadyFiled = reserved.resume ? await findIssueByMarker(marker) : null;

    const ghIssue =
      alreadyFiled ??
      (await createHelpChatGitHubIssue({
        title,
        description: issueDetails,
        currentPage: currentPage || null,
        labelPrefix: "Bug Fix",
        labels: ["bug-fix", "agent-task"],
        metadata: [
          steps ? `**Steps to Reproduce:**\n${steps}` : "",
          `**Conversation ID:** \`${conversationId}\``,
          // The idempotency marker, in the body, so a resumed attempt can find
          // this issue instead of opening a second one.
          marker,
        ],
      }));

    if (!ghIssue) {
      // The report is already saved; only the Phantom hand-off failed. Leaving
      // providerState 'pending' is what lets a later retry resume it.
      await prisma.$executeRaw`
        UPDATE "HelpRequest"
        SET "status" = 'submitted_no_issue', "providerState" = 'pending'
        WHERE "id" = ${requestId}
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
          "externalIssueRef" = ${`github-issue:${ghIssue.number}`},
          "providerIssueRef" = ${String(ghIssue.number)},
          "providerState" = 'created'
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
