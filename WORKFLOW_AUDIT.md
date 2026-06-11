# ProBuild Workflow Audit — Leads, Projects, Comms, Payments

*June 2026. End-to-end audit of how work flows from lead to paid project, what data is shared, where the gaps are, and the recommended operating model for PMs. Companion to VISION.md.*

---

## 1. The lifecycle model (now canonical)

**A lead sits in the pipeline until it becomes a project.** All pre-sale work — contact, follow-up, estimating, negotiation — happens on the Lead. A Project is only born when the job is won, so a project starts at "In Progress" and only moves forward.

```
LEAD PIPELINE                                    PROJECT LIFECYCLE
New → Followed Up → Connected → Estimate Sent ─┬→ Won  ⇒  1. In Progress
                                               └→ Closed Lost   ↓
                                                          2. Substantial Completion
                                                            ↓
                                                          3. Closed Complete   (or 4. Closed Lost)
```

- Project statuses live in `src/lib/project-status.ts` (single source of truth). Lead stages: New, Followed Up, Connected, Estimate Sent, Won, Closed Lost.
- "Won" is set automatically by `convertLeadToProject()`. **Rule of thumb: a lead should never be manually flipped to Won — convert it instead**, so the project, Drive folder, and team access all get provisioned.
- "Substantial Completion" is the PM's money stage: punch list remains, but the final invoice should already be out. The /projects default view shows In Progress + Substantial Completion.

### Current production data (post-cleanup)
| Entity | Status | Count |
|---|---|---|
| Projects | In Progress | 4 (Berg ADU, Mesplay Kitchen, Mueller Remodel, Shop) |
| Projects | Closed Complete | 68 |
| Projects | Closed Lost | 1 (Fisher water damage) |
| Leads | Won | 86 · New 58 · Closed Lost 6 · Estimate Sent 3 |

**Hygiene flags:**
- 86 Won leads vs 73 projects → ~13 leads were manually marked Won without ever converting. Harmless historically, but going forward Won-without-project breaks reporting.
- 58 leads parked at "New". The mid-pipeline stages (Followed Up / Connected) are barely used — either work the stages or let AI auto-stage from activity (an "Estimate Sent" automation already exists in `actions.ts`).

---

## 2. What a lead and its project share

`convertLeadToProject()` (`src/lib/actions.ts:825`) is transactional and carries essentially everything:

| Data | Behavior on conversion |
|---|---|
| Client record | Same `Client` row — shared identity across lead, project, messages, invoices |
| Estimates | Re-pointed to project, **still visible from both** lead and project |
| Contracts | Same — visible from both |
| Room designs, files, folders, schedule tasks, takeoffs | Moved to the project |
| Client messages (SMS/email log) | Moved to the project; the conversation thread is unified by `clientId` anyway |
| Manager, tags, location, type | Copied onto the project |
| Extras | Team access auto-granted; Google Drive client-shared folder provisioned |

Every project is backed by a lead (1-1 invariant) — even "Create Project" secretly creates a lead first. **Nothing is lost at conversion.** The seam is solid; the workflow problems are upstream (leads not staged) and downstream (project money loop), not in the handoff.

---

## 3. The PM operating loop (recommended)

One screen per cadence. Everything below exists in ProBuild today.

**Daily (15 min):**
1. `/projects` — default view = working jobs. Anything in **Substantial Completion** with a balance due is the first stop.
2. Field updates — Daily Logs per project (crew photos, work performed, issues). Today crew posts from mobile/web; AI photo-captioning already assists (`/api/mobile/photo-suggest`).
3. Manager inbox — unmatched inbound SMS lands at `/manager/inbox`.
4. Messages — client threads (`ClientMessage`, unified per client) + sub threads.

**Weekly:**
5. `/reports/global-tracker` — budget vs invoiced vs paid vs balance per project (now filtered by the same 4 statuses).
6. `/manager/variance` — labor cost vs estimate on working jobs.
7. `/leads` — work the New pile; anything quoted should sit at Estimate Sent, not New.

**Per status transition (the checklist that makes statuses mean something):**
- → **In Progress**: estimate approved + deposit milestone paid (Stripe link or recorded manually).
- → **Substantial Completion**: final walkthrough scheduled; **final invoice issued same day** the status flips.
- → **Closed Complete**: balance $0, files/photos archived, review requested.
- → **Closed Lost**: write the reason in a lead note (it's your future pricing data).

This is exactly the loop the AI agent should eventually drive (section 6) — design the human process first, then automate the nudges.

---

## 4. Communications: where should customers live?

### Inventory (all already built)
| Channel | What it does | State |
|---|---|---|
| Client portal | Estimates (approve/sign), invoices (pay via Stripe), schedule, files, daily logs, selections, designs, messages — per-section visibility toggles | Solid, underused |
| ClientMessaging (SMS + email) | One thread per client across lead/project; send as email, SMS, or both; AI-drafted replies; scheduled sends; attachments | Solid |
| Twilio inbound | Replies auto-thread to the right project/lead; unmatched → manager inbox | Solid |
| Email (Resend) | Estimates, invoices, portal invites, payment receipts, message notifications | Solid |
| TeamMessage | Internal per-project team chat | Basic (no notifications) |
| Daily Logs | Field crew updates + photos, client-visible if enabled | Solid |
| Google Chat | **No integration exists** | — |

### Recommendation: ProBuild is the customer system of record. Google Chat stays internal.

Don't put customers in Google Chat spaces:
- The pinning use case (docs, decisions, schedule) **is** the portal — estimates, invoices, files, and schedule are already there, wired to money and signatures. A pinned message in Chat can't be paid or signed.
- Customer comms in Chat are invisible to ProBuild — the AI you want can't act on conversations it can't see, and there's no audit trail tied to the job.
- Customers shouldn't need a Google account or a new app. They already get email + SMS + a portal link.

Internally, keep the per-project Google Chat space — the crew likes it, and it becomes the AI's *input feed* (section 6) rather than a competing system.

### The Twilio opt-in question, straight answer
There is **no compliant way around A2P 10DLC consent** for business-initiated texts — carriers enforce it, not Twilio, and workarounds get numbers filtered/blocked. But the constraint is smaller than it feels:

1. **Inbound-first is fine.** When a customer texts you first, replying conversationally is fine; STOP/HELP handling is already wired.
2. **Capture consent where you already collect signatures.** Add one line + checkbox to the contract/estimate-approval flow ("OK to text me project updates at this number"), store `smsConsent` + timestamp on `Client`. That's the entire fix — after that you can text them freely about the project.
3. **Email has no such barrier** and every portal message already triggers an email notification. For documents and money, portal+email is the better rail anyway; SMS is for "crew arriving 8am".

*Build item:* `smsConsent Boolean @default(false)` + `smsConsentAt` on Client, checkbox in estimate-approval and portal-invite flows, and a guard in the send path when initiating SMS to a non-consented client.

---

## 5. Payments: Stripe limits vs QuickBooks

### What exists
- **Stripe rail (built, working):** portal pay buttons → checkout (card/ACH/Affirm/Klarna) → webhook auto-records the payment milestone, recalculates the invoice, emails a receipt. Optional processing-fee pass-through.
- **Manual rail (built, working — this is the underused key):** `RecordPaymentModal` on any invoice records check / cash / Zelle / Venmo / wire / ACH / other with a reference # and notes, and updates balances exactly like Stripe does.
- **QuickBooks (half-built):** OAuth connect works; one-way **push** of estimates/invoices to QBO (the "QB" button in the invoice list). No payments come back. No customer sync. GL mappings stubbed.

### Payment model (updated Jun 11, 2026 — Stripe blackout)
**Stripe is disabled company-wide for ~180 days** (`CompanySettings.stripeEnabled=false`, enforced at the checkout route). ALL client payments run through **QuickBooks Payments** hosted invoice pages — card, debit, and bank transfer (card fees are merchant-absorbed; Intuit can't surcharge). Checks are recorded via Record Payment / applied in QBO and pulled back automatically. ProBuild stays the source of truth for *what is owed*:

1. Create + send the invoice from ProBuild (it can push to QBO with the same code/number).
2. Take the large payment in QuickBooks (their payment link / ACH).
3. **Same day, record it in ProBuild** with Record Payment → method "ACH"/"Other", reference = QBO payment id. Balance, portal, and reports stay truthful. *Zero new code — this is process discipline available today.*

### Build roadmap to close the loop
- **P1 — QB payment pull-back:** ProBuild already pushes invoices with its own codes as QBO DocNumbers. A small poller (cron, e.g. every 30 min) queries QBO for Payments against those DocNumbers and auto-calls the existing `recordPayment()` path (method "quickbooks", reference = QBO payment id). Intuit webhooks can replace polling later. This makes step 3 above automatic.
- **P2 — customer mapping:** store the QBO Customer id on `Client` at first sync instead of name-matching.
- **P2 — GL mappings UI** (schema field already exists) so QBO invoices land in the right income accounts.

---

## 6. The AI-driven PM layer (the plan, made concrete)

Goal: crew posts photos/updates in the per-project Google Chat space → AI keeps ProBuild moving (statuses, invoices, payments) → PM approves nudges instead of chasing data.

**Phase 1 — Ingest (the bridge).**
A Google Chat app subscribed to each project space forwards messages/photos to `POST /api/integrations/google-chat` (map space ↔ project via a `googleChatSpaceId` field on Project). Each post is stored as a Daily Log entry (photos included) — which also makes it client-visible in the portal when appropriate. Crew behavior doesn't change at all.

**Phase 2 — Understand.**
On ingest, run the existing Gemini wiring over the text+photos to extract: work phase (demo/rough-in/finish), % progress signals, blockers/issues, and material deliveries. Attach to the log entry.

**Phase 3 — Nudge (the payoff).**
A daily agent pass per In-Progress/Substantial-Completion project that cross-references extracted progress against money + schedule and posts actionable nudges (in-app + back into the Chat space):
- "Crew posted rough-in photos at Mesplay → milestone 2 invoice ($3,000) is ready to send. [Send]"
- "Mueller: final invoice has been unpaid 9 days past Substantial Completion. [Send reminder]"
- "Berg ADU: no daily log in 4 days but schedule shows active tasks."
- "Lead 'Thompson bath' quoted 14 days ago, no reply — draft a follow-up?" (AI-drafted via existing message-suggest)

Approve-to-act, never silent auto-send. Phase 1+2 are a webhook route + a prompt; Phase 3 reuses the invoice/message machinery that already exists. (Until Phase 1 lands, the same loop works if crew posts Daily Logs directly — the Chat bridge just meets the crew where they already are.)

---

## 7. Prioritized gap list

| P | Gap | Fix |
|---|---|---|
| ✅ | QB payments invisible in ProBuild | **Built (Jun 10):** signing auto-creates the invoice + QBO milestone invoices w/ hosted pay links; hourly `/api/cron/quickbooks-payments` + on-view refresh pull settled payments (incl. checks Vanessa applies in QBO) into milestones. Needs `QB_CLIENT_ID/SECRET` + Connect in Settings → Integrations. |
| ✅ | Won leads without projects | **Built:** signing an estimate now auto-converts the lead → project → issued invoice (QBO only ever sees projects). |
| ✅ | No profitability answer | **Built:** `/reports/profitability` — collected − burdened labor − expenses − monthly overhead, company → project → transaction drill-down, with data-coverage warnings until all pipes flow. |
| ✅ | Receipts in Drive invisible to ProBuild | **Built:** daily `/api/cron/drive-receipts` scans the intake folder (project-named subfolders), AI-parses images/PDFs → Pending expenses → review in /manager/receipts. Needs one-time Google reconnect to grant the new Drive scope. |
| P1 | Gusto hours not in ProBuild | Import Gusto time → TimeEntry with project + cost code (phase), labor/burden from User rates. CSV import or Gusto API — pending decision on their plan/API access. |
| P1 | No SMS consent capture | `smsConsent` on Client + checkbox at estimate approval / contract |
| P1 | Field updates live in Google Chat, invisible to ProBuild | Chat→Daily Log ingest bridge (`/api/integrations/google-chat`) |
| P1 | Nobody is nudged to invoice at Substantial Completion | Status-transition checklist now; AI nudge agent next |
| P2 | TeamMessage has no notifications | Add notification fan-out, or retire it in favor of the Chat bridge |
| P2 | Retainers are status-only (no payment integration) | Wire to PaymentSchedule like invoices |

---

*Status cleanup, checkbox filters, and sortable columns shipped alongside this audit (commit `5940852`). Data migration was UPDATE-only: 68 projects → Closed Complete, Fisher → Closed Lost, 3 stray lead stages normalized. Nothing deleted.*
