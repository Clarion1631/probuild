import { NextRequest, NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";
import { authorizeBugWidgetUser } from "@/lib/help-chat/bug-widget-auth";
import {
  checkHelpSubmission,
  claimProviderLease,
  helpChatResponse,
  HELP_THROTTLED_MESSAGE,
  isMobileClient,
  isMobileSubmission,
  MOBILE_SUBMISSION_ID_REQUIRED,
  readJsonBody,
  reserveHelpRequest,
  submissionMarker,
} from "@/lib/help-chat/submission-guard";
import { findIssueByMarker } from "@/lib/help-chat/github";

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

  const { title, description, currentPage, conversationId, submissionId } = submission;

  // /api/help-chat/request is the shared intake, and it labels everything
  // "Feature Request". A crew-app report is a BUG — the app posts here because
  // this is the endpoint its Bearer token can reach, not because someone is
  // asking for a feature. Classify on the marker the app actually sends.
  // How they AUTHENTICATED, not what they posted: a body field cannot
  // establish anything about the client.
  const fromMobileClient = isMobileClient(auth);
  // The label still follows what the app says about itself.
  const fromMobile = fromMobileClient || isMobileSubmission(currentPage);

  // A mobile caller with no idempotency key cannot be retried safely: the app
  // retries on network failure, and without a key every retry is a new report
  // and a new GitHub issue. The web widget is a human clicking once, so it stays
  // optional there.
  if (fromMobileClient && !submissionId) {
    return NextResponse.json(
      {
        error: "This version of the app can't report bugs safely. Please update it.",
        code: MOBILE_SUBMISSION_ID_REQUIRED,
      },
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

    // Claim a slot and create the row FIRST, in one statement. The report is
    // durable before anything external is called, so a GitHub failure cannot
    // lose it, and the throttle is decided by the database rather than by a
    // read-then-write that five concurrent requests all pass.
    const reserved = await reserveHelpRequest({
      userId,
      type: fromMobile ? "bug" : "feature_request",
      question: title,
      response: description,
      currentPage,
      conversationId,
      submissionId,
    });
    if (!reserved.ok) {
      return NextResponse.json({ error: HELP_THROTTLED_MESSAGE }, { status: 429 });
    }
    // A retry carrying the same submissionId. If the previous attempt died
    // before it could create the issue, RESUME it rather than returning early —
    // otherwise that report is stranded in `submitting` forever. Otherwise
    // return what exists, so a double-tap never files twice.
    if (reserved.existing && !reserved.resume) {
      const prior = await prisma.helpRequest.findUnique({ where: { id: reserved.id } });
      // A replay of a report that IS filed is terminal; a replay of one that is
      // still pending is not. Answering 200 for both told the app to drop a
      // draft whose issue had never been created, which is how a report gets
      // lost quietly.
      return helpChatResponse({
        body: { request: prior, githubIssue: null, duplicate: true },
        filed: reserved.providerState === "created",
        submissionId,
      });
    }
    const requestId = reserved.id;

    // Before filing, ask GitHub whether this submission is already there. A
    // resume happens precisely because the previous attempt's outcome is
    // unknown — it may have created the issue and died before recording it.
    // Claim the right to call GitHub. Two attempts can reach this point at
    // once — a double-tap, or a retry overlapping the first request — and both
    // would file, because neither issue exists yet when they both search.
    if (!(await claimProviderLease(requestId))) {
      const inFlight = await prisma.helpRequest.findUnique({ where: { id: requestId } });
      // Somebody else holds the lease and is filing right now. This attempt
      // does not know the outcome, so it must not report one — 202 unless the
      // holder has already finished.
      return helpChatResponse({
        body: { request: inFlight, duplicate: true, inFlight: true },
        filed: inFlight?.providerState === "created",
        submissionId,
      });
    }

    const marker = submissionMarker(requestId);
    const alreadyFiled = reserved.resume ? await findIssueByMarker(marker) : null;

    const ghIssue =
      alreadyFiled ??
      (await createHelpChatGitHubIssue({
        title,
        description,
        currentPage,
        labelPrefix: fromMobile ? "Bug Fix" : "Feature Request",
        labels: fromMobile ? ["bug-fix", "from-mobile"] : ["feature-request", "from-chat"],
        metadata: [
          ...(conversationId ? [`**Conversation ID:** \`${conversationId}\``] : []),
          // The idempotency marker, in the body, so a resumed attempt can find
          // this issue instead of opening a second one.
          marker,
        ],
      }));

    // Attach the issue to the row that already exists — a retry updates it
    // instead of filing a second report.
    const [request] = await prisma.$queryRaw<any[]>`
      UPDATE "HelpRequest"
      SET "status" = ${ghIssue ? "submitted" : "submitted_no_issue"},
          "changeLocation" = ${ghIssue?.url ?? null},
          "externalIssueRef" = ${ghIssue ? `github-issue:${ghIssue.number}` : null},
          "providerIssueRef" = ${ghIssue ? String(ghIssue.number) : null},
          "providerState" = ${ghIssue ? "created" : "pending"}
      WHERE "id" = ${requestId}
      RETURNING *
    `;

    return helpChatResponse({
      body: {
        request,
        githubIssue: ghIssue ? { number: ghIssue.number, url: ghIssue.url } : null,
      },
      filed: !!ghIssue,
      submissionId,
    });
  } catch (error) {
    console.error("Feature request error:", error);
    return NextResponse.json(
      { error: "Failed to save request" },
      { status: 500 }
    );
  }
}
