# Spec: Speed-to-Lead v1 (new-lead intake, fast reply, booking push)

**ID:** PB-leads-001 · **Date:** 2026-09-25 · **Status:** draft v2, lean v1 scope after Codex round 1
**Branch:** `spec/PB-leads-001-speed-to-lead`
**Roles:** Justin (the only approver), Richard (takes booked calls), Paperclip Marketing Lead (read-only)

## Context

A web inquiry today becomes one email to `connect@` and waits. In about 10 weeks there were 12 submissions: 5 spam, 2 likely bots, about 6 real households, and 1 documented reply (`golden-touch\docs\strategy-2026-09\research\leads-sales.md`). Justin wants new business: every real lead gets a quick reply and an easy way to book a call or phone.

v1 is the smallest release that does that safely at 1 to 3 real leads a week.

## Verified code facts (main @ 139885b1)

- **Site form.** `gtr-sales-draft` `src/app/api/contact/route.ts` (branch `master`) only sends a Resend email from `website@` to `connect@`. `smsConsent` and attribution appear only as email text; nothing is stored. The site's `SITE.calendly` link is Richard's 30-minute page. The site shows **(360) 200-1521**; the docs list the office Voice line as **(360) 524-4728**.
- **Existing ProBuild pieces.** `createLead` (`src/lib/actions.ts:397`) matches clients by name, so ingest must not use it. The Gmail client (`src/lib/gmail-client.ts`) is one shared module-level OAuth client. Other reusable parts: `canonicalJson` (`src/lib/mcp-schedule-tools.ts`), `automation-settings.ts` (pause switch that fails closed), `cron-lease.ts` (`acquireCronLease`), `cron-heartbeat.ts`, and `chat-webhook.ts` (incoming webhooks only, no DMs or buttons).
- **Payment reminders** (`src/lib/payment-reminders.ts`) send through Resend `notifications@` and have their own `PAYMENT_REMINDERS_DRY_RUN` switch. The two systems stay separate: no shared tables, flags or imports.

## Goals (v1, each testable)

1. **Web intake that doesn't lose leads.** The site creates a `submissionId`, puts it in the connect@ email, and POSTs a signed payload to `/api/integrations/leads/ingest`. Signing is HMAC-SHA256 over `timestamp.body`, 5-minute skew, constant-time compare, with up to 2 quick retries. Each intake is a `LeadIntakeEvent` with a unique `externalId`: `web:<submissionId>` or `gmail:<mailbox>:<messageId>`. If no webhook intake exists after 10 minutes, the poller ingests the matching connect@ copy as a fallback. The customer's form never fails because of ProBuild. *Accept:* a replay returns the same intake. Webhook plus email copy gives one lead and is never counted as a reply. With ProBuild down, the lead still arrives within 11 minutes.
2. **Conservative triage.** A lead is REAL only when it came from the authenticated web form and every check passes (see Triage). Anything ambiguous is REVIEW, including every voicemail, missed call and other inbox email. JUNK is only for a contact Justin has already marked junk. *Accept:* the fixture suite (Test Plan).
3. **Phone push to Justin in under 5 minutes.** An ntfy push goes out for each REAL or REVIEW web lead and each voicemail or missed call, with the Leads Chat space as fallback. Other REVIEW inbox mail goes only into the 08:00 digest. *Accept:* timed in the end-to-end (E2E) test.
4. **Justin-only exact-text email approval.** Justin approves personal reply drafts (web, voicemail, follow-up) on `/leads/outreach/[id]` with an explicit POST, one tap, for the version shown. *Accept:* the approval tests (Approval lifecycle).
5. **Template A, the instant acknowledgement** (its own flag). A REAL web lead with an email gets A within 2 minutes of receipt, 24/7, once per lead. It includes the booking link and a call option. *Accept:* timed in E2E. A second trigger sends nothing.
6. **One mandatory send function** (Dispatch contract). *Accept:* a static test finds no other lead-outreach Gmail send path, plus the dispatch negative tests.
7. **Suppression by normalized contact endpoint**, with opt-outs processed before any intake exclusion. *Accept:* the suppression tests.
8. **Manual booking plus follow-up reminders to Justin.** "Booked" and "Called" buttons. A push at +1 and +3 business days offers a follow-up draft, which needs approval like any personal reply. An 08:00 Pacific digest lists unanswered and unbooked leads. *Accept:* reminder tests. Booked stops the reminders.
9. **Audit trail.** Append-only `OutreachEvent` for intake, triage, push, draft, edit, approve, dispatch, result, reply, opt-out, booked, called, pause and gate block. *Accept:* the E2E lead shows the whole chain.
10. **"Is new business coming in?"** The leads page shows, per lead, received, first touch, personal reply and booked times, plus a weekly count of new leads by source. A counts-only read tool, `get_lead_funnel_summary`, is added to `READONLY_TOOLS`: no names, no contact details, SELECT only. *Accept:* a Prisma test double that throws on any write.

## Non-Goals (v2, each behind its own flag, not built now)

Automatic B and C nudges, broad inbox qualification (anything beyond REVIEW), Calendly polling, LLM polish or second opinions, a Paperclip per-lead detail feed, percentile reporting, any SMS automation or API number, other mailboxes (rlord@), and old-estimate follow-ups.

## Approach

### Triage (web form; anything ambiguous goes to REVIEW)

REAL needs every one of these:
- An authenticated web intake.
- Honeypot empty and submitted after 3 seconds or more.
- No link in the message and no pitch words (SEO, traffic, ranking, award, funding, "our services").
- A project description of 10 letters or more.
- A service-area city or zip, or none given.
- The phone and message are not reused by a different name.
- The endpoint is not suppressed.
- The email and phone don't point at **different** existing clients.
- Not an existing customer (a client with a Project or Invoice).

If any check fails, the lead is REVIEW with reasons stored. Justin can promote a lead to REAL or mark it junk. **Promotion never sends A.** A is instant-only: it goes at intake or not at all, and it is cancelled if not dispatched within 30 minutes.

### Inbox poll (gtrsupport@, every minute once released)

The poll uses its own OAuth client instance and token (`gmail.readonly` and `gmail.send`). Before any send it checks that `users.getProfile` returns gtrsupport@.

- **Locking and cursor.** `acquireCronLease` stops overlapping workers. `history.list` is paginated fully. The cursor only advances after every message is durably processed, with backoff on 429 and 5xx. If the history id has expired (404), the poller resyncs with `messages.list`, never earlier than the launch cutoff, and dedupes on `externalId`.
- **Order for each new message:**
  1. Drop sent mail, our own addresses, bounces and auto-replies (`Auto-Submitted`, `multipart/report`, `Precedence: bulk/auto_reply`).
  2. Check for replies and opt-outs **before any exclusion.** A sender endpoint or thread we have messaged counts as a reply: automation stops and Justin gets a push. Opt-out words (stop, unsubscribe, remove me, no thanks, not interested), found in the new text only with quoted parts stripped, add a suppression immediately.
  3. Trusted sources are matched on the DKIM `d=` domain in `Authentication-Results`, not the visible From. `website@` mail is the fallback for Goal 1. `voice-noreply@google.com` mail becomes a VOICE intake (REVIEW, pushed).
  4. Existing clients, GTR users, vendors and bulk mail (`List-Id`/`List-Unsubscribe`) are skipped. Anything else becomes an INBOX intake (REVIEW, digest only).

### Dispatch contract (every customer email goes through `dispatchOutreach(messageId)`)

1. **Atomic claim.** A conditional update moves the message from `APPROVED` to `DISPATCHING` with a claim token, and only when the generation is the current one. Exactly one worker wins, whether inline after approval or the cron backstop.
2. **Recheck every gate right before provider submission:**
   - the mode and the DB pause;
   - the per-kind flag;
   - suppression of the recipient endpoint;
   - the lead is not closed, archived or junk;
   - the approved version is still current;
   - the template version is still approved (for A);
   - TEST rules;
   - the first-live-send rule;
   - the approval is at most 30 minutes old.

   Any failure moves the message to `BLOCKED` and logs the reason.
3. **Atomic cap reservation.** A conditional increment of a per-day counter: at most 10 automated A sends a day, and A is once per lead through a unique `dedupeKey`.
4. **Send only the frozen payload.** That is the immutable approved version's To, Subject and Body, with From fixed to gtrsupport@. There is **no CC, BCC or Reply-To.** The Message-ID is deterministic: `<pb-outreach-{id}-{gen}@goldentouchremodeling.com>`.
5. **Outcome.**
   - Accepted: `SENT`, with the Gmail id and thread stored.
   - A definite 4xx rejection: `FAILED`. It is never retried automatically; Justin can re-approve.
   - A timeout, 5xx, crash, or `DISPATCHING` older than 2 minutes: **`UNKNOWN_DELIVERY`**. Reconciliation searches Sent for `rfc822msgid:` at 1, 5 and 30 minutes and marks the message `SENT` if found. Otherwise it pushes Justin "delivery unknown, check Sent" and stays `UNKNOWN_DELIVERY`. **It is never resent blindly.**
6. **Kill switch, honest version.** Setting the DB pause, or `SPEED_TO_LEAD_MODE` to anything other than LIVE, stops every **new** dispatch that has not passed step 2. It cannot recall a dispatch already past step 2 (a few seconds), an email Gmail has already accepted, or a text already handed to the phone. Changing an env var needs a redeploy, so the one-tap DB pause is the fast stop.

### Approval lifecycle

- **Justin only.** A session user matching `SPEED_TO_LEAD_APPROVER_EMAIL` is required for approve, edit, regenerate, send-again, promote or junk, template approval, suppression clearing and settings. Anyone signed in can press Booked or Called; those only stop things.
- **Explicit POST.** Opening the push link (a GET) only displays. Approve is a POST Server Action (in `src/lib/actions.ts`) with Next's origin check plus a session-bound CSRF token. It carries `versionId` and `contentHash`, and the hash is compared in constant time. There is no link token; Codex round 1 agreed an authenticated action with an immutable version and an atomic claim is equivalent and simpler.
- **Immutable versions.** Each draft, edit or regenerate creates a new immutable `OutreachVersion` and increments `generation`. In the same transaction, any older pending or approved version is set to `SUPERSEDED`, so a queued old version can never dispatch. Approve atomically moves the current generation from `PENDING_APPROVAL` to `APPROVED` and freezes that version, including the booking URL and footer, as the payload.
- **Timing.** Drafts expire after 72 hours. An approval that has not dispatched within 30 minutes (for example because the switch was paused) expires and needs a new tap.

### Template A (standing approval, its own flag)

- **Subject:** "Got your request, {firstName}". `{firstName}` is the cleaned first token of the name, or "there" if it's missing or odd.
- **Body:** "Hi {firstName}, thanks for reaching out to Golden Touch Remodeling. Richard got your request, and I'll send you a personal reply shortly. If you'd like to talk sooner, pick a time here: {bookingLink} or call [PHONE]. If you'd rather not hear from me, just reply "no thanks." Justin"
- **Footer:** Golden Touch Remodeling, 5305 NE 121st Ave Suite 310, Vancouver, WA 98682.
- **What's inserted.** Only `{firstName}` and `{bookingLink}` (Calendly with `name`/`email` prefill). `[PHONE]` is fixed text chosen in Decision 2.
- **Compliance.** A answers the person's own request, but the booking invitation makes its primary purpose arguably commercial, so v1 **treats A as commercial**. That means accurate From and Subject, the reply opt-out line, the postal address, and opt-outs honored immediately. Suppression never expires.
- **Standing approval.** Justin approves one template version in settings, and its content hash is stored. Each send renders an immutable version from that template and dispatches it. Revoking the template blocks any A not yet dispatched.

### SMS (manual only in v1)

Justin approves the exact number and text first, and only then does the page reveal "Copy and open Google Voice" and "Open Messages". This is offered only when:
- the number has **explicit text consent** stored with its disclosure text, version, time and source page;
- it's between 08:00 and 20:00 Pacific, enforced by the server;
- the number has a Pacific area code.

A previous call alone is never consent (RCW 19.190.070); in that case the page offers Call only. "I sent it" is self-reported. The app cannot control what happens in the phone app after the handoff.

### Rollout controls

- **`SPEED_TO_LEAD_MODE` = OFF | TEST | LIVE.** Any other value counts as OFF. LIVE is honored only when `VERCEL_ENV=production`.
- **TEST mode.** Dispatch requires a **server-set** `isTest`, and the final recipient must be in the exact allowlist `SPEED_TO_LEAD_TEST_RECIPIENTS`. `isTest` is set only by the admin "Create test lead" action or by ingest signed with a separate `LEAD_INGEST_TEST_SECRET`, never from form fields. `isTest` leads are allowlist-only in LIVE too.
- **Separate flags.** `SPEED_TO_LEAD_TEMPLATE_A=on` is required for A. B and C get their own flag in v2.
- **First real send.** In LIVE, A stays blocked until `firstLiveSendAt` is set. That happens only when a real, non-test personal reply that Justin approved has dispatched as `SENT`.

## Data Model Changes (additive)

- **`LeadIntakeEvent`:** `externalId @unique`, `source` (WEB | WEB_EMAIL_FALLBACK | VOICE | INBOX), `leadId?`, `receivedAt`, `verdict`, `reasons Json`, `payload Json` (minimal), `isTest`.
- **`ContactEndpoint`:** `endpoint @unique` (lowercased email or E.164), `kind`, plus:
  - SMS consent: `smsConsentAt`, `smsConsentText`, `smsConsentVersion`, `smsConsentSource`;
  - suppression: `suppressedAt`, `suppressReason`, `suppressSource`;
  - junk: `junkAt`.
- **`OutreachMessage`:** `leadId`, `kind` (TEMPLATE_A | PERSONAL | FOLLOWUP), `channel` (EMAIL | SMS_MANUAL), `status`, `generation`, `approvedVersionId`, `approvedBy`/`At`, `claimToken`/`At`, `rfcMessageId @unique`, `providerMessageId`, `gmailThreadId`, `sentAt`, `dedupeKey @unique`, `isTest`. Status values: DRAFT, PENDING_APPROVAL, APPROVED, DISPATCHING, SENT, SENT_MANUAL_REPORTED, UNKNOWN_DELIVERY, FAILED, BLOCKED, SUPERSEDED, EXPIRED, CANCELLED.
- **`OutreachVersion`** (immutable): `messageId`, `generation`, `to`, `subject`, `body`, `contentHash`, `createdBy`.
- **`OutreachTemplate`:** `key`, `version`, `body`, `contentHash`, `approvedAt`/`By`, `revokedAt`.
- **`OutreachEvent`** (append-only).
- **`OutreachDailyCounter`:** `day` as the primary key, and `count`.
- **`Lead`:** `firstTouchAt`, `personalReplyAt`, `bookedAt`.
- **`CompanySettings`:** `leadInboxRefreshToken` (stored like `googleDriveRefreshToken`), `leadInboxEmail`, `leadGmailHistoryId`, `leadGmailCutoffAt`.
- **`AutomationSetting` keys:** `speedToLeadPaused`, `firstLiveSendAt`.
- Migration goes in `prisma/migrations/` plus an inert-on-import `scripts/apply-*.mjs`.

## Files Touched

- **ProBuild:** `prisma/…`, `src/app/api/integrations/leads/ingest/route.ts`, `src/app/api/cron/speed-to-lead/route.ts`, and `src/lib/speed-to-lead/` (`ingest`, `triage`, `inbox-poll`, `dispatch`, `approval`, `suppression`, `notify`, `template-a`). Also `src/lib/actions.ts`, `src/lib/automation-settings.ts`, `src/lib/gmail-client.ts` (a second client), the admin callback purpose, `src/app/leads/outreach/[id]/page.tsx` (Form template, `hui-*`), `src/app/settings/speed-to-lead/page.tsx`, the MCP route (the summary tool), `.env.example` (names only), `tests/speed-to-lead-*.test.ts` and `e2e/speed-to-lead.spec.ts`.
- **gtr-sales-draft:** the contact route and `ContactForm.tsx`: `submissionId`, signing, honeypot, render time, and consent disclosure text and version.
- The `vercel.json` cron entry lands only in release step R2.

## Test Plan

- **Unit:**
  - ingest HMAC, skew and replay; the webhook plus email-fallback dedupe;
  - triage fixtures, with synthetic versions of the 12 historical patterns: none of the spam or bot fixtures become REAL, the Portland one is REVIEW, 4 or more of the 5 genuine ones are REAL, the client email and phone mismatch is REVIEW, and nothing is JUNK without a junk mark;
  - opt-out processed before exclusion, and quoted "stop" text ignored;
  - Justin-only enforcement on every mutating action; a GET never approves; CSRF and origin rejection;
  - edit supersedes a queued version; the constant-time hash check.
- **Dispatch negative tests:**
  - a recipient not on the allowlist, and `isTest` spoofed through the form;
  - mode missing or mistyped; LIVE outside production;
  - pause or opt-out after approval but before dispatch;
  - concurrent workers (exactly one send);
  - the cap race;
  - edit after approval;
  - provider success followed by a DB failure (reaches `UNKNOWN_DELIVERY` and reconciles, no resend);
  - a definite 4xx (`FAILED`, no retry); a direct call of the cron or ingest without secrets.
- **E2E (recorded in `docs/plans/SPEED-TO-LEAD-E2E-LOG.md` with timestamps; required before release):**
  - Isolated run: local ProBuild, throwaway Postgres, mode TEST, allowlist set to Justin's test email and phone, real gtrsupport@ OAuth and ntfy, worker invoked by hand.
  - Steps: a test web lead gets A within 2 minutes; the push arrives within 5 minutes; approve sends the personal email in the same thread; a reply stops automation; a "no thanks" reply suppresses and blocks a queued follow-up; a voicemail from Justin's cell becomes REVIEW with a push; Booked stops the reminders; the pause blocks and logs.
- Codex review of the implementation before merge.

## Release (each step gated; the release gate is the recorded E2E)

- **R0, setup (Justin).** Connect gtrsupport@ as the lead inbox. Install ntfy and send a test push. Confirm connect@ delivers to gtrsupport@. Check the DKIM `d=` for `website@` mail. Answer the Decisions.
- **R1, merge.** Mode unset (OFF). No cron. The site does not post.
- **R2, production TEST.** Add the cron and let the site post. Real leads are ingested and pushed, but they cannot be sent to. Run the E2E again with an admin test lead in production. *Gate:* recorded success plus 3 correctly ingested real leads, or 7 days.
- **R3, LIVE personal replies.** A stays off. Justin approves the first real send.
- **R4, template A on.** Justin approves the template version and sets the flag.

## Rollback

Tap the DB pause, which stops new dispatches within seconds. Then set the mode to OFF and remove the cron and the site call. connect@ email never changed, so intake falls back to today's behavior. The schema is additive.

## Decisions for Justin

1. **Turn on template A at R4?** *Recommend yes.* It is the under-5-minute first touch and it carries the booking link.
2. **Which number goes in A: (360) 200-1521 (the site's) or (360) 524-4728 (the office Voice line)?** *Recommend 200-1521* if it rings a person 8 to 6. Otherwise change the site and A to 524-4728 together.

## Cost

$0 for Gmail, ntfy.sh and templates. The per-minute cron should fit the Vercel Pro plan; check usage after week 1. No LLM, Calendly or SMS spend in v1.

## Codex round 1 response

| Codex point | v1 change |
|---|---|
| Claim time is not send time | One `dispatchOutreach`; every gate rechecked right before submission |
| Duplicate delivery on retry | `UNKNOWN_DELIVERY` plus Sent-folder reconciliation by deterministic Message-ID; never a blind resend |
| Worker and cap races | Atomic claim; conditional-increment cap; unique `dedupeKey` |
| Kill switch overstated | Guarantee restated as stopping new dispatches only; DB pause is the fast stop |
| Manual SMS approval after the fact | Approval of exact number and text before the composer opens; consent plus hours enforced by the server |
| Frozen payload, CC/BCC | Immutable approved version sent verbatim; no CC, BCC or Reply-To |
| Edit, regenerate, old tokens | New generation; older versions superseded in the same transaction |
| Justin-only everywhere | Enforced on every mutating action |
| GET approves / CSRF | POST only, with origin plus CSRF token; constant-time hash compare; link token dropped |
| False JUNK | Ambiguous signals go to REVIEW; JUNK only by Justin's mark |
| False REAL from inbox; client mismatch | Inbox and voice always REVIEW; email and phone pointing at different clients is REVIEW |
| Opt-out before exclusions; quoted "stop" | Reply and opt-out check runs first; quoted text stripped |
| Suppression per endpoint | `ContactEndpoint` suppression across clients and leads |
| Promotion auto-starts A | A is instant-only; promotion never sends it |
| Gmail pagination, cursor, 404 resync, cutoff | Lease, full pagination, cursor after durable processing, resync bounded by launch cutoff |
| One `sourceRef` per lead | `LeadIntakeEvent` with unique external ids |
| Webhook plus email seen as a reply | Shared `submissionId`; the fallback is never a reply |
| Trusting visible From | DKIM `d=` check for trusted sources |
| CAN-SPAM for A | A treated as commercial: opt-out line, address, immediate honor |
| TCPA and WA (RCW 19.190.070) | Explicit stored disclosure consent only; a call is not consent; no SMS automation in v1 |
| Rollout not enforceable | OFF/TEST/LIVE (default OFF, LIVE production-only), server `isTest` plus exact allowlist, separate A flag, first-live-send gate, recorded E2E plus negative tests |
| Overbuilt | B/C, Calendly, LLM, Paperclip detail, percentiles and SMS automation moved to v2 |
