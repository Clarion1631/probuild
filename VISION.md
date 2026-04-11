# ProBuild Vision — AI-First Remodeling Platform

_Last updated: 2026-04-03_

## The Thesis

Every construction management app (Houzz Pro, Buildertrend, CoConstruct, Jobber) is a **database with forms**. They store data and let you manually enter it. ProBuild is different: **AI does the heavy lifting at every step.** The human confirms, adjusts, and decides — but never starts from a blank page.

The remodeling industry runs on:
- Gut instinct instead of data
- Spreadsheets that nobody updates
- Phone calls instead of systems
- Margins that evaporate because nobody catches overruns until it's too late
- Client relationships that depend on the PM remembering to call

ProBuild fixes all of that by making AI the default co-pilot for every action a remodeler takes.

---

## Who Uses ProBuild (Every Role Has a Purpose)

### The Estimator (Richard)
Creates estimates from plans and client conversations. Needs accurate pricing from historical data, markup suggestions, and missing item detection. His estimate becomes the foundation — it flows into the schedule, budget, and invoices. AI helps him build a 95% complete estimate in minutes instead of days.

### The Project Manager
Runs the jobs. Sees all active projects, their schedule status, budget health, and crew assignments. Needs to know instantly: "Am I making money on this job?" Manages change orders, approves time, and communicates with clients. AI surfaces problems before they become crises.

### The Field Crew
Out on the job site. Needs a phone-first experience: clock in/out, take photos for daily logs, mark tasks complete, scan receipts for expenses, track materials. AI auto-generates the daily log from their photos and voice. They shouldn't have to type anything. Eventually: scan inventory barcodes, log material usage, and report issues with photos.

### The Bookkeeper
Tracks every dollar. Needs expenses coded to the right job, the right phase, the right cost category. Manages sales tax tracking, vendor payments, sub invoices vs POs, and payroll burden rates. Sees committed costs (POs issued but not yet paid), actual costs (paid), and forecasted costs. The books must be clean for tax time.

### The Owner
Sees the whole business. Dashboard shows: total revenue, profit margin by project, cash flow forecast, labor utilization, lead pipeline. Knows which project types are most profitable, which subs are reliable, which estimators are accurate. AI generates the monthly business summary automatically.

### The Client
Gets a portal they've never seen from a contractor before. Real-time progress with photos/videos from daily logs. Approval workflows for estimates, change orders, and selections. A mood board and selection board to make design decisions. Weekly AI-generated progress emails with curated photos. They feel informed, involved, and valued — and they tell their friends.

### The Subcontractor
Sees only their assigned tasks. Knows their schedule, can confirm or flag conflicts. Submits bids through bid packages. Uploads invoices matched to POs. Keeps COI current. A professional experience that makes them want to work with you.

---

## The Money Flow (How Profitability is Tracked)

```
Estimate (Richard creates)
  → Budget (auto-created from estimate)
    → Schedule (AI-generated from estimate, tasks linked to line items)
      → Time Entries (crew clocks in, auto-costed with hourly + burden rate)
      → Expenses (receipts scanned, coded to job/phase/category)
      → Purchase Orders (committed cost — tracked before payment)
      → Sub Invoices (matched to PO, tracked as committed → actual)
        → Job Costing Dashboard (real-time: budget vs committed vs actual)
          → Profitability = Revenue (invoiced/paid) - Total Cost (labor + material + sub + overhead)
```

**Key concept: Committed Cost.** When a PO is issued, that money is committed even if not yet paid. The dashboard shows:
- **Budget** — what we estimated
- **Committed** — POs issued + scheduled labor
- **Actual** — money spent
- **Forecasted** — AI-predicted final cost at completion
- **Variance** — the gap, with AI explaining why

When a **payment comes in**, it updates:
- Invoice status → Paid
- Cash flow → positive
- Project profitability → live margin calculation
- Dashboard → visual indicator of cash position

---

## Future: Mobile App + Inventory

### Mobile App (Phase 2)
A native/PWA companion app for the field:
- **Daily logs** — camera-first. Take video, AI transcribes and structures the log.
- **Time clock** — GPS-verified clock in/out
- **Expense capture** — photograph receipt, AI extracts vendor, amount, category, and codes it to the active project
- **Task updates** — swipe to mark complete, add photo as proof
- **Material tracking** — scan barcode → log material usage against the job
- **Offline mode** — works without signal, syncs when back online

### Inventory System (Phase 3)
- **Warehouse tracking** — scan items in/out of inventory
- **Job allocation** — "2 boxes of tile moved from warehouse to Kitchen Remodel project"
- **Auto-reorder** — "Inventory of 2x4 studs below threshold. Create PO for 200 units from Home Depot?"
- **Cost tracking** — materials from inventory costed at average purchase price, charged to job
- **Waste tracking** — log waste/returns, feeds future estimate accuracy

---

## AI Gap Analysis — What We Can Build That Nobody Else Has

| Capability | Status | Impact |
|-----------|--------|--------|
| AI estimate from photos/plans | Partially built | Saves 4+ hours per estimate |
| AI schedule from estimate | Built | Saves 2+ hours per project |
| AI daily log from photos/voice | Needs voice + video | Saves 15 min/day per crew member |
| Predictive cost at completion | Not built | Catches overruns weeks early |
| AI change order detection | Not built | Prevents $1k+ in absorbed scope creep per project |
| Historical pricing engine | Not built | Makes estimates 30% more accurate |
| Lead scoring | Not built | Focuses sales effort on high-probability leads |
| Client auto-updates | Not built | Eliminates "how's it going?" calls |
| Weather-aware scheduling | Not built | Prevents 2-3 weather delays per project |
| Safety detection from photos | Not built | Liability reduction |
| Inventory barcode scanning | Not built | Phase 3 |
| Receipt OCR to expense | Not built | Saves 5 min per expense entry |
| Sub performance scoring | Not built | Better sub selection over time |
| AI monthly business summary | Not built | Owner insight without spreadsheets |

---

## The Data Flywheel

Every completed project makes ProBuild smarter:
- **Estimates** → pricing accuracy improves
- **Time entries** → duration predictions improve
- **Expenses** → material cost predictions improve
- **Lead outcomes** → scoring model improves
- **Change orders** → scope detection improves
- **Payment history** → collection timing predictions improve
- **Sub performance** → recommendation engine improves

After 10 projects: useful. After 50: powerful. After 200: unfair advantage.

This is the moat. Competitors can copy features. They can't copy your data.

---

## Page-by-Page Vision

### Dashboard (`/`)
**Goal:** The owner opens this at 6 AM with coffee and knows exactly where the business stands.

- **AI Daily Briefing** — auto-generated summary: "3 projects active, Kitchen Remodel is 2 days behind schedule, $14k in outstanding invoices aging past 30 days, 2 leads need follow-up today"
- **Profitability heatmap** — all active projects, color-coded by margin health (green = on budget, yellow = watch, red = bleeding)
- **Cash flow forecast** — AI projects next 30/60/90 days based on invoices, payment history, and scheduled work
- **Action items** — not a to-do list you maintain, but AI-surfaced: "Approve change order for Patio project", "Send invoice for milestone 3 (work completed 2 days ago)", "COI expires for Sparks Electric in 5 days"
- **Weather impact alerts** — "Rain forecasted Thu-Fri, Exterior Paint crew may need rescheduling"

### Leads (`/leads`)
**Goal:** Never lose a lead. Know which ones to chase and which to drop.

- **AI Lead Scoring** — every lead gets a 0-100 score: project size, response time, budget signals from messages, location match, season fit. Ranked by close probability.
- **Smart follow-up prompts** — "This lead hasn't been contacted in 4 days. Similar leads that went cold after 5 days had 12% close rate vs 67% if contacted within 3 days."
- **Auto-draft responses** — AI reads the inquiry, drafts a personalized response referencing similar past projects, suggests meeting times
- **Pipeline analytics** — conversion rates by source (Houzz, website, referral), average deal size, time-to-close by project type
- **Lead-to-project conversion** — one click: AI pre-populates project, creates estimate skeleton from similar past projects, suggests crew

### Estimates (`/projects/[id]/estimates`)
**Goal:** Generate accurate estimates in minutes, not days. Never forget a line item.

- **AI Estimate from Plans** — upload a floor plan or photo. AI extracts scope, generates line items with quantities, suggests pricing from your historical data
- **Historical pricing engine** — "Your average cost for demolition in a kitchen remodel is $2,400. This estimate has $1,800 — 25% below your norm. Intentional?"
- **Markup optimization** — AI suggests markup percentages by category based on market rates and your win rate: "Increasing tile markup from 20% to 28% wouldn't have lost you any of your last 15 kitchen bids"
- **Missing item detection** — "This kitchen estimate doesn't include permit fees, dumpster rental, or final clean. Your last 8 kitchen projects all had these."
- **Template learning** — every completed estimate trains the system. After 20 kitchens, AI generates 90% of the estimate automatically

### Schedule (`/projects/[id]/schedule`)
**Goal:** The Gantt chart builds itself. Delays are caught before they happen.

- **AI Schedule Generation** — from estimate line items, AI creates tasks with realistic durations based on your historical data, proper dependencies, and trade sequencing
- **Critical path auto-calculation** — always visible, automatically highlighted. "If framing slips 2 days, final completion moves from March 15 to March 19"
- **Resource conflict detection** — "Mike is scheduled on 2 projects March 3-7. Move tile install on Patio project to March 10?"
- **Weather-aware scheduling** — exterior tasks auto-flag when rain is forecasted. AI suggests rearrangement: "Move interior drywall to Thursday, push siding to next Monday when it's clear"
- **Progress tracking from daily logs** — when a crew member logs "Framing complete" in their daily log, the schedule task auto-updates to 100%
- **Subcontractor visibility** — subs see only their assigned tasks in their portal. Can update status and add comments. PM sees everything.
- **Client view** — clean, simplified timeline the client can check anytime. No costs visible. "Your kitchen is 62% complete — tile installation starts Monday"

### Daily Logs (`/projects/[id]/dailylogs`)
**Goal:** 30-second daily log from the field. AI does the rest.

- **Photo-first logging** — crew takes 3-5 photos. Gemini Vision analyzes them: "Drywall installation in progress, approximately 60% of living room walls complete. 3 crew members visible. Weather: clear."
- **Voice-to-log** — speak into phone: "Finished demo today, hauled 2 dumpsters, plumber coming tomorrow for rough-in." AI structures it into proper log format with work performed, materials used, and tomorrow's plan
- **Auto-link to schedule** — AI matches log descriptions to schedule tasks and updates progress automatically
- **Safety flagging** — AI spots safety issues in photos: "No hard hats visible in photo 3. Elevated work area without fall protection in photo 5."
- **Client digest** — weekly auto-generated email to client with curated photos and progress summary. Professional, branded, zero effort from PM.

### Invoices (`/projects/[id]/invoices`)
**Goal:** Get paid faster. Never forget to bill.

- **AI Invoice Timing** — "Milestone 2 work was completed 3 days ago. Recommended: send invoice now. Your average collection time is 14 days — delaying costs you $420 in cash flow."
- **Auto-generated from milestones** — when a schedule milestone hits 100%, AI drafts the invoice with the correct amount from the payment schedule
- **Payment prediction** — "Based on this client's history, expect payment in 8-12 days. This client has paid on time 100% of the time."
- **Aging alerts** — auto-escalation: Day 7 = friendly reminder, Day 14 = follow-up, Day 30 = phone call prompt, Day 45 = lien notice draft
- **Cash flow integration** — every invoice status change updates the dashboard cash flow forecast in real-time

### Job Costing (`/projects/[id]/costing`)
**Goal:** Know if you're making money on every project, every day.

- **Real-time budget vs actual** — not a report you run monthly, a live dashboard. Updated with every time entry, expense, and PO.
- **AI Variance Analysis** — "Labor on framing is 18% over budget. Root cause: 2 extra days due to rotted subfloor discovery. Recommendation: create change order for $2,400 additional work."
- **Predictive cost at completion** — "At current burn rate, this project will finish at $48,200 against a $45,000 budget. Projected margin: 8% (target was 15%)."
- **Cost code benchmarking** — "Your demolition costs average $12/sqft. Industry average is $8-10/sqft. Review crew efficiency or sub pricing."
- **Profit leakage alerts** — "3 time entries this week have no cost code assigned. $840 in labor is unallocated — assign to preserve job cost accuracy."

### Change Orders (`/projects/[id]/change-orders`)
**Goal:** Never eat the cost of scope changes.

- **AI Change Order Detection** — from daily logs and messages: "Crew logged 'client asked to move outlet location' — this is likely a change order. Draft one?"
- **Auto-pricing** — AI pulls material costs from your catalog and labor rates from time history: "Moving 3 outlets: estimated 4 hours labor ($280) + materials ($45) + markup (25%) = $406"
- **Client-friendly presentation** — portal shows change order with before/after, clear pricing, and one-click approval
- **Margin protection** — "This project has had $4,200 in change orders but only $2,800 approved. $1,400 in scope creep is being absorbed."

### Contracts (`/projects/[id]/contracts`)
**Goal:** Bulletproof contracts in one click.

- **AI Contract Drafting** — from estimate + project details, AI generates a complete contract with scope, payment terms, timeline, and standard clauses
- **Clause library** — AI suggests clauses based on project type: "Kitchen projects should include appliance delivery liability clause and asbestos discovery clause"
- **E-signature** — already built, client signs in portal
- **Recurring lien releases** — auto-generated on schedule, sent to client for signature

### Client Portal (`/portal/projects/[id]`)
**Goal:** Clients feel informed without calling. Referrals increase because they've never experienced this.

- **Real-time project dashboard** — progress %, upcoming work, recent photos, schedule timeline
- **Selection boards** — client picks finishes, tiles, fixtures. AI suggests options based on budget and style preferences
- **Mood boards** — AI-generated design concepts from project type and client preferences
- **Message thread** — in-app communication with read receipts. No more lost text chains.
- **Document hub** — all contracts, invoices, change orders, floor plans in one place
- **AI Progress Updates** — auto-generated weekly email: "Week 3 update: Framing is complete, electrical rough-in starts Monday. 2 photos attached. Project is on schedule."
- **Selection reminders** — "You haven't selected your kitchen backsplash tile yet. This selection is needed by March 10 to stay on schedule."

### Subcontractor Portal (`/sub-portal`)
**Goal:** Subs show up prepared. Communication is zero-friction.

- **Assigned tasks only** — sub logs in, sees only their work: dates, scope, specs
- **Bid packages** — receive, review, and respond to bids digitally. No more phone-tag.
- **Document sharing** — plans, specs, and scope docs for their trade only
- **Schedule updates** — sub gets notified when their start date changes. Can confirm or flag conflicts.
- **Invoice submission** — sub submits invoice through portal, auto-matched to PO
- **COI tracking** — auto-reminder when insurance is expiring. Upload new cert in portal.
- **Performance scoring** — (internal, not visible to sub) AI tracks: on-time %, quality callbacks, responsiveness, pricing competitiveness

### Reports (`/reports`)
**Goal:** The reports the owner actually needs, auto-generated.

- **Profitability by project** — all projects ranked by margin. Drill into any one.
- **Revenue forecast** — next 90 days based on active estimates, signed contracts, and payment schedules
- **Labor utilization** — who's busy, who's available, who's consistently over-allocated
- **Cost code analysis** — which cost codes are consistently over/under budget across all projects
- **Client aging** — who owes what, how long, collection probability
- **Subcontractor scorecard** — ranked by performance metrics
- **AI Monthly Summary** — auto-generated narrative: "March summary: 4 projects active, revenue $142k, profit margin 22% (target 20%), 3 new leads, 1 project completed on time and $800 under budget."

### Bid Packages (`/projects/[id]/bid-packages`)
**Goal:** Get competitive sub pricing without 47 phone calls.

- **AI Scope of Work** — from estimate line items, AI generates professional scope documents per trade
- **Bulk invite** — select subs by trade, send bid packages. Track opens, responses, and amounts.
- **Bid comparison** — side-by-side matrix: price, timeline, past performance score, COI status
- **Auto-award** — AI recommends: "ABC Plumbing bid $4,200 (15% below average), 95% on-time score, COI current. Recommend award."
- **Historical pricing** — "Last 5 plumbing rough-ins ranged $3,800-$5,200. This bid is in the 40th percentile."

### Templates (`/templates`)
**Goal:** Do it right once, repeat forever.

- **Schedule templates** — "Kitchen Remodel 14-day" template creates a full schedule with one click. Dates auto-offset from project start.
- **Estimate templates** — learned from your best estimates. AI pre-populates quantities based on project sqft.
- **Contract templates** — per project type with appropriate clauses
- **Selection board templates** — pre-built selection categories by project type

---

## Houzz Pro Competitive Intelligence (Captured Live April 3-4, 2026)

_Full capture data: `output/LIVE_CAPTURE_NOTES.md`_

### Their Core Financial Pipeline (Must Match)
```
Estimate (hierarchical sections > items, Material/Labor/Service types)
  → Payment Schedule (milestones: Description, Due Date, Amount, Status)
    → Budget (Revised Est = Original + COs, Actual = Expenses + Time + POs)
      → Variance (per-line-item when expenses/time linked to estimate items)
        → Financial Overview (Cash Flow, Incoming/Outgoing, gauge chart, timeline)
```

### Key Patterns We Must Replicate
1. **Selection-based actions** — checking estimate line items scopes "Create Invoice/CO/PO" to selected items only (partial billing)
2. **Company-wide document numbering** — ES-10085, IN-10046, CO-10006, PO-10012, RR-10003, EX-100001 (auto-increment, not per-project)
3. **Estimate-to-Budget linking** — expenses and time entries linked to estimate line items create per-line variance tracking
4. **Per-entry QuickBooks sync** — checkbox on each expense entry, filter by sync status
5. **Processing Fee Markup** — hidden from client view, visible internally only
6. **Activity Stream** — every document has a timestamped log of views, sends, edits, approvals, payments

### Where We Already Win
| Area | Houzz Pro | ProBuild |
|------|-----------|----------|
| AI Estimate from plans | ✅ Basic | ✅ Better (Gemini Vision) |
| AI Schedule from estimate | ✅ | ✅ Already built |
| AI Daily Log | ❌ Manual only | ✅ Photo + voice analysis |
| Predictive cost at completion | ❌ | 🔜 Planned |
| AI Change Order detection | ❌ | 🔜 Planned |
| Lead scoring | ❌ | 🔜 Planned |
| Weather-aware scheduling | ❌ | 🔜 Planned |
| Historical pricing engine | ❌ | 🔜 Planned |

### Where They Beat Us (Gap to Close)
| Area | Houzz Pro | ProBuild |
|------|-----------|----------|
| Budget module with variance | ✅ Full | ❌ Not built |
| Financial Overview dashboard | ✅ Full | ❌ Not built |
| Receipt OCR (AutoMate) | ✅ | ❌ Not built |
| Payment schedule on estimates | ✅ | ❌ Not built |
| Hierarchical estimate items | ✅ Sections > Items | ❌ Flat list |
| Selection-based partial billing | ✅ | ❌ Not built |
| Document numbering system | ✅ Company-wide | ❌ Using CUIDs |
| Takeoff measurement canvas | ✅ Full PDF editor | ❌ Not built |
| 3D Floor Plans | ✅ | ❌ Not built |

---

## What Makes This Different

| Traditional App | ProBuild |
|----------------|----------|
| You create the estimate | AI generates it from plans/photos, you review |
| You build the schedule | AI builds it from the estimate, you adjust |
| You write the daily log | Crew takes photos, AI writes the log |
| You notice you're over budget | AI alerts you before it happens |
| You remember to invoice | AI tells you when and drafts it |
| You chase leads manually | AI scores them and drafts follow-ups |
| You hope the sub shows up | Sub sees their schedule, confirms, and communicates in portal |
| Client calls asking "how's it going?" | Client checks their portal anytime |

---

## Technical Requirements for the Vision

### AI Infrastructure (already partially built)
- **Gemini Flash/Pro** — fast, cheap: daily log analysis, photo analysis, estimate generation, schedule building
- **Claude** — complex reasoning: contract drafting, variance analysis, lead scoring, cost forecasting
- **Embeddings** — for template learning: embed past estimates to find similar projects for new ones
- **Vision models** — Gemini Vision for photo analysis (daily logs, plan takeoffs, safety)

### NPM Packages to Add
- `@anthropic-ai/sdk` — Claude API for complex AI features (already using for some)
- `@google/generative-ai` — Gemini API (already installed)
- `ai` (Vercel AI SDK) — streaming AI responses in the UI
- `react-pdf` or `@react-pdf/renderer` — PDF generation for invoices, contracts, reports
- `recharts` — already installed, underutilized
- `openweathermap-api` or similar — weather data for schedule intelligence
- `date-fns` — date manipulation for schedule calculations

### External Integrations

**Gusto (Payroll) — Export Only**
- Simple CSV/API export: employee name (team member), hours, date
- One "Export to Gusto" button on time clock page → generates the pay period export
- Map ProBuild team members to Gusto employee IDs (one-time setup in settings)
- ProBuild tracks hourly + burden rate for job costing; Gusto handles actual payroll

**QuickBooks (Accounting) — Two-Way Sync**
ProBuild manages job-level operations. QuickBooks manages the books. They share data via manual sync + future auto-sync.

Architecture:
```
ProBuild                          QuickBooks
─────────                         ──────────
Cost Codes/Phases  ←── map to ──→  GL Accounts (Chart of Accounts)
Expenses           ──── push ───→  Bills / Expenses (coded to job + GL)
Invoices           ──── push ───→  AR Invoices
Sub Payments       ──── push ───→  AP Bills
Estimates          ──── push ───→  Estimates (manual sync button)
Payments received  ←── pull ────  Payment receipts
```

- **GL Account Mapping** — settings page: map each ProBuild cost code to a QB GL account. One-time setup. This is how ProBuild operations flow into the books correctly.
- **Manual "Sync to QuickBooks" button** on expenses, invoices, and estimates. Bookkeeper reviews before pushing. No auto-sync initially — too risky for accounting data.
- **Estimates sync** — push approved estimates to QB as estimates. When invoiced, create QB invoice linked to the estimate.
- AI: flag when ProBuild job costs don't match QB GL entries (reconciliation assistant)

**Overhead:** Let QuickBooks manage overhead (rent, insurance, office). ProBuild only tracks job costs (labor, materials, subs, POs). Clean separation — no duplication.

**Email Receipt Capture (AI-Powered)**
The real-world flow: Lowe's sends a receipt email. Amazon has order confirmations. Field crew buys something at Ace Hardware and takes a photo. AI handles all three:

1. **Email forwarding** — receipts@probuild... (or similar inbound address)
   - Lowe's emailed receipts → AI reads HTML/PDF, extracts line items, total, tax, store location
   - Amazon order confirmations → AI reads order details, maps to PO/job number if present
2. **Photo capture** — crew takes photo of receipt in app
   - Gemini Vision extracts vendor, amount, date, items, tax
3. **AI auto-coding** — for all receipt sources:
   - Matches to active project using: PO/job number on receipt, vendor history, recent PO matching, active project context
   - Codes to cost code/phase/category
   - Confidence score: high = auto-approve, low = bookkeeper review queue
4. **Bookkeeper approval** — review queue shows AI-coded expenses, one-click approve → syncs to QB
5. **Future: mobile app** — gas receipts, hardware store, field expenses captured instantly

**Houzz Pro Data Migration**
- Large CSV export from Houzz available — clients, projects, estimates, invoices, time entries
- Migration script: `scripts/import-houzz-csv.ts` — maps Houzz columns to ProBuild schema
- Seeds the AI pricing engine and duration predictions from day one
- Priority: after core Sessions 3-7 complete and schema is stable

### Data Strategy
Every user action trains the system:
- Completed estimates feed the pricing engine
- Time entries feed duration predictions
- Payment history feed collection predictions
- Lead outcomes feed the scoring model
- Change orders feed scope detection
- Receipt patterns feed auto-coding accuracy

After 6-12 months of data, ProBuild knows YOUR business better than you do.
