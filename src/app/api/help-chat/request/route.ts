import { NextRequest, NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { createHelpChatGitHubIssue } from "@/lib/help-chat/github";
import { authorizeBugWidgetUser } from "@/lib/help-chat/bug-widget-auth";
import {
  checkHelpSubmission,
  claimProviderLease,
  completeUnderLease,
  deriveMobileSubmissionId,
  providerDeadlineSignal,
  renewProviderLease,
  helpChatResponse,
  HELP_THROTTLED_MESSAGE,
  isMobileClient,
  isMobileSubmission,
  readJsonBody,
  reserveHelpRequest,
  submissionMarker,
  SUBMISSION_KEY_CONFLICT,
  SUBMISSION_KEY_CONFLICT_MESSAGE,
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

  try {
    // A mobile caller with no idempotency key cannot be retried safely BY
    // ITSELF: the app retries on network failure, and without a key every retry
    // is a new report and a new GitHub issue. The crew app's bug-report screen
    // does not send one (apps/mobile/lib/bugReport.ts posts
    // title/description/currentPage only) — hard-rejecting the request 400'd
    // every phone report. Derive a key from the CONTENT instead, with the
    // 24-hour window applied as a lookup rather than hashed into the key
    // (submission-guard.ts explains why a time bucket is not an idempotency
    // key). The web widget is a human clicking once, so an explicit key there
    // is passed through unchanged.
    // ONE payload object: the derived key is hashed from it, the reservation
    // is made with it, and reserveHelpRequest fingerprints it. Deriving the key
    // from a SUBSET (title + description) let the same words from a different
    // page hash to the same key and a different fingerprint, which the guard
    // then refused as a reused key — dropping a legitimate report with a 409
    // (round 7, finding 3).
    const payload = {
      type: fromMobile ? "bug" : "feature_request",
      question: title,
      response: description,
      currentPage,
      conversationId,
    };

    const effectiveSubmissionId =
      fromMobileClient && !submissionId
        ? await deriveMobileSubmissionId(userId, payload)
        : submissionId;

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
      ...payload,
      submissionId: effectiveSubmissionId,
    });
    if (!reserved.ok) {
      // The key was reused for DIFFERENT content. That is not a retry, so
      // nothing is filed and nothing is attached — 409, and the caller sends
      // the new report under a new id.
      if (reserved.reason === "payload-conflict") {
        return NextResponse.json(
          { error: SUBMISSION_KEY_CONFLICT_MESSAGE, code: SUBMISSION_KEY_CONFLICT },
          { status: 409 }
        );
      }
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
        submissionId: effectiveSubmissionId,
      });
    }
    const requestId = reserved.id;
    // THE CONTENT THAT GETS FILED — the stored row's, not this request's. On a
    // resume the two are equal by fingerprint (a mismatch was refused above), so
    // reading the incoming body here would only be a way to drift back to it
    // later. The label follows the STORED type for the same reason: what the
    // saved report says it is, not what this caller says.
    const filing = reserved.payload;
    const filedAsBug = filing.type === "bug";

    // Before filing, ask GitHub whether this submission is already there. A
    // resume happens precisely because the previous attempt's outcome is
    // unknown — it may have created the issue and died before recording it.
    // Claim the right to call GitHub. Two attempts can reach this point at
    // once — a double-tap, or a retry overlapping the first request — and both
    // would file, because neither issue exists yet when they both search.
    const leaseToken = await claimProviderLease(requestId);
    if (!leaseToken) {
      const inFlight = await prisma.helpRequest.findUnique({ where: { id: requestId } });
      // Somebody else holds the lease and is filing right now. This attempt
      // does not know the outcome, so it must not report one — 202 unless the
      // holder has already finished.
      return helpChatResponse({
        body: { request: inFlight, duplicate: true, inFlight: true },
        filed: inFlight?.providerState === "created",
        submissionId: effectiveSubmissionId,
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
            submissionId: effectiveSubmissionId,
        });
    }

    const ghIssue =
      alreadyFiled ??
      (await createHelpChatGitHubIssue({
        signal: deadline,
        title: filing.question,
        description: filing.response,
        currentPage: filing.currentPage,
        labelPrefix: filedAsBug ? "Bug Fix" : "Feature Request",
        labels: filedAsBug ? ["bug-fix", "from-mobile"] : ["feature-request", "from-chat"],
        metadata: [
          ...(filing.conversationId ? [`**Conversation ID:** \`${filing.conversationId}\``] : []),
          // The idempotency marker, in the body, so a resumed attempt can find
          // this issue instead of opening a second one.
          marker,
        ],
      }));

    // Attach the issue to the row that already exists — a retry updates it
    // instead of filing a second report. FENCED on the lease: if this attempt's
    // lease expired while GitHub was slow, another claimant has taken over and
    // this write must not land on top of its result.
    const held = ghIssue
      ? await completeUnderLease(requestId, leaseToken, {
          filed: true,
          issueNumber: ghIssue.number,
          issueUrl: ghIssue.url,
          status: "submitted",
        })
      : await completeUnderLease(requestId, leaseToken, { filed: false, status: "submitted_no_issue" });

    const request = await prisma.helpRequest.findUnique({ where: { id: requestId } });
    return helpChatResponse({
      body: {
        request,
        githubIssue: ghIssue ? { number: ghIssue.number, url: ghIssue.url } : null,
        // Somebody else finished this submission while we were filing. The
        // report is real either way; this attempt just is not the one that
        // recorded it.
        ...(held ? {} : { superseded: true }),
      },
      // The STORED state decides, not "we got an issue back": a superseded
      // attempt's own issue number is not what the row points at.
      filed: request?.providerState === "created",
      submissionId: effectiveSubmissionId,
    });
  } catch (error) {
    console.error("Feature request error:", error);
    return NextResponse.json(
      { error: "Failed to save request" },
      { status: 500 }
    );
  }
}
