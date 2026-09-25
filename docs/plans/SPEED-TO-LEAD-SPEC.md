# Spec: Speed-to-Lead (new-lead response and booking funnel)

**ID:** PB-leads-001
**Date:** 2026-09-25
**Status:** draft
**Branch:** `spec/PB-leads-001-speed-to-lead`
**Owner roles:** Justin (owner, approves every message), Richard (takes the booked consults), Paperclip Marketing Lead agent (read-only, reports the funnel)

## Context

New business is the goal. Today a web inquiry becomes an email to `connect@` and waits for someone to notice it. The 2026-09-22 lead research (`golden-touch\docs\strategy-2026-09\research\leads-sales.md`) found 12 form submissions in about 10 weeks: 5 spam or vendor pitches, 2 likely bots (the "Mady Rose" and "Ethan Anderson" entries share the same text and phone), and about 6 real households. Only 1 of those 6 has a documented reply. Justin says 9 of 9 recent web inquiries are still waiting. ProBuild never sees them: no lead is created, nothing measures response time, and nothing follows up.

The target, Hormozi style: **every real new lead gets a first touch in under 5 minutes, 24/7**, a personal reply that Justin approves from his phone, and a short automated push toward a booked call with Richard.

## Invariants (apply to every Goal)

1. **Nothing reaches a customer unless Justin approved that exact recipient and text.** The one exception is a small set of fixed templates Justin approves once (standing approval). Only `{firstName}`, `{name}` (inside the booking link) and `{bookingLink}` are inserted.
2. Any edit to a draft, or to a template, needs a fresh approval.
3. A kill switch stops every customer send immediately. It fails closed.
4. Junk is logged and never contacted. Uncertain leads wait for a human.
5. Nothing is scheduled or enabled in production until the end-to-end test with test leads passes (see Rollout).

## Verified code facts (main @ 139885b1, 2026-09-25)

- **Site form** (`gtr-sales-draft`, branch `master`, `src/app/api/contact/route.ts`) sends one Resend email, `website@` → `connect@`. It never calls ProBuild. `smsConsent` and UTM/click-id attribution appear only as text in that email; no consent timestamp or wording is stored anywhere.
- **Booking:** `SITE.calendly` = `calendly.com/rlord-goldentouchremodeling/30min` (`src/lib/constants.ts`). ProBuild has no booking code; `LeadMeeting` (schema.prisma:309) can hold one.
- **Phone conflict:** the site publishes **(360) 200-1521**; the access guide's office Voice line (gtrsupport@) is **(360) 524-4728**. 200-1521 is not one of the four documented Voice lines (Decision 2).
- **Lead** (schema.prisma:194) has `stage`, `source`, `message`, `isArchived`, but no consent, do-not-contact or timing fields. `CLOSED_LEAD_STAGES = ["Won","Closed Lost"]`.
- **`createLead`** (`src/lib/actions.ts:397`) is session-gated and matches clients **by name**. The public ingest must not use it.
- **Gmail:** `src/lib/gmail-client.ts` is ONE module-level OAuth client (`gmail.modify`, `gmail.send`, `drive`), token in `CompanySettings.googleDriveRefreshToken` via the admin-only `/api/gmail/callback`. The connected mailbox (`googleDriveEmail`) was not checked.
- **Twilio exists:** `sendSMS()` (`src/lib/sms.ts`) and a signature-validated `/api/twilio/inbound` (Twilio handles STOP). The number's A2P 10DLC status is unverified (`WORKFLOW_AUDIT.md` §4).
- **Tokens:** `mintPreviewToken` (`mcp/[transport]/route.ts:85`) is stateless and **replayable** for about 10 min (its own comment). `issueConfirmation`/`executeConfirmed` (`src/lib/mcp-schedule-tools.ts:95`) are single-use (`McpConfirmation`, `canonicalJson` hash, conditional claim) with a fixed 10-minute TTL and MCP actor labels.
- **Pause pattern:** `src/lib/automation-settings.ts` is env master AND NOT DB pause, and fails closed.
- **Chat:** `postOwnerCard` and `chat-webhook.ts` post text through **incoming webhooks**, which cannot DM or take button callbacks. `@mention` ids exist (`RECEIPT_OWNER_CHAT_USERS`).
- **Payment reminders:** `/api/cron/payment-reminders` → `src/lib/payment-reminders.ts`, sent via Resend `notifications@`, kill switch `PAYMENT_REMINDERS_DRY_RUN`.
- **Read-only MCP:** `READONLY_TOOLS` (route.ts:222). `list_leads` returns no timestamps, source or funnel data.
- **Env names:** `ANTHROPIC_API_KEY` is present and already used (`/api/leads/messages/suggest`). Per-minute crons are already in use. `/api/integrations/*` bypasses the session proxy. `/leads/*` needs a session, and login returns to the tapped link (#553).

## Goals (each independently testable)

1. **Web ingest.** The site's `/api/contact` also POSTs a signed payload to ProBuild. ProBuild creates or links Client, Lead and `LeadOutreach` rows, idempotently by `submissionId`. It matches an existing client only by normalized email or E.164 phone. It stores SMS consent (boolean, timestamp, consent-text version), attribution and bot signals. *Accept:* the same submission posted twice gives one lead. A bad signature returns 401. With ProBuild down, the customer still sees success and the connect@ email still sends.
2. **Inbox intake (gtrsupport@).** A 1-minute poll picks up: Google Voice voicemail and missed-call emails from `voice-noreply@google.com` (caller phone and transcript), first emails from unknown senders, and site emails from `website@` only if the webhook lead is missing after 10 minutes (fallback). It ignores GTR, known client, vendor, and bulk (`List-Unsubscribe`/`Precedence: bulk`) senders. *Accept:* fixture emails of each shape map to the right source or are ignored. A real voicemail on the office line becomes a lead within 2 minutes.
3. **Qualification before any message.** Every intake gets a deterministic verdict, REAL, REVIEW or JUNK, with stored reasons (rules below). Only REAL gets automated messages. REVIEW goes to a queue. JUNK is logged and never contacted. *Accept:* the fixture suite passes (Test Plan).
4. **Instant acknowledgement** (standing template, flag-gated). A REAL lead with an email address gets template A within 90 s of receipt (p90), 24/7, at most once per lead. *Accept:* timing assertion in the E2E test. A second trigger for the same lead sends nothing (unique dedupe key).
5. **Personal reply draft plus phone push in under 5 minutes.** For every REAL lead, and for REVIEW leads (tagged "check first"), a personal draft is created and a push lands on Justin's phone within 5 min of receipt (p90), 24/7. *Accept:* E2E timing for a web lead and for a voicemail.
6. **One-tap approval page.** A single tap sends exactly the recipient, subject and body shown. Editing saves a new version and needs a new tap. Tokens are single-use, content-bound, expire, and work only for an allowlisted signed-in user. The SMS path ends with "I sent it". *Accept:* security tests (Security section) plus the E2E test.
7. **Booking funnel.** Templates B (+1 business day) and C (+3 business days) go out only if the lead has not booked, replied, called, or opted out. That makes at most 3 automated touches per lead, ever. A personal follow-up draft (approval needed) is prepared at +7 business days. *Accept:* scheduler tests over each stop condition, and a quiet-hours test.
8. **Booking tracked as the conversion.** The booking link carries Calendly prefill and an opaque lead reference. A booking is detected by Calendly API poll (or a manual "Booked" tap), sets `bookedAt`, and stops the funnel. *Accept:* a test booking on the test lead sets `bookedAt` and cancels pending nudges.
9. **Suppression enforced at send time** (rules below). *Accept:* a table-driven test, one case per rule.
10. **Kill switch and test mode.** *Accept:* with the env master off, or the DB pause on, or a failed settings read, no send happens and the attempt is logged. In test mode, only allowlisted recipients can receive anything.
11. **Audit log.** Every ingest, verdict, draft, push, approval, edit, send, failure, suppression, stop and kill-switch block is an append-only event with actor and time. *Accept:* the E2E lead shows the full event chain. No code path updates or deletes events.
12. **Metrics, and a read-only funnel tool for Paperclip.** Per-lead timings, a weekly count of new leads by source, and funnel counts are exposed by a new `get_lead_funnel` tool in `READONLY_TOOLS`. The tool is truly side-effect-free. *Accept:* a unit test runs the tool against a Prisma double that throws on any write method, and `tests/mcp-readonly-key.test.ts` is extended to show the tool is available to the read-only key.
13. **Separation from payment reminders.** The two systems have separate tables, cron, flags, sender and heartbeat, and neither imports the other. *Accept:* a static test asserts no cross-imports, and a reminder run leaves `LeadOutreach*` untouched.

## Non-Goals

- Follow-ups on old estimates or old leads. Only NEW leads from now on (a later phase).
- Leads that go straight to `rlord@` or to CJ's or Justin's Voice lines. Phase 1 watches only gtrsupport@.
- Automatic SMS from an API number, and missed-call text-back (Phase 4, needs Decision 3).
- Houzz, Angi, Facebook and other lead sources.
- Any write access for the Paperclip agents. Templates change only through Justin's approval screen.
- LLM-written messages as the default path.

## Approach

### Sources and flows

- **Web form.** The site creates a `submissionId`, sends the connect@ email as today, then POSTs to `/api/integrations/leads/ingest`. It has a 3 s timeout and never fails the customer. The request is signed with HMAC-SHA256 over `timestamp.body` (`LEAD_INGEST_SECRET`, 5-minute skew), and carries the honeypot and render-to-submit time as bot signals, plus the consent-label version. ProBuild then: ingest (commit) → qualify → if REAL, queue template A and the personal draft → push. The send is tried inline after commit (Next `after()`), with the cron as backstop, as in payment-outbox.
- **Voicemail or missed call** (office line → gtrsupport@). The poll parses the caller number and transcript, and matches the Client by E.164 (or creates a phone-only lead). A missed call with no transcript and an unknown number is REVIEW. With no email and no consent there is **no template**: Justin gets a personal text draft plus a call-back link. First touch is his approved text or a logged call.
- **First email to gtrsupport@.** It is qualified (unknown senders lean REVIEW). If REAL, template A goes as a reply in the same thread, plus a personal draft.
- **Duplicates.** The same email or E.164 within 90 days attaches to the existing lead, with no new sequence. During an active sequence it counts as a reply: nudges stop and the push says "they wrote again".

### Qualification rules (deterministic, reasons stored)

| Signal | Verdict |
|---|---|
| Honeypot filled, or submitted under 3 s after render | JUNK |
| Same phone or same message hash as another lead with a different name in 90 days (Mady Rose / Ethan Anderson pattern), or phone/email previously marked junk | JUNK (the earlier match flips to REVIEW) |
| Link in message plus a pitch keyword (SEO, traffic, ranking, backlinks, award, guest post, funding, web design, "our services"), or 2+ pitch keywords | JUNK |
| One pitch keyword, a job-seeker phrase, or a vendor-style "we offer" | REVIEW |
| Description under 10 letters, gibberish, or no project type | REVIEW |
| Location outside the service area (Clark County / SW Washington zips and cities; for example Portland, OR) | REVIEW (never JUNK) |
| Disposable-email domain; unknown email sender with no remodel words | REVIEW |
| Client already has a Project or Invoice (existing customer) | REAL, but personal draft only, no templates |
| None of the above | REAL |

Justin (or Richard) can reclassify with one tap. A reclassification to REAL starts the funnel from that moment. An optional LLM second opinion on REVIEW items is off by default: it is shown as advice, never auto-promotes, and costs about $0.01 per item.

### Templates (standing approval; exact wording approved by Justin in Phase 0)

All templates are email from gtrsupport@, signed Justin, with the GTR street address footer. `[PHONE]` is fixed text chosen in Decision 2, not a token.

- **A, instant (about 1 min, 24/7).** Subject "Got your request, {firstName}". Body: "Hi {firstName}, thanks for reaching out to Golden Touch Remodeling. Richard got your request, and I'll send you a personal reply shortly. If you'd like to talk sooner, pick a time that works for you here: {bookingLink} or call [PHONE]. Justin"
- **B, +1 business day, same thread.** "Hi {firstName}, just checking in. The quickest next step is a short call with Richard so he can hear about your project. You can grab a time here: {bookingLink} or call [PHONE]. Justin"
- **C, +3 business days, same thread.** "Hi {firstName}, I don't want your request to fall through the cracks. If you're still planning your project, you can book a time with Richard here: {bookingLink}. If the timing isn't right, just reply and let me know and I'll stop following up. Justin"

`{firstName}` is the first token of the name, cleaned up; a missing or odd name becomes "there". Each template is stored with a version and a content hash. A send renders from the stored text and refuses to go if the hash is not the one Justin approved. Editing a template creates a new, unapproved version.

### Personal reply drafts

A draft starts from a per-source template (web, voicemail, email) filled with lead facts: project type, city, what they asked. It follows `message-voice.md`: short, warm, "I", no dashes, never "happy to", and it ends with the booking link. The existing `/api/leads/messages/suggest` Claude call can offer an optional "polish" button on the approval page. It is never automatic, and polished text is just an edit that needs its own tap.

### Push notification channel: ntfy

A single HTTP POST to a secret ntfy.sh topic URL (`LEAD_NTFY_URL`). Title: "New lead: Rebecca (web)". Body: "Reply draft ready". The click URL is the approval link. Priority is high from 07:00 to 21:00 Pacific and default otherwise. If the draft is still unapproved 15 minutes later (07:00 to 21:00), it re-pushes once, then posts to the Chat fallback.

Why ntfy:
- It is a real phone push with priority levels, one POST and no Google Cloud app to build.
- The agent-team monitoring spec (`agent-team\SPEC.md` §c) already routes phone paging through the ntfy app. I could not confirm the app is installed and subscribed yet, so Phase 0 checks it.
- Google Chat incoming webhooks cannot DM. Their push depends on per-space notification settings.

The **fallback and shared record** is a text post with a Justin @mention to a new "Leads" Chat space through `LEADS_CHAT_WEBHOOK`, reusing `chat-webhook.ts`. That also gives Richard visibility.

Privacy: ntfy.sh topics are readable by anyone who knows the name. So the topic is a 32+ character random secret, and the push carries only first name and source: no phone, email or message.

### Approval UX (mobile, `/leads/outreach/[messageId]`)

This is a Form-template page (`DESIGN_SYSTEM.md`, `hui-*`), with Server Actions in `src/lib/actions.ts` (repo rule). A push tap opens it, going through login if needed and returning to the link. Top to bottom:
- Lead header: name, source, "received 3 min ago", verdict chip with reasons.
- What they said: message, type, city, timing and budget.
- What has already gone out.
- The draft in large type, with **To** and **Subject** visible.

Large stacked buttons:
- **Send email**: one tap sends.
- **Text it**: only if Suppression rule 6 allows. It offers "Copy and open Google Voice" or "Open Messages" (`sms:`), then **I sent it**.
- **Call**: a `tel:` link, then "Log call".
- **Edit**: saves a new version, returns to the preview marked "Edited", and needs a new tap.
- Overflow menu: Not a lead, Do not contact, Skip.

"I sent it" stores `SENT_MANUAL` (a self-reported time). If nobody taps it within 30 min of approval, a reminder push goes out. `/settings/lead-outreach` lists the templates with Approve buttons, the pause toggle, test mode and flag states.

### Security

- **Approval token.** HMAC-SHA256 with `LEAD_APPROVAL_SECRET` over `messageId|version|contentHash|expiresAt`. `contentHash` is `sha256(canonicalJson({channel,to,subject,body}))`, reusing `canonicalJson` from `mcp-schedule-tools.ts`. The TTL is 12 h; an expired draft offers "Regenerate".
- **Single use** comes from a DB claim, the `executeConfirmed` pattern: a conditional update where status is PENDING_APPROVAL, the version matches, and `consumedAt` is null, in the same transaction that queues the send. `mintPreviewToken` is not reused: it is replayable by design. `McpConfirmation` is not reused either: its 10-minute TTL and MCP actor labels do not fit phone approvals.
- **Auth.** A NextAuth session is required, and the email must be in `LEAD_APPROVER_EMAILS` (Justin only in Phase 1). The send is a Server Action that re-verifies the token, the content hash, suppression and the kill switch at claim time. The page never trusts client-side text.
- **Kill switch.** `LEAD_OUTREACH_ENABLED === "1"` (env master, unset means off) AND NOT `leadOutreachPaused` (a new `automation-settings.ts` key, one tap on the settings page, fails closed). `LEAD_AUTO_TEMPLATES_ENABLED === "1"` is a separate master for templates A to C. Pushes to Justin still run while paused, so no lead is dropped silently, and they say "sending is paused".
- **Test mode.** With `LEAD_OUTREACH_TEST_ONLY === "1"`, only addresses and phones in `LEAD_TEST_RECIPIENTS` can be sent to, and only leads flagged `isTest`.
- **Gmail.** A **separate** OAuth client instance and refresh token for the lead inbox, not the shared Drive singleton, connected through the existing admin callback with a `purpose=lead-inbox` state. Scopes are `gmail.readonly` and `gmail.send` only. Before the first send, `users.getProfile` must return gtrsupport@.
- **Logs** never print bodies, emails or phones (match the existing name-only `console.error` style).

### Suppression (checked at claim time, before every send)

1. Kill switch or test-mode gates (above).
2. Verdict is not REAL: nothing is sent. JUNK is never contacted.
3. The lead stage is Connected, Estimate Sent, Won or Closed Lost, or the lead is archived: stop.
4. `Client.doNotContact`, a Twilio STOP, or a reply containing stop or unsubscribe: stop everything, and never contact again.
5. Stop the automated funnel on: a reply (same thread or from-address), a booking, a logged call, an inbound call or voicemail from the lead's number, or an approved personal message **plus** a reply.
6. SMS: an **automated** text needs stored consent with timestamp and source. A **manual** text (Justin's phone) is offered only when consent is on file or the lead first contacted GTR by phone. Otherwise the page shows Call only.
7. Quiet hours: templates B and C go out on business days (Mon to Fri) between 09:00 and 17:00 Pacific. Any SMS button is disabled from 20:00 to 08:00 Pacific. Template A email is sent 24/7.
8. Caps: at most 3 automated touches per lead, ever (unique `dedupeKey` per template per lead), 1 automated message per lead per day, no nudge within 20 h of any other outbound message to that lead, and 25 automated sends per day globally.
9. Existing customer (has a Project or Invoice): no templates.

### Metrics

Each lead records these timestamps: `sourceReceivedAt` (form submit, Gmail internal date, or Voice email date), `ingestedAt`, `qualifiedAt`, `firstTouchAt` (first customer-facing send of any kind), `draftReadyAt`, `notifiedAt`, `approvedAt`, `personalReplyAt`, `bookedAt`.

The headline numbers are **time to first touch** (`firstTouchAt − sourceReceivedAt`), **time to personal reply**, and approval latency (`approvedAt − notifiedAt`), each as median, p90, and percent under 5 minutes. The weekly report gives new leads by source (all intakes, and REAL only) and the funnel: leads → real → touched → replied → booked.

Every report carries its blind spots: calls answered live, texts to personal phones, the rlord@ inbox, and `SENT_MANUAL` times, which are self-reported.

`get_lead_funnel({ weeks: 1–12 })` returns:
- the summary above;
- per-lead rows: lead id, first name plus last initial, source, verdict and reasons, timings, state, stop reason;
- the REVIEW and JUNK queues, with the first 280 characters of the message and emails, phones and URLs masked;
- the `blindSpots` list.

Test leads are excluded. The tool uses SELECT only: it does not touch `isUnread` or `lastActivityAt` and writes no events.

The Paperclip **Marketing Lead** (read-only, drafts only; KPI: qualified consults booked per week) calls it daily. It flags suspected misclassifications, reports the funnel, and writes template-improvement proposals into its own report for Justin. The Chief of Staff morning brief reads the same tool.

### Separation from payment reminders

- A new `/api/cron/lead-outreach` (every minute; `CRON_SECRET`; `HC_PING_URL_LEAD_OUTREACH` heartbeat): Gmail poll, due nudges, Calendly poll every 5th run, draft expiry, re-push.
- It sends from gtrsupport@ via the Gmail API. Payment reminders keep Resend `notifications@`.
- Neither module imports the other. Lead code never reads `PaymentSchedule`, `EstimatePaymentSchedule` or `Invoice`, except a count used for the "existing customer" check.

### Booking

The booking link is Calendly with `name`, `email` and `utm_content=<opaque lead ref>` prefilled. ProBuild polls Calendly's scheduled events with `CALENDLY_TOKEN` and matches on `utm_content`, then on invitee email. A match sets `bookedAt`, creates a `LeadMeeting`, stops the funnel, and posts "Booked" to the Leads space. If Richard's plan does not allow API access, the approval and lead pages get a "Booked" tap instead (Open Questions).

## Files Touched

**ProBuild:**
- `prisma/schema.prisma`, `prisma/migrations/<ts>_lead_outreach/`, and `scripts/apply-lead-outreach-schema.mjs` (inert-on-import shape).
- `src/app/api/integrations/leads/ingest/route.ts` and `src/app/api/cron/lead-outreach/route.ts`. The `vercel.json` cron entry lands **only in the Phase 2 enablement PR**.
- `src/lib/lead-outreach/`: `ingest.ts` (session-free core, email/E.164 matching), `qualify.ts`, `templates.ts`, `suppression.ts`, `approval-token.ts`, `gmail-lead-inbox.ts`, `notify.ts`, `calendly.ts`, `metrics.ts`.
- `src/lib/automation-settings.ts` (a `leadOutreachPaused` key), `src/lib/gmail-client.ts` (a separate lead-inbox client), and `src/app/api/gmail/callback/route.ts` (the purpose state).
- `src/app/leads/outreach/[messageId]/page.tsx` (Server Actions in `src/lib/actions.ts`), and `src/app/settings/lead-outreach/page.tsx`.
- `src/app/api/mcp/[transport]/route.ts` (`get_lead_funnel`, `READONLY_TOOLS`).
- `.env.example` (names only).
- Tests: `tests/lead-outreach-*.test.ts` and `e2e/lead-outreach.spec.ts` (throwaway DB only).

**gtr-sales-draft:** `src/app/api/contact/route.ts`, `src/components/ui/ContactForm.tsx` (honeypot, render time, consent-label version), and the Vercel env `LEAD_INGEST_URL`, `LEAD_INGEST_SECRET`.

## Data Model Changes (additive)

- **`LeadOutreach`** (1:1 Lead): `leadId @unique`, `source` (WEB_FORM | VOICEMAIL | MISSED_CALL | EMAIL), `sourceRef @unique` (idempotency: `web:<submissionId>`, `gmail:<messageId>`), `sourceReceivedAt`, `ingestedAt`, `verdict`, `verdictReasons Json`, `qualifiedAt`, `qualifiedBy`, `state` (ACTIVE | STOPPED | DONE), `stopReason`, `stoppedAt`, the metric timestamps above, `gmailThreadId`, `bookingRef`, `attribution Json`, `botSignals Json`, `isTest`.
- **`LeadOutreachMessage`**: `leadId`, `kind` (TEMPLATE_A | TEMPLATE_B | TEMPLATE_C | PERSONAL | FOLLOWUP_7D), `channel` (EMAIL | SMS_MANUAL), `templateKey` / `templateVersion`, `to`, `subject`, `body`, `version`, `contentHash`, `status` (DRAFT | PENDING_APPROVAL | APPROVED | SENDING | SENT | SENT_MANUAL | FAILED | SUPPRESSED | EXPIRED | CANCELLED), `approvalExpiresAt`, `consumedAt`, `approvedBy`, `approvedAt`, `scheduledFor`, `sentAt`, `providerMessageId @unique`, `dedupeKey @unique` (for example `A:<leadId>`).
- **`LeadOutreachEvent`** (append-only audit): `leadId`, `messageId?`, `type`, `actor`, `at`, `detail Json`. Indexes on `(leadId, at)` and `(type, at)`.
- **`OutreachTemplate`**: `key`, `version`, `subject`, `body`, `contentHash`, `approvedBy?`, `approvedAt?`, `active`. Unique on `(key, version)`.
- **`Client`**: `smsConsent Boolean @default(false)`, `smsConsentAt`, `smsConsentSource`, `smsConsentTextVersion`, `doNotContact Boolean @default(false)`, `doNotContactAt`, `doNotContactReason`.
- **`CompanySettings`**: `leadInboxRefreshToken`, `leadInboxEmail`, and `leadGmailHistoryId`.
- **`AutomationSetting`**: key `leadOutreachPaused` (row, no DDL).

## Test Plan

- **Unit (one per Goal's "Accept" line):** ingest HMAC, replay and idempotency; matching by email/E.164 only; template-hash refusal; token misuse (tampered, stale version, expired, consumed, wrong user); the suppression matrix; quiet hours and business days; the three kill-switch states; the write-throwing double for `get_lead_funnel`; no cross-imports with payment reminders.
- **Qualification fixtures:** synthetic re-creations of the 12 historical patterns, no real PII. Pass means: all 5 spam give JUNK; the duplicate pair gives the second JUNK and the first REVIEW; the Portland one gives REVIEW; at least 4 of the 5 genuine ones give REAL and none gives JUNK.
- **E2E (Gate 1, real phone, test mode):**
  1. Submit a test lead through a site **preview** deployment. Template A lands in the test inbox within 90 s, and the push reaches the phone within 5 min.
  2. Tap Approve. The personal email arrives from gtrsupport@ in the same thread.
  3. Reply from the test inbox. The nudges are cancelled.
  4. Make a test booking. `bookedAt` is set.
  5. Leave a voicemail from Justin's cell on the office line. The draft push arrives within 5 min, and the SMS copy path plus "I sent it" works.
  6. Turn on the pause toggle, then unset the env master. Sends are blocked and logged in both cases.
  7. Confirm the events chain is complete and `get_lead_funnel` over the read-only key shows the test lead only when test leads are included.
- **Codex review** (`codex-reviewer`, gpt-6-astra) before merge. This code covers auth, tokens, external APIs and date math.

## Rollout (each gate must pass before the next phase)

- **Phase 0, setup (Justin, about 30 min).** Connect gtrsupport@ as the lead inbox. Install ntfy and subscribe to the topic. Answer Decisions 1 to 3. Approve the template wording. Confirm Calendly API access. Optionally turn on Voice text-to-email on the office line. *Gate:* a test push arrives within 30 s, and `getProfile` returns gtrsupport@.
- **Phase 1, build, test leads only.** Merge with the env master unset and test mode on. No cron in `vercel.json`, and the site does not post yet (preview only). *Gate:* every E2E step passes, the fixture suite passes, and Codex review is clean.
- **Phase 2, real leads.** Justin approves the first real send himself. The site posts to ingest, the cron is added, and `LEAD_OUTREACH_ENABLED=1` with test mode off. Template A is on only if Decision 1 is yes, set by Justin after he approves the template in settings. Every personal message is still tapped. *Gate:* 7 days with no wrong or duplicate send, a complete audit chain for every lead, and metrics reviewed with Justin.
- **Phase 3, full funnel.** Templates B and C on (Justin sets `LEAD_AUTO_TEMPLATES_ENABLED`). The Marketing Lead starts its daily reads.
- **Phase 4 (separate specs).** Automatic SMS from an API number for consented leads and missed-call text-back (Decision 3), the rlord@ inbox, and old-estimate follow-ups.

## Rollback Plan

- **Instant:** the pause toggle (one tap), or unset `LEAD_OUTREACH_ENABLED` / `LEAD_AUTO_TEMPLATES_ENABLED` and redeploy.
- **Full:** remove the cron entry and the site's ingest call. The connect@ email path never changed, so intake falls back to today's behavior.
- The schema is additive; the tables can stay dormant. No payment or money code is touched.

## Open Decisions for Justin (recommendation first)

1. **Turn on the standing-approved templates (instant reply, then the +1 and +3 day nudges, email only)?** *Recommend yes.* It is the only way to hit under 5 minutes, 24/7. Turn it on in Phase 2 for the instant reply after you approve the exact wording, and add the nudges after one clean week.
2. **Which number goes in the templates?** The website shows (360) 200-1521; the office Voice line is (360) 524-4728. *Recommend (360) 200-1521*, since every web lead already saw it, **if** it rings a person 8 to 6. If it doesn't, switch the site and the templates to 524-4728 together, so a lead never sees two numbers.
3. **Automatic texts (Phase 4): use ProBuild's existing Twilio number for consented web leads, and a missed-call text-back?** *Recommend: not yet.* Stay email plus your own tap-to-text until the Twilio number's A2P 10DLC registration is confirmed to cover this use. Texts from a new number also split the conversation away from Google Voice.

## Open Questions (doer bounces back here if unresolved)

- Does Richard's Calendly plan allow API reads (scheduled events via a personal access token)? Webhooks need a paid tier. If neither works, use the manual "Booked" tap.
- Does `connect@` deliver into gtrsupport@? The Paperclip inbox digest finds web inquiries there, so it appears to, but this is not confirmed.
- Justin's phone OS. On iPhone, `sms:` opens Messages (his cell number), not Google Voice, which is why "Copy and open Voice" is the primary text button.
- Which mailbox the existing Drive/Gmail connection (`googleDriveEmail`) belongs to. The lead inbox uses its own connection either way.

## Cost Estimate

- **Templates:** $0.
- **Optional Claude polish or second opinion:** about $0.007 per call at Sonnet 5 rates ($2/$10 per MTok, about 2k in and 300 out); under $1 a month at current volume (about 1 to 5 leads a week).
- **Gmail API:** free.
- **ntfy.sh public server:** free. A private topic tier, or self-hosting on the existing VPS, is optional.
- **Vercel:** a per-minute cron is about 43k invocations a month. It is expected to fit the current Pro plan (check the usage page after week 1).
- **Calendly:** $0 if API reads work on the current plan. Otherwise a paid seat of roughly $10 to $16 a month (check current pricing).
- **Phase 4 Twilio (not in this build):** per-message fees plus A2P registration if not already done.
