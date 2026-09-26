# Speed-to-Lead v1a: intake, triage, instant internal alert, tracking (no customer sends)

**ID:** PB-leads-001 v1a · **Date:** 2026-09-25 · **Status:** SCOPE APPROVED (Justin, 2026-09-25). Build spec; not yet Codex-reviewed.
**Addendum to:** `docs/plans/SPEED-TO-LEAD-SPEC.md`. Where the two disagree, this file wins for v1a.
**Inputs:** PR #557 at `bb693386` (`feat/PB-leads-001-speed-to-lead-v1`), R0 mailbox findings (2026-09-25), Codex R1 to R3 and checker results on #557.

## Decision

Speed-to-lead is split. v1a ships the safe half. v2 (auto-reply, template A, approvals, dispatch, follow-ups) is rebuilt later, separately.

**v1a does:** lead intake (signed web webhook, plus a Gmail poll of gtrsupport@ for the website form email and Google Voice notifications), conservative triage, an instant internal alert (ntfy push to Justin, Google Chat card to the team), and tracking (Booked/Called, the 09:00 digest, the funnel count tool, an append-only audit trail).

**v1a sends nothing to customers.** No template A, no auto-reply, no approval or dispatch path, no follow-up drafts, no `gmail.send` scope. Outbound code is deleted from the v1a branch, not gated.

**Hard rules:** never merge; never apply migrations to prod; never send any message; never set production env vars; never use `vercel --token`. Everything sits behind `SPEED_TO_LEAD_MODE`, default OFF.

**Branch plan:** a new branch `feat/PB-leads-001-v1a` cut from current `origin/main`. Files are ported from #557 per the table below; #557 is not rebased. #557 stays a draft and becomes the v2 reference; it is not merged or deleted. v1a gets its own draft PR.

## Modes (v1a meaning)

| `SPEED_TO_LEAD_MODE` | Behavior |
|---|---|
| unset, OFF, or any unrecognized value | Nothing runs. Intake route returns 503 before reading the body; the cron returns `{mode:"OFF"}` with zero Gmail, ntfy or Chat calls; no digest. |
| TEST | Intake, poll, triage, tracking and ntfy to Justin run. No team Chat cards. |
| LIVE, on production (`VERCEL_ENV=production`) | TEST plus team Chat cards. Off production, LIVE behaves as TEST. |

- `speedToLeadPaused` (existing `AutomationSetting`, Justin-only toggle) is an instant alert kill switch that needs no redeploy. While paused, due alerts become `SKIPPED` (reason `paused`) and are never sent, so unpausing releases no backlog.
- **v2 guard.** v2 must add its own flag (for example `SPEED_TO_LEAD_OUTREACH_MODE`, default OFF) behind its own readiness gate. A v1a LIVE setting must never imply customer sending.

## (1) #557 files: keep, modify, drop

Paths are relative to the ProBuild repo. "Keep" means port unchanged from `bb693386`.

### `src/lib/speed-to-lead/`

| File | v1a | Notes |
|---|---|---|
| `hmac.ts` | Keep | |
| `payload.ts` | Modify | Add `fallbackPayloadSchema`, the typed shape the poller writes and promotion reads (see finding 5). |
| `settings.ts` | Keep | Pause toggle. |
| `triage.ts` | Modify | `endpoint-suppressed-or-junk` becomes `endpoint-junk`, since v1a has no suppression. Add a pure `alertAudience(verdict, reasons)` (see alert design). |
| `authentication.ts` | Modify | Rewritten trust rules (finding 1, plus the `header.d` bug under Other defects). |
| `gmail-poll.ts` | Modify | Delete the reply, opt-out and bounce branch, `findLeadIdsContactedAt`, `findLeadIdsByThread`, and the own-sent-copy skip. Add a metadata-first fetch, the Voice subject filter, bounds and backoff, the resync fix, and the typed fallback write (findings 4 to 6). |
| `gmail-inbox-client.ts` | Modify | Scope list is `gmail.readonly` only. Refresh token encrypted with `encryptObject` from `src/lib/crypto.ts`. Sid-bound state. Bounded token refresh (findings 2 and 6). |
| `intake.ts` | Modify | Delete template A creation and the `approval` and `template` imports. Lead-creating transactions also insert the `LeadAlert` rows. A bad test signature is refused (fail closed). Add the cross-channel email dedupe and the Voice rules (below). |
| `contact-endpoint.ts` | Modify | Keep `normalizeEndpoint`, `markEndpointJunk`, and a junk-only `getEndpointStatus`. Delete suppress, bounce, clear-suppression, recipient and footer validators. |
| `constants.ts` | Modify | Keep mode, `isProduction`, approver, triage, service-area, `WEBHOOK_SKEW_MS` and the Gmail timeout. Delete every send, template, approval, freshness, reconcile, follow-up, cap, allowlist, footer, calendly and phone constant. `DISPATCH_FROM_ADDRESS` becomes `LEAD_INBOX_ADDRESS`. Add the alert constants. |
| `audit.ts` | Modify | Writes `SpeedToLeadEvent`; `logOutreachEvent` is renamed `logLeadEvent`. |
| `funnel.ts` | Modify | Drop the outreach `groupBy`. Add alert delivered and dead counts by channel. |
| `push.ts` | Drop | Replaced by `alerts.ts`: two independent channels, not "Chat as ntfy fallback". |
| `followups.ts` | Drop | `markLeadBooked`, `markLeadCalled` and the digest move to `tracking.ts` without cancellation; the follow-up sweep is deleted. |
| `approval.ts`, `dispatch.ts`, `template.ts`, `cancellation.ts`, `csrf.ts`, `freshness.ts`, `reply-detection.ts`, `readiness.ts`, `fingerprint.ts` | Drop | Outbound or send-gating only. |
| **new** `alerts.ts` | Add | Alert row creation, the claim and deliver loop, ntfy and Chat senders. |
| **new** `tracking.ts` | Add | Booked/Called writes and `maybeSend0900Digest`. |
| **new** `fallback-email.ts` | Add | A pure parser for the site's connect@ email (below). |

### Everything else

| File | v1a | Notes |
|---|---|---|
| `src/app/api/speed-to-lead/intake/route.ts` | Modify | Mode gate first. 32 KB body cap before HMAC. Generic 401 (no `reason`). Response is `{ok, duplicate}` only (no leadId or verdict). Alert delivery runs in `after()`. |
| `src/app/api/cron/speed-to-lead/route.ts` | Modify | OFF returns early. Then poll, `promoteDueFallbacks`, `deliverDueAlerts`, `maybeSend0900Digest`. Reconcile, dispatch, expiry and follow-ups are deleted. |
| `src/app/api/gmail/callback/route.ts` | Modify | Keep `safeOAuthErrorCategory`. Add the granted-scope check and sid binding. The identity check uses `LEAD_INBOX_ADDRESS`. |
| `src/app/api/speed-to-lead/readiness/route.ts` | Drop | |
| `src/app/leads/outreach/[id]/page.tsx`, `OutreachApprovalForm.tsx` | Drop | |
| `src/app/settings/speed-to-lead/page.tsx`, `SpeedToLeadSettingsPanel.tsx` | Modify | Shows mode, pause, "Connect gtrsupport@ (read-only)", poll health and alert health (DEAD rows). Template, readiness, activation and suppression UI deleted. |
| `src/app/leads/[id]/LeadDetailsSidebar.tsx` | Keep | 3-line include. |
| `src/app/leads/[id]/SpeedToLeadBookedCalledButtons.tsx` | Modify | Imports the new actions file. Adds Justin-only Junk and Promote. |
| `src/lib/actions.ts` | **Revert to main** | No change at all. This removes the line shifts behind the payroll-manifest failures (finding 9). |
| **new** `src/lib/speed-to-lead-actions.ts` | Add | `"use server"`, same pattern as `src/lib/lead-note-actions.ts`. Booked and Called use `assertActiveStaff` from `@/lib/permissions`. Junk, Promote and Pause are Justin-only via `isApprover`. |
| `src/lib/auth.ts` | Modify (small) | In the `jwt` callback, set `token.sid = randomUUID()` only when `user` is present (sign-in). Insert it below line 79 so the manifest pin `lib/auth.ts:79::update` holds. |
| `src/proxy.ts` | Keep | Exact-path bypass for `api/speed-to-lead/intake` (Codex R2: FIXED). |
| `src/app/api/mcp/[transport]/route.ts`, `tests/mcp-readonly-key.test.ts` | Keep | `get_lead_funnel_summary` stays in `READONLY_TOOLS` (21 tools). |
| `vercel.json` | Keep | `/api/cron/speed-to-lead` every minute. |
| `package.json` | Modify | Drop the `prebuild` fingerprint hook. `test:unit` lists v1a tests only. |
| `.env.example` | Modify | Keep `SPEED_TO_LEAD_MODE`, `_APPROVER_EMAIL`, `_WEBHOOK_SECRET`, `LEAD_INGEST_TEST_SECRET`, `_NTFY_TOPIC`, `_NTFY_BASE_URL`, `_CHAT_WEBHOOK_URL`, `_TRUSTED_SENDERS`, `_SERVICE_AREA_*`, `HC_PING_URL_SPEED_TO_LEAD`. Add optional `_NTFY_TOKEN`. Drop `_TEMPLATE_A`, `_TEST_ALLOWLIST`, `_DAILY_CAP`, `_READINESS_TEST_EMAIL`, `_FINGERPRINT`, `_WEBSITE_FROM_ADDRESS`. |
| `.github/workflows/ci.yml` | Keep | The DB race step runs `tests/speed-to-lead-intake-db.test.ts` and the new alerts DB test; the dispatch test is gone. Keep `NODE_OPTIONS=--max-old-space-size=6144`. |
| `prisma/schema.prisma`, migration | Replace | v1a models only (section 5). |
| `scripts/apply-speed-to-lead.mjs` | Keep | Splitter fix (Codex R2: FIXED), now covered by a test. |
| `scripts/speed-to-lead-fingerprint.mjs` | Drop | |
| `tests/payroll-writer-manifest.test.ts`, `tests/payroll-user-writer-manifest.test.ts`, `tests/time-entry-void-readers.test.ts` | **Revert to main** | |

**Tests.**
- Keep: `hmac`, `payload`.
- Modify: `triage`, `authentication`, `intake-db`, `mode`.
- Drop: `actions-delegate`, `approval`, `csrf`, `dispatch-db`, `fingerprint`, `followups`, `freshness`, `raw-message`, `reply-detection`, `template`.
- Add: `alerts` (unit and DB), `gmail-poll` (fake Gmail), `fallback-email`, `oauth-state`, `no-outbound` (static), `audit-append-only` (static), `apply-splitter`, and a proxy case in `tests/proxy-mobile-routes.test.ts`.

## (2) Alert design

**Existing pattern reused:**
- `isValidChatWebhookUrl` from `src/lib/chat-webhook.ts` (SSRF allowlist).
- The `postOwnerCard` shape in `src/lib/receipt-request-cards.ts`:
  - `thread.threadKey` goes in the body, with `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
  - outcomes are `delivered`, `rejected` or `unknown`;
  - a clamped timeout.
- `receipt-request-cards.ts` is not edited. The v1a sender lives in `alerts.ts`, and extracting a shared helper is a later cleanup.

**Env vars.**
- Existing Chat webhooks: `MAIN_OFFICE_CHAT_WEBHOOK`, `BOT_HEALTH_CHAT_WEBHOOK`, `RECEIPTS_CHAT_WEBHOOK`, `MEAL_SKIP_CHAT_WEBHOOK_URL`.
- v1a uses its own `SPEED_TO_LEAD_CHAT_WEBHOOK_URL` (already in #557's `.env.example`). It never falls back to another space's variable.
- **Recommended space:** Customer Activity. Justin, Marge, Richard and CJ are already members, and its one-thread-per-customer convention matches one thread per lead.
- ntfy: `SPEED_TO_LEAD_NTFY_TOPIC`, `SPEED_TO_LEAD_NTFY_BASE_URL` (default `https://ntfy.sh`), and optional `SPEED_TO_LEAD_NTFY_TOKEN` (Bearer).
- Justin sets all of these. Nothing here sets them.

**Who gets what.**

| Lead | ntfy to Justin | Team Chat card (LIVE only) |
|---|---|---|
| REAL web lead | yes, priority 4 | yes |
| REVIEW with no spam signal: `email-fallback`, `voice`, `existing-customer`, `outside-service-area`, `email-phone-different-clients`, `fallback-unparsed` | yes, priority 4 | yes, labeled "Needs review: \<reasons\>" |
| REVIEW with any spam signal: honeypot, too fast, link, pitch word, too short, reused phone or message | yes, priority 2 | no (it appears in the digest) |
| JUNK (a Justin-marked endpoint) | no | no |
| `isTest` lead | yes, "[TEST]" | yes in LIVE, "[TEST] not a customer" |

**Content and privacy.** ntfy.sh is a third-party server and its topics are open to anyone who knows the name.
- The ntfy body carries only: first name, city, project scope, verdict, the last 4 digits of the phone, and a `Click:` link to `/leads/<id>`. It never carries email, full phone or message text.
- The Chat card stays inside Workspace, so it carries name, phone, email, city, scope, the first 200 characters of the message, verdict and reasons, and the ProBuild link.
- The card is text, matching ProBuild's existing cards.

**Dedupe: exactly one alert per lead per channel.**
- **Transactional outbox.** The transaction that creates the Lead also inserts its `LeadAlert` rows:
  - the winning webhook insert, including the takeover of a `PENDING_FALLBACK` row;
  - fallback promotion;
  - Voice intake.

  The insert is `INSERT ... ON CONFLICT ("leadId","channel") DO NOTHING` on `@@unique([leadId, channel])`. A lost race, a webhook retry or a re-read Gmail message creates no Lead and therefore no alert.
- **Claim.** `UPDATE "LeadAlert" SET status='SENDING', "claimedAt"=now(), attempts=attempts+1 WHERE id=$1 AND status='PENDING' AND "nextAttemptAt"<=now()`. Only the claimant sends.
- **Chat identity.** `thread.threadKey = "stl-lead-<leadId>"`. Any retry lands as a reply in the same thread, never as a second top-level card.
- **ntfy identity.** Tag `stl-<alertId>`. Before retrying after an `unknown` outcome, the sender polls the topic cache (`GET /<topic>/json?poll=1&since=<claimedAt>`) for that tag. If it finds it, the row is `DELIVERED`. The exact ntfy poll and tag-filter parameters must be verified during the build. If polling is unavailable, a rare duplicate push is the accepted cost.

**Durable retry (Codex R2 #22).**

| Outcome | Row becomes |
|---|---|
| delivered (ntfy 2xx with `id`; Chat 2xx with `name` and `thread.name`) | `DELIVERED`, with `deliveredAt` and `providerRef` |
| unknown (timeout, network error, 5xx, 2xx without identity) | `PENDING`, `nextAttemptAt` = now + backoff (1, 2, 4, 8, 16, then 30 min) |
| 429 | `PENDING`, honoring `Retry-After` |
| other 4xx, or missing or invalid config | `DEAD` (config error), no retry |
| `SENDING` older than 2 min (worker died) | reclaimable, same as unknown |
| 12 attempts, or lead received more than 6 h ago | `DEAD`, or `SKIPPED` if never attempted. No stale alerts. |

- **Who delivers.**
  - The intake route delivers in `after()`, so a webhook alert goes out within about 60 s.
  - Every cron run calls `deliverDueAlerts`, bounded to 20 rows and a 20 s budget. This is the persisted retry, and it also covers a crash between commit and `after()`.
  - Fallback and Voice leads alert within about 2 min (a 1-minute poll, then same-run delivery).
  - A fallback that carries `X-GTR-Submission-Id` waits its 10-minute takeover window first. This is the degraded path only.
- **Surfacing failures.** DEAD rows show on the settings page and at the top of the 09:00 digest. Only an allowlisted `lastErrorCategory` is stored, never a response body.
- **The R3 P2 reconciliation bug does not recur here.** A claim is never permanent before the send: `SENDING` expires and is re-claimed.

## (3) Codex findings from #557 that apply to v1a

The status is Codex's grade at `bb693386` (R3) unless noted.

| # | Finding | Status | v1a fix | Tests |
|---|---|---|---|---|
| 1 | ARC/DKIM trust. It now only gates fallback and Voice intake and alerts, but it must not be forgeable into fake leads. | PARTIAL. R3 probe: an attacker-sealed i=1 ARC set claiming `mx.google.com` is trusted. | See "Authentication rules" below. | 10, 11 |
| 2 | OAuth callback CSRF and identity | R3: FIXED for signed state, browser nonce and verified mailbox. Still needs session binding and read-only scope. | State HMAC covers `{approverEmail, sid, nonce, issuedAt}`. `sid` is the stable session claim added in `auth.ts`; sessions without it are refused (sign out and in once). Keep the HttpOnly double-submit nonce cookie, single use through the `AutomationSetting` unique key, and the 10-min TTL. Request `gmail.readonly` only, with `include_granted_scopes=false`. After exchange, refuse unless `tokens.scope` is exactly `gmail.readonly` and `getProfile` equals `gtrsupport@goldentouchremodeling.com`. Store the refresh token with `encryptObject`. | 24 |
| 3 | Proxy bypass for the intake route | R2: FIXED | Keep the exact-path pattern. Add the proxy test: intake is reachable, a sibling path is still redirected, and a Server Action header is refused. | 4 |
| 4 | History 404 resync | PARTIAL (the cursor can skip mail; wrong lower bound) | (a) `getProfile` first, keeping `historyId` as H0. (b) `messages.list q=after:<since>`, where since = max(cutoff, last successful poll *start* minus 10 min, now minus 72 h). (c) Process idempotently. (d) Save H0 as the cursor, so anything newer is read from H0 next run. (e) Resync state (H0, since, pageToken) persists and resumes across runs. (f) A gap over 72 h resets the cursor and cutoff and sends one ntfy naming the unscanned window. | 13 |
| 5 | Fallback payload shape mismatch | R2: FIXED with a regex. Still fragile: the first line becomes the name. | The poller parses once, at write, into `fallbackPayloadSchema` `{name,email,phone,city,scope,message,submissionId}`. Email comes from `Reply-To` (single address). The other fields come from the site's labels `Name/Email/Phone/Message/Project city/Project scope` in `gtr-sales-draft` `src/app/api/contact/route.ts`, HTML-entity decoded. Promotion reads the same schema. Parse failure gives a "Website inquiry" lead with reason `fallback-unparsed`, still alerted. Store the matched trust rule, not raw headers. | 8 |
| 6 | Bounded Gmail calls and backoff | PARTIAL (no backoff; OAuth refresh unbounded) | Per run: at most 10 history pages, 50 message gets and 40 s wall time. Stop at a history-record boundary and save that record's `id` as the cursor. Fetch `format:"metadata"` first; `full` only for a trusted website or Voice sender, so the ~200 other connect@ Group messages cost one call each. 10 s per-request timeout, and token refresh bounded (a timeout on the OAuth2 client transport, or a `getAccessToken` race). Consecutive failures back off 1, 2, 4, 8, then 15 min, persisted in `CompanySettings`, honoring `Retry-After`. After 15 min of failure, one ntfy. `invalid_grant` marks the inbox disconnected and sends one ntfy. A 404 on one message skips only that message. | 14, 15 |
| 7 | No raw OAuth errors in logs | R3: FIXED (finite allowlist) | Keep `safeOAuthErrorCategory`. Apply the same allowlist to the poll's catch and the alert senders. | 24 |
| 8 | Migration splitter | R2: FIXED | Keep. Add a test that splits the v1a migration file itself and checks that no fragment starts mid-comment or mid-`DO` block. The new migration's header must not contain the marker text. | 26 |
| 9 | Payroll-manifest test failures in CI | Checker-final: Build + Bundle Size red, 3 tests pinned to `lib/actions.ts` lines | Leave `src/lib/actions.ts` untouched (actions live in `speed-to-lead-actions.ts`), and restore the three test files to main. The `auth.ts` insertion goes below the pinned line 79. | 27 |

**Other #557 findings that still apply:**
- **R3 P1:** a failed test signature must never downgrade to a real lead. A present-but-invalid signature, or a missing `LEAD_INGEST_TEST_SECRET`, is a 401 with no rows (test 5).
- **R1 #29 / R2:** DB tests use a guarded disposable `SPEED_TO_LEAD_TEST_URL` and never touch the stored mailbox credential.
- **R1 #32:** intake interactive transactions set explicit `timeout` and `maxWait`. A timeout maps to 503, so the site retries and intake stays idempotent. The race test must pass 20 consecutive runs.
- **R1 #30:** audit coverage.
- **Checker R1:** Voice and fallback leads must alert, which the transactional outbox handles.

**Moot in v1a (deleted code):** approval, dispatch and cancellation races; opt-out and bounce handling; template A checks; expiry; follow-ups; readiness; recipient and footer validation; fingerprint; reconciliation; send-again; outreach CSRF; and the R2 regressions tied to them.

### Authentication rules (finding 1)

- **Parse properly.** Parse `Authentication-Results` into result tokens with parenthesized comments removed, so a `dmarc=` inside `arc=pass (...)` is never read as top-level. Take the DKIM domain from `header.d=` **or** the domain of `header.i=@…`.
- **Voice (direct).** All of these are required:
  - From is `voice-noreply@google.com`, and there is no `X-Google-Group-Id`;
  - the topmost `Authentication-Results` has authserv-id `mx.google.com`, `dkim=pass` for domain `google.com`, and `dmarc=pass header.from=google.com`;
  - the subject starts with "New missed call from", "New voicemail from" or "New text message from". "Welcome to Google Voice" is ignored.
- **Website (Group relay).** All of these are required:
  - From is `website@goldentouchremodeling.com`;
  - `X-Google-Group-Id: 347075611006` and `List-ID: <Connect.goldentouchremodeling.com>`;
  - the top `mx.google.com` result says `arc=pass`;
  - there is exactly one `ARC-Seal` with `i=1`, and it has `d=google.com`. Google's `arc=pass` validated that seal, so an attacker-sealed i=1 fails here;
  - there is exactly one `ARC-Authentication-Results` with `i=1`, from `mx.google.com`, showing `dkim=pass` with `header.i=@goldentouchremodeling.com header.s=resend` and `dmarc=pass header.from=goldentouchremodeling.com`.
  - The top-level `dkim=pass` is the Group's own `s=google` re-signature. It is **never** enough for `website@`.
- **Config.** Both patterns are built-in defaults. `SPEED_TO_LEAD_TRUSTED_SENDERS` may override them but must pass a zod schema. If invalid, the built-in defaults apply and an error is logged. This fixes R0's replace-not-merge footgun.
- **Before build:** confirm the `ARC-Seal i=1` `d=` value on R0 sample `1a0cfd52fb38aade`. R0 recorded `cv=` but not `d=`.

### Other defects found writing this (fix in v1a)

- **`header.d` bug (from reading the code; not executed).** At `bb693386`, `domainsMatch` requires `header.d=`. R0 found that Gmail never emits it; it writes `header.i=@domain`. So every real website and Voice sample would now be untrusted, and fallback and Voice intake would never fire. R0's "all 28 trusted" simulation ran on the earlier `f00c5069`. Test 10 pins the real shapes.
- **Voice noise.**
  - A caller whose number matches a client with a Project or Invoice creates no Lead and no alert; it is logged only. Customer Activity already tracks those calls.
  - A repeat call from the same number within 7 days of an open lead links to that lead, with no new alert.
  - The caller phone is normalized to E.164 from `(NNN) NNN-NNNN`. R0 found the regex drops the "(".
- **Cross-channel dedupe when `submissionId` is missing on either side** (the site isn't updated yet, or the Group strips the header). Both the webhook and fallback promotion take `pg_advisory_xact_lock(hashtext(normalizedEmail))` and link to any WEB or fallback intake with the same email within 15 minutes.
  - A fallback with no `submissionId` is due immediately (no webhook twin to wait for).
  - A fallback with `submissionId` keeps the 10-minute window.
- **Digest marker.** #557 writes "sent" before sending, so a failed push loses the day. v1a claims the marker, sends, then marks sent, and releases the claim on failure so the next minute within 09:xx retries.
- **The #557 migration comment cites `tests/speed-to-lead-append-only.test.ts`, which does not exist.** v1a adds the real static test.
- **Flagged, out of scope:**
  - `Lead`, `Client` and `CompanySettings` have no RLS in production's snapshot; the existing `googleDriveRefreshToken` is stored in plain text there.
  - The domain's DMARC is `p=NONE`, a DNS decision.
  - connect@ Group posting permissions (R0 open item).

## (4) Acceptance tests

Tests 1 to 27 run in CI or locally with stubbed ntfy and Chat endpoints (a local HTTP sink). No real message is sent by the builder. Tests 28 and 29 are Justin's steps.

**Scope and safety**
1. **No outbound path (static test).**
   - Searching `src/` (speed-to-lead files, intake, cron and callback routes, `speed-to-lead-actions.ts`) finds none of: `messages.send`, `drafts.`, `gmail.send`, `buildRawMessage`, `Outreach`, `dispatch`, `resend`, `twilio`.
   - `LEAD_INBOX_SCOPES` deep-equals `["https://www.googleapis.com/auth/gmail.readonly"]`.
   - The schema has no `Outreach*` or `ReadinessRecord` model.
2. **Mode.** Unset, `off`, `Live ` with a typo, or `yes` all mean OFF: the intake route returns 503 with no DB access, and the cron makes zero Gmail, ntfy or Chat calls (spies). `LIVE` with `VERCEL_ENV=preview` creates no CHAT rows.
3. **Pause.** Due rows become `SKIPPED(paused)` with zero posts. After unpause, only new leads alert.

**Intake**

4. **HMAC and proxy.**
   - A valid signature returns 200.
   - A bad signature, skew over 5 min, or missing headers returns 401 with a generic body. A body over 32 KB returns 413.
   - Proxy: an unauthenticated POST to `/api/speed-to-lead/intake` reaches the route, `/api/speed-to-lead/other` redirects to login, and a Server Action header is refused.
5. **Test signature.** A valid `LEAD_INGEST_TEST_SECRET` signature gives `isTest=true`. An invalid signature, or an unset secret, returns 401 with zero rows.
6. **Exactly once** (real Postgres, CI migrations job, 20 consecutive green runs). Webhook-first, fallback-first, and 5 concurrent webhooks for one `submissionId` each produce 1 Lead, 1 intake row, and at most 1 `LeadAlert` per channel. A forced transaction timeout returns 503 and a retry succeeds.
7. **Cross-channel dedupe.** A fallback without `submissionId` plus a webhook for the same email within 15 min, in either order, produces one Lead.
8. **Fallback parsing.**
   - A fixture shaped like the site's HTML email, with `Reply-To` set, promotes with every field filled.
   - A malformed body gives a "Website inquiry" REVIEW lead with `fallback-unparsed`, still alerted.
   - A fallback with `submissionId` waits 10 min; one without is due immediately.
9. **Triage.**
   - Each REAL check failing alone gives REVIEW with that reason.
   - Fallback and Voice are always REVIEW.
   - A junk endpoint gives JUNK and zero alert rows.
   - Junk and Promote are Justin-only; Promote creates no alert.

**Authentication**

10. **Real shapes pass.** Masked fixtures of R0 samples `1a0cfd52fb38aade` (website) and `1a08714f94457353` (Voice) are trusted, with DKIM matched via `header.i`.
11. **Forgeries fail.** Each case below is untrusted and creates no intake row:
    - (a) website@ with only the Group `s=google` pass, where i=1 shows `dmarc=fail`;
    - (b) an attacker-sealed i=1 (`ARC-Seal d=attacker.example`) claiming `mx.google.com` `s=resend` pass;
    - (c) duplicate i=1 headers;
    - (d) a top authserv-id of `attacker.example` with `arc=pass`;
    - (e) a spoofed lower `Authentication-Results`;
    - (f) `d=` matching with `dkim=fail`;
    - (g) `dmarc=pass` only inside the `arc=pass(...)` comment;
    - (h) website@ without the Group ID or List-ID;
    - (i) Voice From with a non-google.com DKIM domain.
12. **Voice.**
    - "New missed call from (360) 555-0100" gives a VOICE lead with `+13605550100`.
    - "Welcome to Google Voice" is ignored.
    - An existing customer's number creates no lead.
    - A repeat call within 7 days links to the open lead.

**Poll**

13. **Resync** (fake Gmail).
    - A history 404 uses the snapshot-first order.
    - A message inserted between the list and the cursor save is processed next run.
    - A 72 h gap resets the cursor, and exactly one gap push is created (stubbed).
14. **Failures.** A message 404 skips only that message and the cursor advances. A 5xx aborts the run with the cursor unchanged.
15. **Bounds.**
    - Caps are respected, and the next run resumes from the last complete history record.
    - Every Gmail and token call has a timeout.
    - Backoff follows 1, 2, 4, 8, 15 min and honors `Retry-After`.
    - One "poll failing" push after 15 min; `invalid_grant` gives disconnected plus one push.
    - A non-lead message costs exactly one metadata get.

**Alerts**

16. **Audience.** Row creation follows the audience table exactly, in the Lead's own transaction. A Lead never exists without its rows (fault injected after insert).
17. **Latency** (stubs, timestamps logged).
    - Webhook to both stub posts in under 60 s.
    - Gmail fallback (no `submissionId`) or Voice email to posts in under 3 min, with the cron running each minute.
18. **Concurrency.** Two concurrent `deliverDueAlerts` runs give exactly one post per row.
19. **Failure matrix.**
    - An ntfy 500 or timeout retries with backoff, and the cache-check hit marks it DELIVERED without reposting.
    - An ntfy 400 goes DEAD.
    - A Chat 429 retries after `Retry-After`; another Chat 4xx goes DEAD.
    - A Chat timeout retries with the same `threadKey` plus `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`.
    - `SENDING` over 2 min is reclaimed.
    - 12 attempts or 6 h gives DEAD or SKIPPED, listed in the digest and on settings.
    - A process kill between commit and `after()` still delivers on the next cron.
20. **Content.**
    - ntfy bodies contain no email, full phone or message text.
    - The Chat card has all listed fields and the `/leads/<id>` link.
    - `[TEST]` labels appear on `isTest` leads.

**Tracking**

21. **Booked and Called.**
    - Any active staff can mark them; the timestamp is set once, and a second press is a no-op.
    - An event is logged with the actor.
    - A signed-out request is rejected. A non-approver attempting Junk, Promote or Pause is rejected with no write.
22. **09:00 digest.**
    - Sent once at 09:00 America/Los_Angeles, even with two concurrent cron runs; none in OFF; a failed push retries within the hour.
    - Lists open feature-owned leads from the last 14 days (not Called, Booked, JUNK, closed or archived), DEAD alerts and poll health.
    - Never lists legacy leads.
23. **Funnel and audit.**
    - `get_lead_funnel_summary` returns counts only (intake by source and verdict, alerts by channel and status, called, booked) and is in `READONLY_TOOLS` (snapshot of 21).
    - Every listed event kind writes one `SpeedToLeadEvent`.
    - A static test finds no `.update`, `.delete` or `.upsert` on `speedToLeadEvent` in `src/`.

**OAuth, schema, CI**

24. **OAuth callback.**
    - Each of these is refused with nothing persisted: wrong or missing `sid`, missing cookie nonce, expired state, replayed state, a non-approver session, another mailbox, or a granted scope beyond `gmail.readonly`.
    - Success stores the token encrypted.
    - A thrown `GaxiosError` logs only `{category,status}`; a console spy finds no code or token text.
25. **Additive migration.**
    - It applies twice cleanly on empty Postgres.
    - A grep finds no `DROP`, `RENAME`, `ALTER COLUMN` or `SET NOT NULL` on an existing table.
    - RLS is enabled on the 4 new tables.
26. **Apply script.** It splits the v1a migration into the expected statement count (splitter test).
27. **CI green on the v1a PR head.** This covers Build + Bundle Size (the 3 manifest tests unchanged from main), Migrations reproduce production (including the DB race tests and `check-migrations-match` after the snapshot refresh in R1), Playwright E2E, and the Vercel preview.

**Justin-run acceptance (production; he sends and receives)**

28. **R2 (TEST).** After a signed test submission and a real form test, Justin's phone shows the ntfy in under 1 min (webhook) and under 3 min (email fallback). No Chat card appears.
29. **R3 (LIVE).** A `[TEST]` card appears in the team space in under 1 min, and Richard confirms he sees it. Pressing Called removes the lead from the next 09:00 digest.

## (5) Migration (additive only)

New folder `prisma/migrations/2026092612xxxx_speed_to_lead_v1a/`. It replaces #557's never-applied `20260925120000_speed_to_lead`.
- Re-runnable: `IF NOT EXISTS`, and `duplicate_object`-safe `DO` blocks.
- The `-- statement-break` delimiters stand on their own lines, and the marker text never appears in a comment.
- `TIMESTAMP(3)` convention.

```sql
-- enums
CREATE TYPE "LeadIntakeSource" AS ENUM ('WEB','WEB_EMAIL_FALLBACK','VOICE');
CREATE TYPE "LeadIntakeState"  AS ENUM ('PENDING_FALLBACK','PROCESSED');
CREATE TYPE "LeadVerdict"      AS ENUM ('REAL','REVIEW','JUNK');
CREATE TYPE "LeadAlertChannel" AS ENUM ('NTFY','CHAT');
CREATE TYPE "LeadAlertStatus"  AS ENUM ('PENDING','SENDING','DELIVERED','DEAD','SKIPPED');

-- LeadIntakeEvent: as #557 (externalId UNIQUE, submissionId UNIQUE NULL, source, state, dueAt,
--   receivedAt, leadId FK Lead ON DELETE SET NULL, verdict, reasons JSONB, payload JSONB, isTest,
--   createdAt, updatedAt); INDEX (state, dueAt), INDEX (leadId)
-- LeadAlert: id, leadId FK Lead ON DELETE CASCADE, channel, status DEFAULT 'PENDING',
--   attempts INT DEFAULT 0, nextAttemptAt DEFAULT now(), claimedAt, deliveredAt, providerRef,
--   lastErrorCategory, isTest, createdAt, updatedAt; UNIQUE (leadId, channel), INDEX (status, nextAttemptAt)
-- ContactEndpoint: id, endpoint UNIQUE ("email:<addr>" | "phone:<e164>"), junkAt, junkBy,
--   clearedAt, clearedBy, createdAt, updatedAt        -- junk only; v2 may add columns
-- SpeedToLeadEvent (append-only): id, leadId NULL, kind, actor NULL, detail JSONB, createdAt;
--   INDEX (leadId), INDEX (createdAt)

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "bookedAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "calledAt" TIMESTAMP(3);

ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxRefreshTokenEnc" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxEmail" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxHistoryId" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxCutoffAt" TIMESTAMP(3);
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollStartedAt" TIMESTAMP(3);
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollAt" TIMESTAMP(3);
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollOk" BOOLEAN;
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxNextPollAt" TIMESTAMP(3);
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxResyncState" JSONB;

ALTER TABLE "LeadIntakeEvent"  ENABLE ROW LEVEL SECURITY;  -- no policies: deny via PostgREST,
ALTER TABLE "LeadAlert"        ENABLE ROW LEVEL SECURITY;  -- same as ReceiptRequestCard,
ALTER TABLE "ContactEndpoint"  ENABLE ROW LEVEL SECURITY;  -- ClockInRequest (these hold lead PII)
ALTER TABLE "SpeedToLeadEvent" ENABLE ROW LEVEL SECURITY;
```

- **Not created (#557 tables dropped from v1a):** `OutreachMessage`, `OutreachVersion`, `OutreachAttempt`, `OutreachTemplate`, `OutreachDailyCounter`, `ReadinessRecord`, `Outreach*` enums, `Lead.firstTouchAt`, `Lead.personalReplyAt`, and plain-text `leadInboxRefreshToken`.
- **`AutomationSetting` keys** (existing table, no DDL): `speedToLeadPaused`, `speedToLeadDigestLastSentDate`, `leadInboxOAuthState:<nonce>`, `speedToLeadPollAlertSentAt`. The keys `liveActivation` and `firstLiveSendAt` are not used.
- **RLS ordering.** `check-migrations-match.mjs` fails if RLS is enabled on a table that production's `prisma/prisma-blind-spots.json` doesn't list. So R1 is: Justin applies the migration to prod, then runs `snapshot-prisma-blind-spots.mjs` (read-only), then the refreshed snapshot is committed to the PR, then CI goes green. That keeps the deploy checklist's schema-before-code order.

## Rollout and rollback

- **R0 (Justin, open items):**
  - create the ntfy topic;
  - create the Chat incoming webhook in the chosen space;
  - check who can post to the connect@ Group;
  - ship the site change separately (`submissionId`, HMAC signing, `X-GTR-Submission-Id`, honeypot, render time). Until then, website leads come in through the fallback path only, as REVIEW.
- **R1:** migration applied to prod by Justin, snapshot refreshed, CI green, merged with mode unset (OFF). Nothing runs.
- **R2:** Justin connects gtrsupport@ (read-only) and sets `SPEED_TO_LEAD_MODE=TEST` plus the ntfy vars. Then acceptance test 28.
- **R3:** Justin sets `SPEED_TO_LEAD_CHAT_WEBHOOK_URL` and `MODE=LIVE`. Then acceptance test 29.
- **Rollback:** pause for an instant stop, then mode OFF (redeploy). The schema stays; it is additive. v1a sends nothing to customers, so there is no opt-out retention obligation.
- **Cost:** $0 (Gmail API, ntfy.sh, Chat webhook, and the existing Vercel cron).
