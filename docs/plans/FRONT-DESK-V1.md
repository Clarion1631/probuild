# Front Desk v1 (PB-frontdesk-001): implementation spec

Stacked on Speed-to-Lead v1a (draft PR #558, `feat/PB-leads-001a-alerts`). Written 2026-09-27. **Status: spec only, nothing built. Needs a Codex round before build.**

**Inputs:** plan v3 `golden-touch/marketing-acquisition/ai-front-desk/PLAN.md` (cited as P§n), `TEST-AGENT-QA.md` (QA§n), the v1a spec `docs/plans/SPEED-TO-LEAD-V1A.md` (branch `spec/PB-leads-001-speed-to-lead`), and the v1a code on this branch.

**Hard rules for the build:** never merge or deploy; no prod migration and no prod env var; nothing is sent to a customer by ProBuild; secrets are never typed into chat, a form, a committed file or a CLI flag by the builder (section 7 lists who pastes what); no purchases; never `vercel --token`.

**Test strategy:** Vercel previews sit behind SSO, so ElevenLabs and Twilio can't call them. Everything is proven in CI with unit tests, mocked HTTP, and real-Postgres DB tests (the v1a `migrations` job). The first real traffic is production with `FRONT_DESK_MODE=TEST`, after Justin's steps.

## Verified 2026-09-27 (read-only)

- **ElevenLabs** [E1][E2][E3][E4]:
  - The post-call webhook signs with header `ElevenLabs-Signature: t=<unix seconds>,v0=<hex>`, HMAC-SHA256 over `` `${t}.${rawBody}` ``. The official SDK rejects `t` older than 30 minutes.
  - Event `type` is `post_call_transcription`, `post_call_audio` or `call_initiation_failure`. Only a 200 counts as success. A webhook is auto-disabled after 10 consecutive failures when its last success is more than 7 days old, or it never had one.
  - `data.metadata.phone_call` (Twilio) carries `external_number`, `agent_number` and `call_sid`. `data.analysis` carries `data_collection_results`, `call_successful` and `transcript_summary`.
  - Webhook tools: `request_headers` values may be `{secret_id}`. A body property may set `dynamic_variable` instead of `description`, so the LLM never fills it. `response_timeout_secs` ranges 5 to 300 (default 20). With the default `tool_error_handling_mode: auto`, errors are hidden from the agent for non-native tools.
  - System variables: `system__conversation_id`, `system__agent_id`, `system__caller_id`, `system__call_sid`.
- **Twilio** [T1][T2]:
  - The `<Dial>` action receives `DialCallStatus`, `DialCallSid`, `DialCallDuration` and `DialBridged` ("whether or not the dialing call has been connected to the dialed destination").
  - "Twilio always adds a five-second timeout buffer." `answerOnBridge` requires `<Dial>` to be the first verb. `callerId` may be any Twilio number the account owns.
  - `<Number url>` runs on the called party before connecting. Only `<Play>`, `<Say>`, `<Gather>` and `<Hangup>` are allowed, and no `<Dial>`. If it ends without hanging up, the parties connect.
- **Calendly** [C1][C2]:
  - `POST /invitees` takes `event_type`, `start_time` (UTC), `invitee{name|first_name, email, timezone, text_reminder_number?}`, `location{kind, location}`, `tracking{utm_*}`, `questions_and_answers` and `event_guests`. It returns 201 with `resource.uri`, `event`, `cancel_url` and `reschedule_url`. No idempotency key is documented. 403 on unpaid plans.
  - `GET /event_type_available_times`: start not in the past, end no more than 31 days after start, times in UTC, scope `availability:read`.
- **Repo (this branch):**
  - The `LeadIntakeSource` enum is `WEB | WEB_EMAIL_FALLBACK | VOICE`. `LeadAlert` is `@@unique([leadId, channel])`.
  - `deliverDueAlerts` sends `channel === "NTFY" ? ntfy : chat`, so a new channel **must** get an explicit branch.
  - `scripts/apply-speed-to-lead.mjs` runs the whole migration in one transaction. The `/api/cron/speed-to-lead` cron runs every minute. `src/lib/crypto.ts` provides `encryptObject`/`decryptObject` (AES-256-GCM, key from `NEXTAUTH_SECRET`).
  - ProBuild's Twilio account supplies `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (Production). QA§7 had the TEST number bought in that same account; **UNVERIFIED** until acceptance test P2.

## 0. Shape

```
Caller -> Google (360) 200-1521 -> Twilio front-desk number -> ElevenLabs agent
   agent tools (header X-Front-Desk-Key):
     POST /api/front-desk/tools/availability      -> Calendly available times (Richard's PAT)
     POST /api/front-desk/tools/book              -> Calendly POST /invitees
     POST /api/front-desk/tools/prepare-transfer  -> one live transfer at a time
     transfer_to_number (system tool, conference) -> bridge number
        -> GET/POST /api/front-desk/bridge-twiml -> <Dial> Richard, press-1 screen
   call ends -> POST /api/front-desk/post-call (HMAC) -> v1a intake, source FRONT_DESK_CALL
        -> LeadAlert NTFY + CHAT (v1a path), plus NTFY_URGENT to Richard on a missed transfer
```

**New files:**
- `src/lib/front-desk/{constants,auth,post-call,intake,calendly,booking,transfer,twiml}.ts`
- `src/lib/front-desk-actions.ts` (server actions)
- `src/app/api/front-desk/{post-call,tools/availability,tools/book,tools/prepare-transfer,bridge-twiml}/route.ts`
- `src/app/settings/front-desk/{page.tsx,FrontDeskSettingsPanel.tsx}`
- `prisma/migrations/20260928120000_front_desk_v1/migration.sql` and its twin `scripts/apply-front-desk.mjs`
- `tests/front-desk-*.test.ts`

**v1a touch points (small, listed so review can check them):**
- `intake.ts`: export `findOrCreateClientForContact`, and give `createLeadRow` a `source` parameter (default `"Website"`, so v1a behaviour is unchanged).
- `triage.ts`: new `TriageReason` values `front-desk-booked`, `front-desk-transferred`, `front-desk-missed-transfer`, `front-desk-message`, `front-desk-existing-client`, `front-desk-transfer-pending`, `front-desk-booking-uncertain` and `front-desk-spam`. None is a spam signal.
- `alerts.ts`: a `NTFY_URGENT` branch in `deliverDueAlerts`, with `switch (row.channel)` and an exhaustive `never` default. Front-desk titles and card headers when the reasons carry `front-desk-*`. A new allowed error category, `no urgent ntfy topic configured`.
- `/api/cron/speed-to-lead`: after `deliverDueAlerts`, call `runFrontDeskSweeps(now)` (section 3.4 and 2.3) when `frontDeskMode() !== "OFF"`.
- `proxy.ts`: an exact-match bypass `api\/front-desk\/(?:post-call|tools\/(?:availability|book|prepare-transfer)|bridge-twiml)\/?$`. It is not added to `ANONYMOUS_ACTION_PATTERN`, the same rule as v1a intake.
- `tests/server-action-gates.test.ts`: register `front-desk-actions.ts`.

## 1. `POST /api/front-desk/post-call`

**Order** (every early exit writes nothing):
1. **Mode:** `frontDeskMode() === "OFF"` → 503, before the body is read (the v1a precedent).
2. **Size:** raw body over 2 MB → 413.
3. **Signature** (`auth.ts verifyElevenLabsSignature`):
   - Parse `ElevenLabs-Signature` by splitting on `,`. There must be exactly one `t=` and at least one `v0=`.
   - `t` must be digits. Reject when `now - t > 30 min` (the SDK's rule) or `t - now > 5 min` (ours).
   - Compute `hex(HMAC-SHA256(FRONT_DESK_ELEVENLABS_WEBHOOK_SECRET, t + "." + rawBody))`. Compare it with each `v0` using `timingSafeEqual` on equal-length buffers; a length mismatch is simply unequal, never a throw.
   - An unset secret, or any failure → 401 `{error:"unauthorized"}`.
4. **Parse:** JSON parse, then zod `postCallEnvelopeSchema`. Failure → 400.
5. **Type and agent:**
   - `type !== "post_call_transcription"` → 200 `{ok:true, ignored:"type"}` plus a `SpeedToLeadEvent` `front-desk-webhook-ignored`.
   - `data.agent_id !== FRONT_DESK_AGENT_ID` → 200 `{ignored:"agent"}` plus the same event.
6. **Process:** one interactive transaction (`INTAKE_TX_TIMEOUT_MS`). A retryable transaction error → 503, and ElevenLabs retries.
7. `after(deliverDueAlerts)`, then 200 `{ok:true, duplicate}`.

**Idempotency per `conversation_id`**, inside the transaction:
1. `INSERT INTO "FrontDeskCall" (…conversationId…) ON CONFLICT ("conversationId") DO NOTHING`.
2. `UPDATE "FrontDeskCall" SET "postCallProcessedAt" = now(), … WHERE "conversationId" = $1 AND "postCallProcessedAt" IS NULL`. Zero rows → return `duplicate:true` with no other writes.
3. A concurrent twin blocks on the row lock. After the winner commits, it sees the marker and returns `duplicate:true`. A crash rolls the marker back, so ElevenLabs' retry processes the call again.

**Extraction** (`post-call.ts`; each field `.catch(null)`, so one bad field never fails the webhook):
- **From `data_collection_results[id].value`:** `caller_name`, `callback_number`, `email`, `city`, `project_type`, `project_summary`, `caller_kind` (`new_project | existing_client | vendor_or_sales | spam | other`), `preferred_times`, `message_for_richard` and `language`. These ids are the agent-side contract (section 2.5).
- **Also used:** `analysis.transcript_summary`, `metadata.phone_call.external_number` (the caller ID) and `call_sid`.
- **Phone:** the confirmed `callback_number` normalized to E.164 US (`normalizeCallerPhoneE164`), else the caller ID, else null.
- **Stored in `LeadIntakeEvent.payload`:** only the extracted fields, the summary and the outcome. Never the transcript, which stays in ElevenLabs, whose retention is 90 days per QA§6.

**Outcome.** ProBuild's own rows beat the model's claims. The first match wins:

| # | Condition | Outcome, reasons |
|---|---|---|
| 1 | a `FrontDeskBooking` for the call is `BOOKED` | `BOOKED`, `front-desk-booked` |
| 2 | the transfer is `CONNECTED`, or `DIALING` with `screenAcceptedAt` set | `TRANSFERRED`, `front-desk-transferred` |
| 3 | the transfer is `MISSED` | `MISSED_TRANSFER`, `front-desk-missed-transfer` |
| 4 | the transfer is `PREPARED`, or `DIALING` and not accepted (Richard may still be ringing) | `MESSAGE`, `front-desk-transfer-pending` (section 3.4 adds the urgent alert if it becomes a miss) |
| 5 | `caller_kind` is `spam` or `vendor_or_sales` | `SPAM`, `front-desk-spam` |
| 6 | anything else | `MESSAGE`, `front-desk-message` (plus `front-desk-existing-client` when `caller_kind = existing_client`) |

A booking row still `SUBMITTING` or `UNCERTAIN` adds `front-desk-booking-uncertain`. The card then says "Booking uncertain, don't rebook" (P§4).

**Feeding v1a** (`front-desk/intake.ts upsertFrontDeskLeadInTx(tx, {conversationId, facts, outcome, reasons, isTest, needLead, extraChannels})`). The post-call path and the missed-transfer path (section 3.4) share this:
1. `INSERT INTO "LeadIntakeEvent" (externalId 'fd:'||conversationId, source 'FRONT_DESK_CALL', state 'PROCESSED', …) ON CONFLICT ("externalId") DO NOTHING`.
2. `SELECT … FOR UPDATE` on that row.
3. Merge `facts` into `payload`. A non-null post-call field wins over a transfer-time field.
4. If `leadId` is null and `needLead` is set:
   - `findOrCreateClientForContact({name, email, phone})`;
   - `createLeadRow` with `source: "Front Desk Call"`, `name: "<caller_name or Caller> - <project_type or Front desk call>"`, a message built from the summary, preferred times and message (max 10k), `projectType` and `location = city`;
   - set `leadId`, `verdict: REVIEW` and `reasons`.
5. If the row already had a lead, update `reasons` only, never downgrading. When `Lead.message` still equals the transfer-time placeholder, replace it with the summary (a conditional update).
6. If there is a lead: call `createLeadAlertsInTx` (v1a: NTFY, plus CHAT when `chatCardsEnabled()`), then `extraChannels` (`NTFY_URGENT`), all `ON CONFLICT ("leadId","channel") DO NOTHING`. That produces **one push per channel per call**, however many paths touch it.
7. **SPAM:** `needLead=false`, verdict `JUNK`, no lead and no alert. The row and `FrontDeskCall` stay for recovery, listed on the settings page. A lead that already exists is never downgraded.
8. Set `FrontDeskCall.leadId` and `outcome`. Always a new lead per call (no v1a 7-day repeat-call linking, which would silence a second message). The `Client` is reused by email or phone.

**No customer sends:** this route only writes rows and queues internal alerts.

## 2. Agent server tools

### 2.0 Common rules for all three tool routes
- **Auth:** header `X-Front-Desk-Key`, compared as `timingSafeEqual(sha256(given), sha256(FRONT_DESK_TOOL_SECRET))`. Both sides are always 32 bytes, so there is no length oracle. Unset or wrong → 401 `{status:"unauthorized"}`. This runs before mode, parse or any DB access.
- **Body:** at most 8 KB, parsed with zod `.strict()`. `conversation_id` and `agent_id` are bound to `system__conversation_id` and `system__agent_id` (never LLM-filled). A wrong `agent_id` → 401.
- **Response:** always HTTP 200 with an explicit `status` once authenticated, so the agent never depends on an error it may not see. `FRONT_DESK_MODE=OFF` short-circuits before any DB access: availability → `take_preferred_times`, book → `not_booked:front_desk_off`, prepare → `no_transfer:front_desk_off`.
- **isTest:** `FRONT_DESK_MODE=TEST` makes every row `isTest=true`, and alerts get `[TEST]`.

### 2.1 `POST /api/front-desk/tools/availability`

**Body:** `conversation_id`, `agent_id`, plus optional `preferred_date` (`YYYY-MM-DD`, Pacific) and `part_of_day` (`morning | afternoon | any`).

**Returns one of:**
- **`{status:"take_preferred_times", reason}`:**
  - when `FRONT_DESK_BOOKING` is not `ON`, no token is stored, the event is unset, or the call already has 3 offers (`booking_off | not_configured | offer_limit`);
  - on any Calendly failure (timeout 6 s, 401, 403, 429, 5xx) → `calendly_unavailable`. It never claims a time is open (P§4 fallback).
- **`{status:"no_times"}`** when nothing is free in the window.
- **`{status:"ok", timezone:"America/Los_Angeles", slots:[{slot_id, spoken, date, time}]}`**, with up to 3 slots.

**How it works:**
- **Window:** `start = now + 1 min` to `start + 7 days`, in UTC. The event is the live one in LIVE and the secret test copy in TEST.
- **Filters:** `part_of_day`, where morning is before 12:00 Pacific. `preferred_date` puts that date's slots first.
- **`spoken`:** `Intl.DateTimeFormat("en-US", {timeZone:"America/Los_Angeles", weekday:"long", month:"long", day:"numeric", hour:"numeric", minute:"2-digit"})` plus " Pacific". `date` and `time` (24-hour) are Pacific too, and they are what the read-back guard compares.
- **Slot binding:**
  - `UPDATE "FrontDeskCall" SET "slotSeq" = "slotSeq" + n, "offeredSlots" = "offeredSlots" || $new RETURNING "slotSeq"`, after an insert-if-missing.
  - `slot_id` values are the short strings `"1"`, `"2"`, … and are never reused within a call, so a re-offer can't turn an old id into a new time.
  - Each slot carries its UTC `startTime` and `expiresAt = now + 10 min`.

### 2.2 `POST /api/front-desk/tools/book`

**Body** (the read-back guard; **every field is required**, and a missing or empty one → `not_booked:readback_incomplete`):
- bound: `conversation_id`, `agent_id`, `caller_id` (`system__caller_id`, audit only);
- LLM-filled: `slot_id`, `confirmed_date`, `confirmed_time`, `name`, `email`, `callback_phone`, and `readback_confirmed`, which must be literally `true`.

**Results:**
- `booked` (with `spoken`)
- `uncertain`
- `not_booked:<reason>`, where the reason is one of:
  - setup and mode: `front_desk_off`, `booking_off` (also returns `mode:"take_preferred_times"`), `not_configured`, `test_invitee_not_allowed`;
  - read-back and input: `readback_incomplete`, `readback_mismatch`, `invalid_email`, `invalid_phone`;
  - slot: `slot_unknown`, `slot_expired`, `slot_taken`;
  - duplicates and caps: `already_booked` (with the existing `spoken`), `daily_cap`, `too_many_attempts`;
  - Calendly: `calendly_rejected`, `calendly_auth`, `calendly_plan`, `rate_limited`.

**State machine** (`booking.ts`):
1. **Gates:**
   - `FRONT_DESK_BOOKING=ON`;
   - the token decrypts, and the event URI is set;
   - in TEST, the invitee email's domain must be in `FRONT_DESK_TEST_INVITEE_DOMAINS`, so a test can never make Calendly email a real customer.
2. **Validate:**
   - The email passes zod `.email()`, and the phone becomes E.164 US.
   - `slot_id` is found in this call's `offeredSlots` and hasn't expired.
   - `confirmed_date` and `confirmed_time` must equal the slot's Pacific date and time (`readback_mismatch`). This stops the model booking a time it didn't read back.
3. **Reserve.** One short transaction under `pg_advisory_xact_lock(hashtext('front-desk-booking'))`. Volume is tiny, so serializing every reservation removes the cap, phone and email races outright:
   1. **Replay:** a row with the same `(conversationId, requestHash)` → return its stored result. `requestHash` = sha256 over the canonical `{eventTypeUri, startTime, name, emailLower, phoneE164}`.
   2. **Attempts:** 3 or more rows for this conversation → `too_many_attempts`. Calendly counts failed POSTs against 10 a minute, 50 an hour and 100 a day (P§4).
   3. **One booking per call:** an active row for this conversation (`SUBMITTING | BOOKED | UNCERTAIN`) → `already_booked`.
   4. **Double booking:** an active row with `startTime > now()` for the same `phoneE164` or `emailLower` → `already_booked`.
   5. **Cap:** active rows created today, where today is the Pacific day, reaching `FRONT_DESK_DAILY_BOOKING_CAP` (6) → `daily_cap`.
   6. **Slot:** an active row for the same `(eventTypeUri, startTime)` → `slot_taken`.
   7. **Insert:** `INSERT … status 'SUBMITTING'` and commit. The partial unique indexes (section 5) enforce steps 3 and 6 again at the DB level.
4. **POST** `https://api.calendly.com/invitees`, with an 8 s timeout, outside any transaction:
   - `event_type`, and `start_time` as the slot's UTC ISO;
   - `invitee: {name, email, timezone: "America/Los_Angeles"}`;
   - `location: {kind: "outbound_call", location: phoneE164}`;
   - `tracking: {utm_source: "gtr-front-desk", utm_content: <row id>}`;
   - **never** `text_reminder_number`, `event_guests` or `questions_and_answers` (P§4).
5. **Map the outcome** with a conditional `UPDATE … WHERE id=$1 AND status='SUBMITTING'`:

| Calendly response | Row status | Tool result | Also |
|---|---|---|---|
| 201 | `BOOKED` | `booked` | store `inviteeUri`, `eventUri`, `cancelUrl`, `rescheduleUrl` |
| 400, 404 | `NOT_BOOKED` | `not_booked:calendly_rejected` | the agent offers new times once (P§4) |
| 401 | `NOT_BOOKED` | `not_booked:calendly_auth` | set `frontDeskCalendlyAuthFailedAt` (null→now) and send one plain ntfy to Justin |
| 403 | `NOT_BOOKED` | `not_booked:calendly_plan` | |
| 429 | `NOT_BOOKED` | `not_booked:rate_limited` | no retry during the call |
| timeout, network error, 5xx | `UNCERTAIN` | `uncertain` | |

6. **Concurrent identical request:** it loses the replay check while the winner is `SUBMITTING`. It polls the row every 500 ms for up to 9 s, then returns the stored result, or `uncertain`. **One POST, two identical answers.**

**Pacific time:** storage is UTC. Spoken times, read-back fields, the cap's day boundary and the transfer hours are all `America/Los_Angeles` via `Intl`. DST is covered by tests: 2026-10-30 09:00 PDT is 16:00Z, and 2026-11-02 09:00 PST is 17:00Z.

### 2.3 Booking reconciler (runs in the existing every-minute cron)

**Which rows:** `UNCERTAIN`, plus `SUBMITTING` rows older than 2 minutes, that are younger than 24 hours and not attempted in the last 5 minutes.

**How:**
- `GET /scheduled_events?user=<frontDeskCalendlyUserUri>&min_start_time=<start-1m>&max_start_time=<start+1m>&status=active`.
- For each event, `GET /scheduled_events/{uuid}/invitees`, then match `tracking.utm_content === row.id`.

**Results:**
- **Found** → `BOOKED`, storing the URIs, and a note on the lead: "Booking confirmed by reconciler".
- **Absent 30 minutes after submit** → `NOT_BOOKED:reconciled_absent`.
- **Still uncertain at 24 hours** → set `reconcileStoppedAt` and send a plain ntfy to Justin.

It never re-POSTs and never books a replacement.

### 2.4 Richard's Calendly token: `/settings/front-desk` (admin only)

**Access:** the page and every action in `front-desk-actions.ts` require `assertActiveStaff()` and `role === "ADMIN"` (Justin and Richard; **UNVERIFIED** that Richard is `ADMIN`, see 7-J7).

**Paste and save:**
- A write-only `<input type="password" autocomplete="off">` posts to the server action `saveCalendlyTokenAction(token)`.
- The action trims the token and checks it against `^[A-Za-z0-9._-]{20,4096}$`, then makes three read-only checks with a 6 s timeout:
  1. `GET /users/me`, which must return 200; its `resource.uri` becomes `frontDeskCalendlyUserUri`;
  2. `GET /organizations/{uuid}`, whose `plan` and `stage` are stored for display (P§4);
  3. `GET /event_types?user=<uri>&active=true`, which lists events for the two pickers.
- Only after all three pass does it store `encryptObject({token})` in `CompanySettings.frontDeskCalendlyTokenEnc`, plus `…SetBy` (the session email), `…SetAt`, and clears `…AuthFailedAt`.
- The token is never returned to the client, never logged (only an error category) and never put in env. The audit writes a `SpeedToLeadEvent` `front-desk-calendly-token-set` with no token content.

**Other controls:**
- **Pickers:** the live event and the secret test event, stored as `frontDeskCalendlyEventTypeUri` and `frontDeskCalendlyTestEventTypeUri`. The picker warns when the event's `duration !== 15` or its location kind isn't `outbound_call` (P§4 fixes).
- **Clear token:** nulls the token fields. That is the **instant booking off-switch**, no redeploy: both tools fall back to `take_preferred_times`.
- **Key rotation:** if `NEXTAUTH_SECRET` rotates, decryption fails and the tools behave as `not_configured`. The page shows "re-paste the token".

**Also on the page:**
- the effective mode, the booking flag, `SPEED_TO_LEAD_MODE`, and whether each secret is set (booleans only);
- the "Taking transfers" switch (section 4);
- the urgent ntfy topic, for Richard to subscribe;
- a warning when v1a is paused (P§8: never pause while routing is on);
- the last 20 `FrontDeskCall` rows (outcome, test flag, lead link, spam included), any active transfer, and `UNCERTAIN` bookings.

### 2.5 Agent-side contract

These are ElevenLabs config, applied by the build step through the API with the key in-process. They are listed so both sides test against one definition.

| Tool | Type | Settings |
|---|---|---|
| `open_times` | webhook POST `/tools/availability` | `request_headers: {"X-Front-Desk-Key": {secret_id}}`, `tool_error_handling_mode: passthrough`, `response_timeout_secs: 15` |
| `book_call` | webhook POST `/tools/book` | same, `response_timeout_secs: 20` (above the 8 s POST plus the 9 s replay wait) |
| `prepare_transfer` | webhook POST `/tools/prepare-transfer` | same, `response_timeout_secs: 10` |
| `transfer_to_number` | system | `transfer_type: conference`, destination `phone` = `FRONT_DESK_BRIDGE_NUMBER_E164`, `passthrough`; the prompt calls it only right after `transfer_ready` |

- **Post-call data collection ids:** the ten in section 1. `caller_kind` is enum-typed.
- **Webhook:** the post-call webhook is enabled for this agent only, transcription only, audio off.

## 3. Transfer bridge

### 3.1 `POST /api/front-desk/tools/prepare-transfer` (flagged addition)

The brief's items don't name it, but the bridge can't work without it. A conference transfer carries no custom headers to Twilio (P§3), and the bridge leg's `From` is the front-desk number, not the caller's. So the screen needs a record that holds the caller's name, project and city, and the missed-transfer alert needs the callback number. This tool also carries P§1's `office_status`.

**Body** (all required): `conversation_id`, `agent_id` (bound), `caller_name`, `callback_phone`, `city`, `project`, `spanish` (a boolean), and `readback_confirmed: true`.

**Returns** `transfer_ready` or `no_transfer:<reason>`:

| Reason | When |
|---|---|
| `front_desk_off` | the mode is OFF |
| `richard_unavailable` | the switch is off |
| `outside_hours` | outside `FRONT_DESK_TRANSFER_HOURS` |
| `busy` | another transfer is active |
| `already_transferred` | this call already has a transfer |
| `invalid_phone` / `readback_incomplete` | the read-back guard failed |

**One transaction:**
1. Stale `PREPARED` rows (`preparedAt` older than 60 s) → `EXPIRED`.
2. `INSERT "FrontDeskTransfer" status 'PREPARED'`.
3. A unique violation on `FrontDeskTransfer_one_active_key` → `busy`. One on `conversationId` → `already_transferred`.

`transfer_ready` is only good for 60 seconds.

### 3.2 `GET|POST /api/front-desk/bridge-twiml`

This is the Voice URL of the bridge number. One route handles four steps through `?step=`, so it needs one proxy entry.

**Every request starts with:**
- **Signature check:** `twilio.validateRequest(TWILIO_AUTH_TOKEN, X-Twilio-Signature, url, params)`.
  - `url` = `NEXT_PUBLIC_APP_URL` + pathname + search (the Twilio-signed URL including `?step=…&t=…`). `params` = the form body on POST, `{}` on GET.
  - It fails closed in **every** environment, unlike `/api/twilio/inbound`'s lenient dev mode. A missing token → 503, and Twilio then uses the fallback Bin; a bad signature → 403.
- **Account check:** `AccountSid === TWILIO_ACCOUNT_SID`, else `<Reject/>`.
- All TwiML comes from `twiml.ts`, which XML-escapes every attribute (`&` → `&amp;` in URLs) and all text.

**Step `inbound` (the default; P§3 "Bridge side"):**
1. **Guards** (any failure → `<Response><Reject/></Response>` plus a `SpeedToLeadEvent` `front-desk-bridge-rejected`):
   - `To` = `FRONT_DESK_BRIDGE_NUMBER_E164`;
   - `From` = `FRONT_DESK_NUMBER_E164`;
   - the mode isn't OFF.
2. **Idempotent retry:** a row already has `bridgeCallSid = CallSid` → re-emit the same TwiML.
3. **Claim:** `UPDATE "FrontDeskTransfer" SET status='DIALING', "bridgeCallSid"=$CallSid, "dialStartedAt"=now() WHERE id = (SELECT id … WHERE status='PREPARED' AND "preparedAt" > now() - interval '60 seconds' ORDER BY "preparedAt" LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.
   - Richard's switch is re-read here; off → `EXPIRED` + `<Reject/>`.
   - No row → `<Reject/>` + event `front-desk-bridge-unmatched`.
4. **Emit:**
```xml
<Response>
  <Dial answerOnBridge="true" timeout="15" callerId="{BRIDGE}" method="POST"
        action="{BASE}/api/front-desk/bridge-twiml?step=action&amp;t={id}">
    <Number method="POST" url="{BASE}/api/front-desk/bridge-twiml?step=screen&amp;t={id}">{RICHARD}</Number>
  </Dial>
</Response>
```

**Step `screen`** (runs on Richard's leg):
- The row `t` must be `DIALING`, and `ParentCallSid` (when present) must equal `bridgeCallSid`. Otherwise `<Hangup/>`.
- Caller-supplied text is cut to `[A-Za-z0-9 .,'-]` and 40 characters per field, so the model's strings can't inject TwiML or odd speech.
```xml
<Response>
  <Gather numDigits="1" timeout="6" actionOnEmptyResult="false" method="POST"
          action="{BASE}/api/front-desk/bridge-twiml?step=screen-result&amp;t={id}">
    <Say>{TEST: "Test call. "}Golden Touch front desk: {first name}, {project} in {city}.{" Spanish speaker." if spanish} This call is recorded. Press 1 to take it.</Say>
  </Gather>
  <Hangup/>
</Response>
```
Silence falls through to `<Hangup/>`, because `actionOnEmptyResult` is false. His voicemail answering ends the same way.

**Step `screen-result`:**
- **Exactly `Digits === "1"`,** the row `DIALING`, and `ParentCallSid` matching:
  - `UPDATE … SET "screenAcceptedAt"=now() WHERE id=$t AND status='DIALING' AND "screenAcceptedAt" IS NULL`;
  - return `<Response><Say>Connecting.</Say></Response>`. The document ends without a hangup, so the legs bridge.
- **Anything else** → `<Response><Hangup/></Response>`, which hangs up Richard's leg only.

**Step `action`** (the `<Dial>` result, on the bridge leg):
- **Connected** = `DialBridged === "true"` **and** `screenAcceptedAt` is set. `DialCallStatus` is stored but never decides, because a screen rejection can report `completed` (P§3).
- **The transition:** `UPDATE … SET status = CONNECTED|MISSED, "dialCallStatus", "dialBridged", "dialCallSid", "resolvedAt", reason WHERE id=$t AND "bridgeCallSid"=$CallSid AND status='DIALING'`.
  - If it wins with `MISSED`, section 3.4's alert runs in the same transaction.
  - A duplicate callback gets the same TwiML and no new rows.
- `DialBridged=true` without `screenAcceptedAt` is an anomaly. It's recorded as `MISSED`, reason `bridged-without-screen`, and alerted (the safe side).
- **The response hangs up the bridge leg:**
  - CONNECTED → `<Hangup/>`;
  - MISSED → `<Hangup/>`, or, only when `FRONT_DESK_MISS_LINE=ON` (P§3 test #1 result B), `<Say>Richard couldn't pick up. He has your details and will call you back shortly. You can also book at goldentouchremodeling.com.</Say><Hangup/>`.

### 3.3 Timing

- **Ring:** `timeout="15"` plus Twilio's 5 s buffer is about 20 s of ringing.
- **Screen:** the Say takes about 6 s, plus the 6 s gather.
- **Worst case:** about **32 s** before a miss is known (P§3).

The agent-side ring window has to cover that. Test #1 (P§3) checks whether ElevenLabs waits that long; this spec doesn't depend on the answer.

### 3.4 Missed transfer → urgent alert, and the sweep

**On a winning MISSED transition** (from `action`, or from the sweep), in the same transaction:
- `upsertFrontDeskLeadInTx` with `needLead=true`;
- facts from the transfer row: name, callback phone, city and project, with the placeholder message "Missed transfer, details from the call";
- reasons `front-desk-missed-transfer`, and `extraChannels=[NTFY_URGENT]`.

The lead may already exist, because the post-call can arrive first with `front-desk-transfer-pending`. It's reused, and only the missing alert rows are added, so **exactly one urgent push per missed transfer.** Then `after(deliverDueAlerts)`.

**`NTFY_URGENT` delivery** (a new branch in `alerts.ts`):
- topic `FRONT_DESK_URGENT_NTFY_TOPIC` (Richard's phone), `Priority: 5`;
- Title `Missed transfer - call back now` (ASCII; `[TEST] ` prefix in TEST);
- body: first name · city · project · phone ending NNNN (the v1a privacy rule: no full number on ntfy); `Click`: the lead URL.

The MAIN OFFICE Chat card (v1a CHAT channel, LIVE on production only) leads with "MISSED TRANSFER, call back now" and carries the full phone, as v1a cards do. The v1a pause switch skips these too.

**Sweep** (`runFrontDeskSweeps`, every minute):
- `DIALING`, with no `screenAcceptedAt` and `dialStartedAt` older than 90 s → `MISSED`, reason `no-action-callback`, plus the alert. This covers a caller or ElevenLabs hanging up before Twilio's action arrives (**UNVERIFIED** whether Twilio calls `action` then).
- `DIALING` with `screenAcceptedAt` older than 4 h → `CONNECTED`, reason `no-action-callback`, no alert. A connected call keeps the row `DIALING` until the Dial ends, and that also correctly keeps other transfers `busy`.
- `PREPARED` older than 60 s → `EXPIRED`, no alert. The agent saw the transfer fail, and the post-call alert covers the call.

## 4. Flags and switches

**Environment flags:**

| Flag | Values (default) | Effect |
|---|---|---|
| `FRONT_DESK_MODE` | `OFF`/`TEST`/`LIVE` (OFF) | **OFF:** every front-desk route returns before any DB access; the sweeps don't run. **TEST:** everything runs with `isTest=true`, `[TEST]` alerts, the test event, invitee domain allowlist. **LIVE:** real rows; LIVE off production behaves as TEST (v1a `isProduction` rule). An unknown value reads as OFF. The effective mode is also OFF whenever `SPEED_TO_LEAD_MODE=OFF`, because the front desk feeds v1a. |
| `FRONT_DESK_BOOKING` | `OFF`/`ON` (OFF) | OFF: `take_preferred_times`. ON: the section 2.2 state machine. Only ON after the P§7 booking gate. |
| `FRONT_DESK_MISS_LINE` | `OFF`/`ON` (OFF) | The fixed miss line on the bridge (test #1 result B only). |

**Switches and constants:**

| Switch | Values (default) | Effect |
|---|---|---|
| "Richard taking transfers" | `CompanySettings.frontDeskTakingTransfers` (false) | Admin toggle on `/settings/front-desk`. Records `…By` and `…At`, and writes a `SpeedToLeadEvent`. Off → `no_transfer:richard_unavailable`, and the bridge rejects. This is the no-redeploy transfer off switch, and Richard's holiday control. |
| Clear Calendly token | the settings button | The no-redeploy booking off switch (section 2.4). |
| `FRONT_DESK_TRANSFER_HOURS` | constant Mon–Fri 08:00–17:00 Pacific | **UNVERIFIED:** must mirror Google's configured hours (P§1). |
| `FRONT_DESK_DAILY_BOOKING_CAP` | constant 6 | P§4. |

## 5. Migration (additive only)

`prisma/migrations/20260928120000_front_desk_v1/migration.sql`, re-runnable, with `-- statement-break` lines, and twinned by `scripts/apply-front-desk.mjs`. That script is a copy of `apply-speed-to-lead.mjs`'s guards: target, expect-db, expect-host, pgbouncer, a single transaction, lock and statement timeouts, and a `verifyShape`.

It never drops or renames anything and never alters an existing column. It adds 2 enum values to existing enums, 3 new enums, 3 new tables, 3 partial unique indexes and 11 nullable or defaulted `CompanySettings` columns. RLS is enabled with no policies, as in v1a.

```sql
ALTER TYPE "LeadIntakeSource" ADD VALUE IF NOT EXISTS 'FRONT_DESK_CALL';
ALTER TYPE "LeadAlertChannel" ADD VALUE IF NOT EXISTS 'NTFY_URGENT';
DO $$ BEGIN CREATE TYPE "FrontDeskOutcome" AS ENUM ('BOOKED','TRANSFERRED','MISSED_TRANSFER','MESSAGE','SPAM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "FrontDeskBookingStatus" AS ENUM ('SUBMITTING','BOOKED','NOT_BOOKED','UNCERTAIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "FrontDeskTransferStatus" AS ENUM ('PREPARED','DIALING','CONNECTED','MISSED','EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "FrontDeskCall" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "agentId" TEXT, "isTest" BOOLEAN NOT NULL DEFAULT false,
  "callerPhoneE164" TEXT, "offeredSlots" JSONB NOT NULL DEFAULT '[]', "slotSeq" INTEGER NOT NULL DEFAULT 0,
  "outcome" "FrontDeskOutcome", "postCallProcessedAt" TIMESTAMP(3), "leadId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskCall_conversationId_key" ON "FrontDeskCall"("conversationId");

CREATE TABLE IF NOT EXISTS "FrontDeskBooking" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
  "status" "FrontDeskBookingStatus" NOT NULL, "reason" TEXT, "isTest" BOOLEAN NOT NULL DEFAULT false,
  "eventTypeUri" TEXT NOT NULL, "startTime" TIMESTAMP(3) NOT NULL, "phoneE164" TEXT NOT NULL, "emailLower" TEXT NOT NULL,
  "inviteeUri" TEXT, "eventUri" TEXT, "cancelUrl" TEXT, "rescheduleUrl" TEXT,
  "submittedAt" TIMESTAMP(3), "resolvedAt" TIMESTAMP(3), "lastReconcileAt" TIMESTAMP(3), "reconcileStoppedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskBooking_conversationId_requestHash_key" ON "FrontDeskBooking"("conversationId","requestHash");
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskBooking_one_active_per_call_key" ON "FrontDeskBooking"("conversationId") WHERE "status" IN ('SUBMITTING','BOOKED','UNCERTAIN');
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskBooking_one_active_per_slot_key" ON "FrontDeskBooking"("eventTypeUri","startTime") WHERE "status" IN ('SUBMITTING','BOOKED','UNCERTAIN');
CREATE INDEX IF NOT EXISTS "FrontDeskBooking_phoneE164_idx" ON "FrontDeskBooking"("phoneE164");
CREATE INDEX IF NOT EXISTS "FrontDeskBooking_emailLower_idx" ON "FrontDeskBooking"("emailLower");
CREATE INDEX IF NOT EXISTS "FrontDeskBooking_status_updatedAt_idx" ON "FrontDeskBooking"("status","updatedAt");

CREATE TABLE IF NOT EXISTS "FrontDeskTransfer" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "status" "FrontDeskTransferStatus" NOT NULL,
  "isTest" BOOLEAN NOT NULL DEFAULT false, "callerName" TEXT NOT NULL, "callbackPhoneE164" TEXT NOT NULL,
  "city" TEXT NOT NULL, "project" TEXT NOT NULL, "spanish" BOOLEAN NOT NULL DEFAULT false,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "bridgeCallSid" TEXT, "dialStartedAt" TIMESTAMP(3),
  "screenAcceptedAt" TIMESTAMP(3), "dialCallSid" TEXT, "dialCallStatus" TEXT, "dialBridged" BOOLEAN,
  "resolvedAt" TIMESTAMP(3), "reason" TEXT, "leadId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskTransfer_conversationId_key" ON "FrontDeskTransfer"("conversationId");
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskTransfer_bridgeCallSid_key" ON "FrontDeskTransfer"("bridgeCallSid");
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskTransfer_one_active_key" ON "FrontDeskTransfer"((true)) WHERE "status" IN ('PREPARED','DIALING');
-- FKs (duplicate_object-safe DO blocks): FrontDeskCall.leadId and FrontDeskTransfer.leadId -> Lead(id) ON DELETE SET NULL.

ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskTakingTransfers" BOOLEAN NOT NULL DEFAULT false;
-- plus, each ADD COLUMN IF NOT EXISTS, nullable: frontDeskTakingTransfersBy TEXT, frontDeskTakingTransfersAt TIMESTAMP(3),
-- frontDeskCalendlyTokenEnc TEXT, frontDeskCalendlyTokenSetBy TEXT, frontDeskCalendlyTokenSetAt TIMESTAMP(3),
-- frontDeskCalendlyUserUri TEXT, frontDeskCalendlyPlan TEXT, frontDeskCalendlyEventTypeUri TEXT,
-- frontDeskCalendlyTestEventTypeUri TEXT, frontDeskCalendlyAuthFailedAt TIMESTAMP(3)

ALTER TABLE "FrontDeskCall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FrontDeskBooking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FrontDeskTransfer" ENABLE ROW LEVEL SECURITY;
```

**Notes:**
- **Enum values:** `ADD VALUE` inside a transaction block is allowed on PG 12+, as in CI's `postgres:16` and Supabase. Nothing in this migration uses the two new values; the app uses them only after commit.
- **Prisma schema:** mirrors every table, column and full unique index. The three partial indexes can't be expressed in Prisma. As in v1a, the `check-migrations-match` blind-spots assertion stays red until Justin applies this to prod and re-snapshots `prisma/prisma-blind-spots.json`.

## 6. Acceptance tests

"DB" means real Postgres, via `SPEED_TO_LEAD_TEST_URL` in CI's `migrations` job. Each test cleans up its own rows, using the v1a `cleanup` pattern. HTTP to ElevenLabs, Calendly, ntfy and Chat is mocked with counting fakes, and nothing reaches a real host in CI.

**Signature and auth:**
1. A valid ElevenLabs signature is accepted. A tampered body, wrong secret, missing `t`, missing `v0`, a non-hex `v0`, `t` older than 30 min, `t` more than 5 min in the future, or an unset secret → 401 with zero rows.
2. A tool key is accepted only on an exact match. Wrong, empty, a different length, or an unset env → 401 with zero DB calls (the prisma spy counts 0).
3. The bridge: bad `X-Twilio-Signature`, wrong `AccountSid`, wrong `From`, wrong `To`, or a missing auth token → Reject/403/503 as specified. A signature over the URL including `?step=…&t=…` validates (built with twilio's `getExpectedTwilioSignature`).

**Modes and switches:**

4. `FRONT_DESK_MODE` unset, `off` or `garbage` → OFF. OFF: post-call 503 before the body is read, the tools return their `*_off` statuses, the bridge rejects, and the sweeps don't run, all with zero DB calls.
5. `SPEED_TO_LEAD_MODE=OFF` forces the front desk OFF.
6. `LIVE` off production behaves as TEST.
7. `FRONT_DESK_BOOKING` OFF → availability `take_preferred_times`, book `not_booked:booking_off` + `mode`, and no Calendly call. Clearing the token does the same.
8. TEST mode: an invitee outside `FRONT_DESK_TEST_INVITEE_DOMAINS` → `test_invitee_not_allowed`, with no POST.
9. Transfers switch off → `no_transfer:richard_unavailable`, and a bridge claim after it is flipped off → EXPIRED + Reject.

**Post-call:**

10. A non-transcription type or another `agent_id` → 200 ignored, no lead.
11. Outcome precedence: every row of the section 1 table, including BOOKED beating `caller_kind=spam` and a pending transfer giving `front-desk-transfer-pending`.
12. Spam → verdict JUNK, no Lead, no LeadAlert, and the row is kept.
13. Bad `data_collection_results` fields become null; the lead is still created from the summary and the caller ID.
14. Card and ntfy content: ASCII titles, a `[TEST]` prefix, and "Booking uncertain, don't rebook" when flagged; ntfy never carries more than 4 phone digits.
15. **DB race:** 5 concurrent identical webhooks → exactly one `postCallProcessedAt`, one `LeadIntakeEvent`, one Lead, and one LeadAlert per channel. Four responses say `duplicate:true`.
16. **DB:** replaying after success → duplicate with no writes. A transaction forced to fail after the marker → the next delivery processes it (the marker rolled back).
17. **DB race:** a post-call and a missed-transfer action for the same conversation, concurrently → one Lead, one NTFY, at most one CHAT, and one NTFY_URGENT.

**Availability and booking:**

18. Slots come out in Pacific, `spoken`/`date`/`time` are right across DST (2026-10-30 PDT, 2026-11-02 PST), and there are at most 3. A Calendly failure → `take_preferred_times:calendly_unavailable`, never slots.
19. Slot ids are never reused across re-offers in a call; the 4th offer → `offer_limit`.
20. Read-back guard: each required field missing → `readback_incomplete`; `readback_confirmed:false` → the same; a date or time not matching the slot → `readback_mismatch`; an unknown slot or one older than 10 min → `slot_unknown`/`slot_expired`. None of them POSTs.
21. The POST body has the fixed `location.kind: outbound_call`, `timezone: America/Los_Angeles` and `utm_content = row id`, and no `text_reminder_number`, `event_guests` or `questions_and_answers`.
22. Outcome mapping: 201/400/401/403/404/429/500/timeout map to the section 2.2 table. The 401 sets `AuthFailedAt` and sends one plain ntfy.
23. **DB race:** 2 concurrent identical book requests → **one** Calendly POST, and both answers equal `booked`.
24. **DB race:** two conversations, same slot, concurrently → one POST; the other gets `slot_taken`.
25. **DB race:** two conversations, same phone, different slots → one booked; the other gets `already_booked` with the first's time. The same for the email.
26. **DB:** after `booked`, a second slot in the same call → `already_booked`. After `NOT_BOOKED:calendly_rejected`, a new slot → allowed. The 4th attempt → `too_many_attempts`.
27. **DB race:** 8 concurrent bookings (distinct callers and slots) with the cap at 6 → exactly 6 SUBMITTING-or-better and 2 `daily_cap`. The cap day rolls at Pacific midnight.
28. **DB:** a crash after the POST leaves `SUBMITTING`; the reconciler finds `utm_content` → BOOKED. A timeout after a real booking → UNCERTAIN → BOOKED. Absent for 30 min → NOT_BOOKED. At 24 h → `reconcileStoppedAt` + ntfy. The reconciler never POSTs `/invitees`.

**Transfer bridge:**

29. prepare-transfer: every `no_transfer` reason, with hours checked in Pacific (Friday 16:59 is in, 17:00 is out, Saturday is out).
30. **DB race:** two conversations prepare concurrently → exactly one `transfer_ready`, one `busy`. A stale PREPARED row older than 60 s doesn't block.
31. The inbound TwiML is exact: `<Dial>` first, `answerOnBridge="true"`, `timeout="15"`, `callerId` = the bridge, and `&amp;`-escaped URLs. A retry with the same `CallSid` gives the same TwiML. No prepared transfer → Reject.
32. The screen TwiML: `numDigits="1"`, `timeout="6"`, `actionOnEmptyResult="false"`, a trailing `<Hangup/>`, and sanitized, escaped caller text (an `<`/`&` payload can't break the XML).
33. screen-result: only `Digits="1"` sets `screenAcceptedAt` and returns no Hangup. `"2"`, `"*"`, `""`, `"11"` and a wrong `ParentCallSid` → `<Hangup/>`.
34. action: `DialBridged=true` + accepted → CONNECTED with no alert. **`DialBridged=false` with `DialCallStatus=completed` → MISSED** + NTFY_URGENT. `DialBridged=true` without acceptance → MISSED `bridged-without-screen`. The miss line appears only with `FRONT_DESK_MISS_LINE=ON`.
35. **DB race:** 3 concurrent duplicate action callbacks → one transition and one NTFY_URGENT row.
36. Sweep: an unaccepted DIALING row older than 90 s → MISSED + urgent; an accepted one isn't touched until 4 h; PREPARED older than 60 s → EXPIRED **with an NTFY_URGENT alert** (deliberate deviation from this spec's original "with no alert", made in the round-2 Codex-review fixes on PR #559 — Codex SHIP-BLOCKING finding #2 established that an expired PREPARED row is a caller's last safety net if the post-call webhook never arrives, so it now gets the same alert every other missed transfer gets, from both `handlePrepareTransferTool`'s own inline cleanup and `sweepTransfers`, in `src/lib/front-desk/transfer.ts`).
37. `deliverDueAlerts` sends NTFY_URGENT to the urgent topic at priority 5 (never to Chat), skips it while paused, and a missing topic → DEAD `no urgent ntfy topic configured`.

**Settings, safety, migration:**

38. The settings page and every front-desk action refuse non-ADMIN users. Saving a token runs the three read-only checks first, stores only ciphertext (the DB value never contains the token), and never sends the token to the client or a log (spy on `console.*`).
39. A static no-send proof, `tests/front-desk-no-outbound.test.ts`:
    - It scans `src/lib/front-desk`, `src/app/api/front-desk` and `front-desk-actions.ts`.
    - It forbids `@/lib/sms`, `messages.create`, `calls.create`, Resend, `gmail`, `text_reminder_number`, `event_guests` and `/scheduled_events/.*/cancellation`.
    - The only outbound hosts allowed are `api.calendly.com` and the existing v1a alert senders.
40. The migration applies twice cleanly on CI Postgres. `apply-front-desk.mjs` `verifyShape` passes. `(true)` partial-index uniqueness is proven by test 30. The Prisma schema matches (blind spots excepted as noted).
41. The proxy test: the 5 exact paths bypass, while `/api/front-desk/other`, `/api/front-desk/tools` and Server Action dispatch through them do not.

**Production TEST-mode checks** (after Justin's steps; run by Claude and Richard, never Justin; P§7):
- **P1.** A signed test webhook, sent from Claude's side with the secret read in-process, creates one `[TEST]` lead, one ntfy and no card (unless `SPEED_TO_LEAD_MODE=LIVE`).
- **P2.** A test call through the TEST number: prepare → bridge → Richard presses 1 → CONNECTED. This confirms the bridge sees `From` = the front-desk number and `AccountSid` = ProBuild's, both **UNVERIFIED** until then.
- **P3.** Richard ignores, declines, answers without pressing, or presses 2 → MISSED plus one urgent push each time, and P§3's test #1 matrix is recorded.
- **P4.** With booking ON in TEST, a booking on the secret test event, then cancelled through `cancel_url` by Richard.

## 7. Paste and click steps

The builder does none of these. Values marked secret never go in chat, email or a repo.

**Justin:**
- **J1. Approve and buy the bridge number** (the second number, about $1.15 a month, needs his OK). In the Twilio Console for ProBuild's account: US Local 360, friendly name "GTR Front Desk Bridge". Don't import it into ElevenLabs.
- **J2. Bridge voice URL.** In the number's settings, "A call comes in" → Webhook, `https://probuild.goldentouchremodeling.com/api/front-desk/bridge-twiml`, HTTP POST. "Primary handler fails" → a new TwiML Bin, "GTR bridge reject", with `<Response><Reject/></Response>` (P§8).
- **J3. The migration, before merge** (schema before code, per the deploy-probuild skill): `node scripts/apply-front-desk.mjs --target prod --yes --expect-db postgres --expect-host <pooler host>`. Then re-run `scripts/snapshot-prisma-blind-spots.mjs` and commit the snapshot.
- **J4. Merge** the PR after Codex and CI, with v1a (#558) merged first. All flags default OFF, so the merge changes nothing at runtime.
- **J5. Tool secret (secret).** Generate one in his own terminal (`openssl rand -hex 32`). Paste it into Vercel Production env `FRONT_DESK_TOOL_SECRET`, and into ElevenLabs → Workspace → Secrets as `gtr_front_desk_tool_key`. The build step references that secret's id in the tools' `X-Front-Desk-Key` header.
- **J6. Post-call webhook secret (secret).** ElevenLabs → Settings → Webhooks → create an HMAC webhook to `https://probuild.goldentouchremodeling.com/api/front-desk/post-call`, then copy the secret it shows once into Vercel Production `FRONT_DESK_ELEVENLABS_WEBHOOK_SECRET`. Then, on the GTR agent: post-call webhook = that webhook, transcription only, audio off. **Do this only after J8's redeploy,** so the webhook never meets OFF 503s (the auto-disable rule).
- **J7. Richard's role.** Check in ProBuild → Team that Richard is `ADMIN`, so he can reach the settings page.
- **J8. Vercel Production env, non-secret values, then redeploy:**
  - `FRONT_DESK_MODE=TEST`, `FRONT_DESK_BOOKING=OFF`, `FRONT_DESK_MISS_LINE=OFF`;
  - `FRONT_DESK_AGENT_ID=agent_4201m3g2nw7bfrfvgfdkp40f09pp` (the TEST agent);
  - `FRONT_DESK_NUMBER_E164=+13608032397`, `FRONT_DESK_BRIDGE_NUMBER_E164=<J1 number>`, `FRONT_DESK_RICHARD_E164=+13602071549`;
  - `FRONT_DESK_TEST_INVITEE_DOMAINS=goldentouchremodeling.com`;
  - `FRONT_DESK_URGENT_NTFY_TOPIC=<a new unguessable topic name>`, which is secret-like, so he types it himself.
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `SPEED_TO_LEAD_MODE` already exist. v1a must be at least TEST.
- **J9. Later, each its own decision:**
  - `FRONT_DESK_BOOKING=ON` after the booking gate;
  - `FRONT_DESK_MODE=LIVE` with the live agent id at Stage A;
  - `FRONT_DESK_MISS_LINE` per test #1.

**Richard:**
- **R1. Calendly token (secret).**
  - Create it at calendly.com → Integrations → API & Webhooks → Personal access tokens, with scopes `event_types:read`, `availability:read`, `scheduled_events:write`, `users:read` and `organizations:read` (P§4).
  - Paste it himself into ProBuild → Settings → Front Desk → Calendly token → **Verify & save**.
  - Check that the page shows `stage: paid` on Standard or higher. If not, he tells Justin, because an upgrade is a cost decision.
- **R2. Pick events:** the live event and the secret test copy, after P§4's event fixes (15 minutes, "I will call my invitee", no required questions, Pacific profile timezone).
- **R3. Phone setup:**
  - Install ntfy and subscribe to the urgent topic shown on the settings page.
  - Save the bridge number as the contact "GTR Front Desk".
  - Check Google Voice screening and Do Not Disturb (P§9).
- **R4. Taking transfers:** turn it **ON** on the settings page when he's ready for the P2/P3 test transfers, and use it day to day after that.

## Open items (UNVERIFIED, each with its check)

- **Twilio behaviour:**
  - Which Twilio account holds +13608032397, and the bridge-leg `From`: P2.
  - Whether Twilio requests `action` after the parent hangs up mid-dial: the sweep covers either answer; P3.
  - Whether `ParentCallSid` is present on `<Number url>` requests: optional in the check, and the signed `t` is authoritative.
- **Transfer hours:** the constant vs Google's hours (P§1). Justin confirms, or the builder reads Google's settings read-only.
- **ElevenLabs ring window:** whether it waits about 32 s on the bridge. That is test #1 (P§3), outside this spec.

## Sources

- E1. ElevenLabs post-call webhooks: https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
- E2. ElevenLabs JS SDK signature verification: https://github.com/elevenlabs/elevenlabs-js/blob/main/src/wrapper/webhooks.ts
- E3. ElevenLabs OpenAPI (`WebhookToolConfig`, `WebhookToolApiSchemaConfig`, `LiteralJsonSchemaProperty`, `ConvAISecretLocator`, `ConversationHistoryTwilioPhoneCallModel`, `ToolErrorHandlingMode`): https://api.elevenlabs.io/openapi.json
- E4. ElevenLabs dynamic variables: https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables
- T1. Twilio `<Dial>`: https://www.twilio.com/docs/voice/twiml/dial
- T2. Twilio `<Number>`: https://www.twilio.com/docs/voice/twiml/number
- C1. Calendly Create Event Invitee: https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee
- C2. Calendly Event Type Available Times: https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-type-available-times
