import { NextRequest, NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";
import { authorizeBugWidgetUser, bugFixIssueLabels } from "@/lib/help-chat/bug-widget-auth";
import {
  checkHelpSubmission,
  claimProviderLease,
  completeUnderLease,
  providerDeadlineSignal,
  renewProviderLease,
  helpChatResponse,
  HELP_THROTTLED_MESSAGE,
  isMobileClient,
  MOBILE_SUBMISSION_ID_REQUIRED,
  readJsonBody,
  reserveHelpRequest,
  submissionMarker,
  SUBMISSION_KEY_CONFLICT,
  SUBMISSION_KEY_CONFLICT_MESSAGE,
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
      // Same rule as /request: an idempotency key reused for different content
      // is not a retry. Nothing is filed and nothing is attached.
      if (reserved.reason === "payload-conflict") {
        return NextResponse.json(
          { error: SUBMISSION_KEY_CONFLICT_MESSAGE, code: SUBMISSION_KEY_CONFLICT },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: HELP_THROTTLED_MESSAGE }, { status: 429 });
    }
    // See the request route: a stale `submitting` row is resumed, not returned.
    if (reserved.existing && !reserved.resume) {
      const prior = await prisma.helpRequest.findUnique({ where: { id: reserved.id } });
      // Same rule as /request: a replay is only terminal once the issue exists.
      return helpChatResponse({
        body: { request: prior, duplicate: true },
        filed: reserved.providerState === "created",
        submissionId,
      });
    }
    const requestId = reserved.id;
    // THE CONTENT THAT GETS FILED — the stored row's, not this request's. A
    // resume finishes the report that was SAVED; the incoming body only got
    // this far because its fingerprint matched, so reading it here would buy
    // nothing and could drift. `steps` is already folded into the stored
    // `response` by buildBugFixDetails, so the fingerprint covers it too.
    const filing = reserved.payload;

    // Same provider-reconciliation protocol as /api/help-chat/request. A resume
    // happens precisely because the previous attempt's outcome is unknown — it
    // may have created the issue and crashed before recording it — so ask
    // GitHub for the marker before filing anything.
    // Claim the right to call GitHub. Two attempts can reach this point at
    // once — a double-tap, or a retry overlapping the first request — and both
    // would file, because neither issue exists yet when they both search.
    const leaseToken = await claimProviderLease(requestId);
    if (!leaseToken) {
      const inFlight = await prisma.helpRequest.findUnique({ where: { id: requestId } });
      return helpChatResponse({
        body: { request: inFlight, duplicate: true, inFlight: true },
        filed: inFlight?.providerState === "created",
        submissionId,
      });
    }

    const marker = submissionMarker(requestId);
    // ONE absolute deadline for the whole provider interaction, shared by the
    // marker search AND the create. Giving each call its own fresh timeout let
    // the pair run for twice the budget and outlive the lease fencing them.
    const deadline = providerDeadlineSignal();
    const alreadyFiled = reserved.resume ? await findIssueByMarker(marker, deadline) : null;
    // The search may have eaten most of the deadline, and the create still has
    // to land inside the lease. Fenced on the token: a superseded attempt must
    // not be able to extend a lease it no longer holds.
    if (reserved.resume && !alreadyFiled && !(await renewProviderLease(requestId, leaseToken))) {
        const lost = await prisma.helpRequest.findUnique({ where: { id: requestId } });
        return helpChatResponse({
            body: { request: lost, duplicate: true, inFlight: true, superseded: true },
            filed: lost?.providerState === "created",
            submissionId,
        });
    }

    const ghIssue =
      alreadyFiled ??
      (await createHelpChatGitHubIssue({
        signal: deadline,
        title: filing.question,
        description: filing.response,
        currentPage: filing.currentPage,
        labelPrefix: "Bug Fix",
        // Phase 5 G5 opened the widget to every ACTIVATED role, but the
        // agent-task label is what hands the issue to Phantom unattended —
        // only ADMIN/MANAGER can trigger that (bug-widget-auth.ts).
        labels: bugFixIssueLabels(auth.user),
        metadata: [
          steps ? `**Steps to Reproduce:**\n${steps}` : "",
          `**Conversation ID:** \`${filing.conversationId}\``,
          // The idempotency marker, in the body, so a resumed attempt can find
          // this issue instead of opening a second one.
          marker,
        ],
      }));

    if (!ghIssue) {
      // The report is already saved; only the Phantom hand-off failed. Leaving
      // providerState 'pending' is what lets a later retry resume it. Fenced,
      // so a superseded attempt cannot mark a filed report pending again.
      await completeUnderLease(requestId, leaseToken, { filed: false, status: "submitted_no_issue" });
      return NextResponse.json(
        { error: "Failed to create GitHub issue for Phantom" },
        { status: 502 }
      );
    }

    // Attach the issue to the row that already exists — a retry updates it
    // instead of filing a second report. Fenced on the lease.
    const held = await completeUnderLease(requestId, leaseToken, {
      filed: true,
      issueNumber: ghIssue.number,
      issueUrl: ghIssue.url,
      status: "submitted",
    });
    const request = await prisma.helpRequest.findUnique({ where: { id: requestId } });

    return NextResponse.json({
      request,
      issueNumber: ghIssue.number,
      issueUrl: ghIssue.url,
      ...(held ? {} : { superseded: true }),
    });
  } catch (error) {
    console.error("Bug fix submission error:", error);
    return NextResponse.json(
      { error: "Failed to submit bug fix" },
      { status: 500 }
    );
  }
}
