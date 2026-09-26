# Spec: Speed-to-Lead v1 (instant acknowledgement plus approved personal replies)

**ID:** PB-leads-001 · **Date:** 2026-09-25 · **Status:** draft v3 (Codex round 2 fixes)
**Branch:** `spec/PB-leads-001-speed-to-lead`
**Roles:** Justin (the only approver), Richard (takes booked calls)

## Context

A web inquiry today becomes one email to `connect@` and waits. In about 10 weeks there were 12 submissions: 5 spam, 2 likely bots, about 6 real households, and 1 documented reply (`golden-touch\docs\strategy-2026-09\research\leads-sales.md`). Justin wants new business: every real lead gets a quick reply and an easy way to book or call.

**v1 is:**
- **template A**, an instant acknowledgement carrying Richard's Calendly link and the site's number, +1 (360) 200-1521;
- **personal replies that Justin approves**;
- a phone push to Justin.

The form's thank-you page is getting booking and call buttons in a separate website change, which covers leads who are in review or who arrive while A is off.

## Verified code facts (main @ 139885b1)

- **Site form.** `gtr-sales-draft` `src/app/api/contact/route.ts` (branch `master`) only sends a Resend email from `website@` to `connect@`. `smsConsent` and attribution appear only as email text; nothing is stored. The site's `SITE.calendly` link is Richard's 30-minute page, and `SITE.phone` is +1 (360) 200-1521.
- **Existing ProBuild pieces.** `createLead` (`src/lib/actions.ts:397`) matches clients by name, so it is not used. The Gmail client (`src/lib/gmail-client.ts`) is one shared module-level OAuth client, so v1 adds a separate one. Reusable parts: `canonicalJson` (`mcp-schedule-tools.ts`), `automation-settings.ts` (pause that fails closed), `cron-lease.ts`, `cron-heartbeat.ts`, and `chat-webhook.ts`.
- **Payment reminders** (`payment-reminders.ts`) use Resend `notifications@` and have their own switch. The two systems share no tables, flags or imports.

## Goals (each testable)

1. **Web intake.** The site POSTs a signed payload (HMAC-SHA256 over `timestamp.body`, 5-minute skew, constant-time compare, 2 quick retries). The same `submissionId` goes into the connect@ email as the header `X-GTR-Submission-Id`. Intake is exactly-once per `submissionId` whichever copy arrives first (Intake).
2. **Conservative triage.** REAL requires an authenticated webhook intake that passes every check. Everything else is REVIEW, including fallback-email leads and voicemails. JUNK is only a contact Justin has marked junk.
3. **Push to Justin in under 5 minutes** (ntfy, with the Leads Chat space as fallback) for every web lead and every Voice voicemail or missed call.
4. **Template A in under 3 minutes**, 24/7, once per REAL webhook lead, only while its flag and standing approval are active.
5. **Personal replies by email only,** with Justin-only approval of the exact version (Approval).
6. **One dispatch path with a single commitment point** (Dispatch).
7. **Endpoint suppression and cancellation** that survive every filter (Suppression).
8. **Manual Booked and Called buttons, and reminders to Justin.** At +1 and +3 business days a push offers a follow-up draft, which needs approval. There is also a 09:00 list of unanswered and unbooked leads.
9. **Append-only audit** (`OutreachEvent`) and a per-lead timing row: received, first touch, personal reply, booked. Plus a weekly count of new leads by source, and `get_lead_funnel_summary` (counts only, SELECT only) in `READONLY_TOOLS`.
10. **Enforced release readiness** (Release).

## Non-Goals (v2, own flags)

- Any SMS, manual or automated.
- A general inbox digest or inbox triage.
- B and C nudges.
- Calendly polling.
- LLM help.
- A Paperclip per-lead feed.
- Percentile reporting.
- Other mailboxes.
- Old-estimate follow-ups.

v1 stores the form's SMS-consent fields only as evidence on the intake payload. They grant nothing.

## Approach

### Intake

- **One identity per submission.** `LeadIntakeEvent.submissionId` is unique. The webhook and the email fallback both upsert that row (insert, or do nothing on conflict), and lead creation happens in the same transaction as the winning insert. So one submission becomes one lead, and the loser only links to it.
- **Fallback that survives.** The poller writes a `PENDING_FALLBACK` intake with `dueAt` set to the email time plus 10 minutes, in the same transaction that marks the Gmail message processed and **before** the cursor advances. Each cron run promotes due rows with a conditional update, but only if they are still `PENDING_FALLBACK`. A webhook that arrives first takes the row over. Fallback leads are always REVIEW, never A.
- **Honest promise.** If ProBuild is down, nothing is ingested. After it recovers, a fallback lead appears within about 11 minutes. The launch cutoff bounds resync, so no old mail becomes a lead.
- **Inbox poll** (gtrsupport@, every minute). It holds a lease, paginates `history.list` fully, advances the cursor only after durable processing, resyncs after a 404 no earlier than the cutoff, and backs off. It runs in every mode, including OFF, because it also processes opt-outs. **Order for each message:**
  1. **Authenticate.** Trust only the topmost `Authentication-Results` header whose authserv-id is `mx.google.com`, the receiving boundary of the Workspace mailbox; lower headers are ignored. A trusted source needs `dkim=pass` and `dmarc=pass` for the expected signing domain, plus the expected From address. For mail relayed through connect@, ARC is accepted only when its first Google hop shows the same pass. The expected patterns come from real samples captured at R0 and are stored as config. Anything unmatched is untrusted.
  2. **Trusted handlers first,** before any drop: a `website@` copy becomes a fallback intake; a `voice-noreply@google.com` message becomes a VOICE intake (REVIEW, push, Call button).
  3. **Replies and opt-outs next,** before any exclusion. This covers any message from an endpoint or thread we have emailed, excluding our own sent copies. Auto-replies (`Auto-Submitted`) and bounces are logged, and a bounce marks the address undeliverable; neither counts as a reply or opt-out. For everything else, opt-out words (stop, unsubscribe, remove me, no thanks, not interested) in the new text, with quoted parts stripped, create a suppression. Anything else counts as a reply.
  4. Everything else is ignored in v1.

### Triage (webhook leads)

REAL needs every one of these:
- honeypot empty, and submitted 3 seconds or more after render;
- no links and no pitch words;
- a description of 10 letters or more;
- a service-area city or zip, or none given;
- phone or message text not reused by a different name;
- the endpoint is not suppressed or junk;
- the email and phone don't match **different** clients;
- not an existing customer (a client with a Project or Invoice).

If any check fails, the lead is REVIEW with reasons stored. Promotion to REAL is Justin-only and **never** creates A.

### Suppression and cancellation

- `ContactEndpoint` holds each normalized email once, across all clients and leads. Suppression is permanent unless Justin clears it with a reason.
- **Cancellation.** In one transaction, using the lock order below, any reply, opt-out, bounce, Booked, Called, junk mark or lead close cancels every message for that lead that is still before commitment (`PENDING_APPROVAL` or `APPROVED`, set to `CANCELLED` with a reason). The next personal reply is a new draft generation built with the new context, and it needs a fresh approval.
- **Freshness.** A can commit only after a successful inbox poll that **started after the intake's server receive time** and finished within the last 5 minutes. Any dispatch needs a successful poll within 10 minutes. Otherwise the message is `BLOCKED` ("inbox check stale") and Justin gets a push. A stuck poller therefore fails closed.

### Approval (Justin only, email only)

- **Who.** The session user must equal `SPEED_TO_LEAD_APPROVER_EMAIL` for approve, edit, regenerate, send-again, promote, junk, template approval, clearing suppression, readiness runs, LIVE activation and settings. Anyone signed in can press Booked or Called, since those only cancel.
- **How.** A GET only displays. Approve is a POST Server Action (a thin wrapper in `src/lib/actions.ts`) with an origin check and a session-bound CSRF token. It carries `versionId` and `approvalHash`, compared in constant time.
- **What the hash covers.** `approvalHash = sha256(canonicalJson({environment, companyId, leadId, messageId, generation, channel:"EMAIL", from, to, subject, body, footer, inReplyTo, references, threadId}))`, where `environment` is `VERCEL_ENV` plus the app base URL. It covers the complete payload, the channel and the server context. The footer and the threading headers are part of what Justin sees and approves.
- **Versions.** Every draft, edit or regenerate is a new immutable `OutreachVersion` with a new `generation`. The same transaction sets any older version still before commitment to `SUPERSEDED`. A version already in `DISPATCHING` can't be superseded, and the page shows "already in flight".
- **Timing.** A personal approval must commit within 30 minutes of approval, or it becomes `EXPIRED`. Drafts expire after 72 hours.

### Dispatch (single path: `dispatchOutreach(messageId)`)

**Lifecycle:**
- DRAFT → PENDING_APPROVAL → APPROVED → **DISPATCHING** → SENT, FAILED or UNKNOWN_DELIVERY.
- CANCELLED, SUPERSEDED, EXPIRED and BLOCKED are reachable only from states before DISPATCHING.

1. **Commitment point.** One Postgres transaction takes locks in a fixed order, and every invalidating action uses the same order: pause and mode row, then template row, then `ContactEndpoint` row, then lead row, then message row (`FOR UPDATE`). Inside it the transaction checks:
   - the message is `APPROVED`, or is A in `READY`;
   - the generation is current;
   - it recomputes `approvalHash` from the stored version plus the live server context and compares it;
   - mode, activation, pause, flag, template approval, suppression, junk and lead state, freshness, the A deadline, the TEST allowlist, the first-live-send rule, and the daily cap (a conditional increment);
   - then it inserts an `OutreachAttempt` (unique `rfcMessageId`) and sets `DISPATCHING`.

   Before the commit, any invalidation wins. After it, invalidations are refused with "already in flight".
2. **Submission.** Exactly one HTTP send per attempt, with SDK retries disabled. It sends the stored payload only: To, Subject, Body plus footer, and the threading headers. From is gtrsupport@, the Message-ID is `<pb-{attemptId}@goldentouchremodeling.com>`, and there is **no CC, BCC or Reply-To**.
3. **Outcome.**
   - Accepted: `SENT`.
   - A definite 4xx: `FAILED`.
   - A timeout, 5xx, crash, or `DISPATCHING` older than 2 minutes: `UNKNOWN_DELIVERY`. Reconciliation searches Sent for `rfc822msgid:` at 1, 5 and 30 minutes. If still not found, Justin gets a push and nothing is resent.
   - **Send-again** (from FAILED, or UNKNOWN after 30 minutes plus Justin's "not in Sent" confirmation) creates a new generation that needs fresh exact approval, and becomes a separately tracked attempt.
4. **Kill switch.** Pause or mode OFF blocks every commitment that hasn't happened yet; the lock order means a pause waits at most for a commit transaction already running. In **TEST**, only `isTest` leads to allowlisted recipients can commit. In **active LIVE**, customers can. Nothing already committed, accepted by Gmail, or delivered can be recalled.

### Template A (standing approval)

- **What Justin approves.** `OutreachTemplate` stores `subject`, `body`, `footer`, `fixedPhone` (+1 (360) 200-1521), `bookingBaseUrl` (Richard's Calendly URL, which must be `https://calendly.com/rlord-goldentouchremodeling/`), `fromAddress`, and the substitution rules. There are exactly two tokens:
  - `{firstName}`: the cleaned first word of the name; letters, apostrophe or hyphen, up to 30 characters; otherwise "there";
  - `{bookingLink}`: `bookingBaseUrl` plus URL-encoded `name` and `email` prefill only.

  `contentHash` covers all of these. Justin's POST approval is **durable approval of that version**, and revoking it takes effect at the next commit.
- **Eligibility per message** is separate. An A message is created only at webhook intake, and only if the lead is REAL, the flag is on, and an approved, unrevoked template exists. Its immutable version records the template version and the render inputs. It commits only within **15 minutes of the intake's server receive time**. Switching the flag on never creates A for earlier leads, and older A messages become `EXPIRED`, so no backlog is released.
- **Text:**
  - Subject: "Got your request, {firstName}".
  - Body: "Hi {firstName}, thanks for reaching out to Golden Touch Remodeling. Richard got your request, and I'll send you a personal reply shortly. If you'd like to talk sooner, pick a time here: {bookingLink} or call +1 (360) 200-1521. Justin"

### Commercial email content (all lead emails)

- **Footer.** Every A, personal reply and follow-up carries a system-added footer that Justin cannot edit, and it is included in `approvalHash`: "Golden Touch Remodeling, 5305 NE 121st Ave Suite 310, Vancouver, WA 98682. If you'd rather not hear from me, reply 'no thanks' and I'll stop."
- **Truthfulness.** From and Subject must be accurate; subjects are not deceptive.
- **Advertising identification.** v1 relies on the affirmative-consent exception to the advertisement label, 15 U.S.C. 7704(a)(5)(B), with consent as defined in 7702(1). Every v1 recipient asked GTR to contact them, on their own initiative, through the web form or a first email. v1 never emails anyone else, and messages stay about their inquiry. If counsel disagrees, add an "Advertisement" line to the footer; it's one template field.
- **Opt-outs keep working** for at least 30 days after the last lead email, in every mode and after rollback (below).

## Release (enforced)

- **Mode.** `SPEED_TO_LEAD_MODE` is OFF, TEST or LIVE; any other value means OFF. LIVE only has effect on production, **and** after Justin activates it for the current code fingerprint.
- **Fingerprint.** A prebuild step writes `SPEED_TO_LEAD_FINGERPRINT`, the sha256 of `src/lib/speed-to-lead/**`, the ingest, cron and outreach routes and pages, and the related Prisma models. Server Action wrappers only delegate, which a static test checks.
- **Readiness runner.** A Justin-only POST runs an in-app check on production using `isTest` leads and allowlisted recipients:
  - Positive: signed test intake, REAL triage, A committed, `SENT` and reconciled; a personal reply approved and `SENT`; a push delivered.
  - Negative, each must end `BLOCKED`: a recipient not on the allowlist, a suppressed endpoint, pause on, stale poll, an expired A, and a revoked template.

  It writes an append-only `ReadinessRecord` (fingerprint, deploy SHA, results, time). There is no edit path.
- **Activation.** Justin's POST succeeds only with a PASSED record for the current fingerprint. A changed fingerprint lapses LIVE back to TEST behavior until readiness passes again. Unrelated deploys don't.
- **Test identity.** `isTest` is set only by the admin "Create test lead" action or by the runner's own ingest, signed with `LEAD_INGEST_TEST_SECRET`, never from form fields. In LIVE, `isTest` leads are still allowlist-only.
- **First real send.** A stays blocked until a real, Justin-approved personal reply has reached `SENT`.
- **Steps:**
  - **R0 (Justin):** connect gtrsupport@; install ntfy and send a test push; capture a sample `website@` email and a Voice email for the authentication patterns; confirm connect@ delivers to gtrsupport@.
  - **R1:** merge with mode OFF.
  - **R2:** isolated E2E, logged. Then set mode TEST, add the cron, and let the site post. Real leads are pushed but can't be sent to.
  - **R3:** readiness PASSED, then Justin activates LIVE and approves the first real reply.
  - **R4:** Justin approves the A template and sets `SPEED_TO_LEAD_TEMPLATE_A=on`.

## Data Model Changes (additive)

- **`LeadIntakeEvent`:** `externalId @unique`, `submissionId @unique?`, `source` (WEB | WEB_EMAIL_FALLBACK | VOICE), `state`, `dueAt`, `receivedAt` (server time), `leadId`, `verdict`, `reasons`, `payload`, `isTest`.
- **`ContactEndpoint`:** `endpoint @unique`, `suppressedAt`, `reason`, `source`, `bouncedAt`, `junkAt`, `clearedBy`, `clearedAt`.
- **`OutreachMessage`:** `leadId`, `kind` (TEMPLATE_A | PERSONAL | FOLLOWUP), `status`, `generation`, `approvedVersionId`, `approvalHash`, `approvedBy`, `approvedAt`, `dedupeKey @unique`, `isTest`.
- **`OutreachVersion`** (immutable): `messageId`, `generation`, `to`, `subject`, `body`, `footer`, `threading`, `templateVersionId`, `renderInputs`.
- **`OutreachAttempt`:** `messageId`, `versionId`, `rfcMessageId @unique`, `committedAt`, `outcome`, `providerMessageId`, `threadId`.
- **`OutreachTemplate`:** the fields listed in Template A.
- **`OutreachEvent`** (append-only), **`OutreachDailyCounter`**, **`ReadinessRecord`** (append-only).
- **`Lead`:** `firstTouchAt`, `personalReplyAt`, `bookedAt`, `calledAt`.
- **`CompanySettings`:** the lead-inbox token and email, the history id, the cutoff, and poll health.
- **`AutomationSetting` keys:** `speedToLeadPaused`, `liveActivation`, `firstLiveSendAt`.
- The schema script is inert on import.

## Files Touched

- **ProBuild:** `prisma/…`, `scripts/apply-*.mjs`, `scripts/speed-to-lead-fingerprint.mjs`, `src/lib/speed-to-lead/**`, the ingest route, `src/app/api/cron/speed-to-lead/route.ts`, `src/app/leads/outreach/[id]/`, `src/app/settings/speed-to-lead/`, the thin wrappers in `src/lib/actions.ts`, `automation-settings.ts`, `gmail-client.ts` (a second client), the callback purpose, the MCP summary tool, `.env.example`, and tests.
- **Site:** the contact route (`submissionId`, signing, header, honeypot, render time). The thank-you page buttons are a separate site change.

## Test Plan

- **Unit and integration (throwaway DB):**
  - HMAC, skew and replay;
  - fallback-first, webhook-first and concurrent intake of one `submissionId` (one lead);
  - fallback persisted before the cursor advances;
  - authentication: a spoofed lower `Authentication-Results`, `d=` matching but `dkim=fail`, ARC cases;
  - handler order: a `website@` or Voice message not dropped, an opt-out from a known client not dropped, quoted "stop" ignored, auto-reply and bounce;
  - triage fixtures;
  - Justin-only enforcement on each mutating action; a GET never approves; CSRF and origin; constant-time hash.
- **Dispatch races** (concurrent transactions): commit versus edit, suppression, pause, template revoke, Booked or reply; exactly one outcome and no send after an invalidation wins. Also: two workers claiming the same message; the cap race.
- **Gates:** stale poll blocks; the A deadline; flag turned on with an expired A backlog (nothing sent); a template change after approval blocks old-hash renders; mode missing or mistyped, and LIVE off production or without activation; spoofed `isTest`; a recipient not on the allowlist.
- **Delivery outcomes:** provider success followed by a DB failure (reaches `UNKNOWN_DELIVERY` and reconciles, no resend); a 4xx (`FAILED`, no retry); send-again needs a new approval; SDK retry disabled.
- **Isolated E2E, logged in `docs/plans/SPEED-TO-LEAD-E2E-LOG.md`:** local ProBuild, throwaway Postgres, mode TEST, real gtrsupport@ and ntfy.
  - A arrives in under 3 minutes and the push in under 5.
  - Approve sends the reply in the same thread.
  - A reply cancels a pending follow-up draft; a "no thanks" suppresses.
  - A voicemail pushes; Booked cancels; pause blocks.
- **Codex review** of the implementation before merge.

## Rollback

- Tap pause, which blocks new commits at once. Then set the mode to OFF and remove the site call.
- **Keep the cron** so opt-outs are still processed, for at least 30 days after the last lead email (`lastOutreachSentAt`), then remove it.
- connect@ email never changed. The schema is additive.

## Cost

$0: Gmail API, ntfy.sh and templates. The per-minute cron should fit the Vercel Pro plan. No LLM, Calendly or SMS spend.

## Codex round 2 response (the 7 required items)

| # | Required change | Where fixed |
|---|---|---|
| 1 | One dispatch commitment point | Dispatch 1 to 3: a locked commit transaction with a fixed lock order; invalidation wins before and is refused after ("in flight"); DISPATCHING in the lifecycle; the claim checked inside the commit; `approvalHash` over payload, channel and server context; one submission and no SDK retry; send-again means a new approval and a new attempt |
| 2 | Remove manual SMS | Non-Goals: no SMS of any kind in v1; consent is kept only as evidence |
| 3 | Durable, idempotent fallback | Intake: a unique `submissionId` shared by webhook and email; atomic lead link; `PENDING_FALLBACK` with `dueAt` persisted before the cursor; trusted handlers before drops; the top Google authentication result with `dkim=pass` and `dmarc=pass` plus the expected identity; the honest 11-minute promise |
| 4 | Suppression and cancellation | Poll order puts opt-outs before exclusions; freshness gates (A needs a poll after intake); reply, Booked, Called or opt-out cancels messages before commitment; the next reply needs fresh approval |
| 5 | A's standing approval scope | Template A: subject, body, footer, phone, booking destination and token rules all hashed; durable approval separate from per-message eligibility; 15-minute deadline from the server receive time; no backlog on enabling |
| 6 | Enforced readiness | Release: a fingerprint-bound, append-only `ReadinessRecord` from the in-app runner; LIVE activation requires it; new negative tests; TEST versus kill-switch wording corrected (Dispatch 4) |
| 7 | Commercial content on all drafts | A non-editable footer (address plus opt-out) on every lead email, inside the approved hash; the affirmative-consent exemption documented; opt-outs processed in OFF and for 30 days after rollback |

Codex round 1 points were resolved or superseded by v2 and this revision; see the earlier commit `ceae850f`.
