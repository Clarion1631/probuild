# ProBuild — Todo & Improvement List
_Last updated: 2026-04-03_

---

## 🔴 Critical (Fix Now)

- [x] **Hardcoded "Justin Account"** on dashboard — replaced with session user name (2026-04-03)
- [ ] **Financial Float → Decimal** — all money fields in Prisma schema use Float, causing precision errors. Migrate to Decimal
- [ ] **Mock email/SMS** — `src/lib/email.ts` and `src/lib/sms.ts` are still mock implementations. Wire real Resend + Twilio
- [ ] **Remove console.logs** — 8+ production console.logs across actions.ts, email.ts, sms.ts, stripe webhook, API routes
- [x] **Project Overview uses local DB ID** — fixed: /overview route redirects to /projects/[id] (2026-04-03)
- [x] **Dead buttons** — audited and wired across Sidebar, Company, Leads, Estimates, Reports, Projects, Change Orders (2026-04-03)

---

## 🏗️ Schedule Page — Full Rebuild (High Priority Feature)

**Goal:** Professional, usable, AI-powered Gantt chart that contractors and clients actually use daily.

### Core requirements
- [ ] **Full Gantt chart** — drag-to-resize tasks, drag-to-move, dependency arrows between tasks, today line, zoom levels (week/month/quarter)
- [ ] **AI schedule generation from estimate** — button to "Build Schedule from Estimate": sends estimate line items to AI, returns suggested tasks with durations, dependencies, and assigned trades. User reviews and confirms before saving.
- [ ] **Task assignment** — each task assignable to a team member, subcontractor, or trade. Shows avatar/name on Gantt bar.
- [ ] **Estimate item linking** — tasks can be linked to an estimate line item (cost code/type). Budget vs actual hours visible on hover.
- [ ] **Status tracking** — tasks have status: Not Started / In Progress / Complete / Blocked. Color-coded on Gantt.
- [ ] **Client dashboard toggle** — schedule visible in client portal as a read-only view. Client can see task status and dates but not internal costs. Toggle per-project in settings.
- [ ] **Mobile-friendly** — scroll/pinch on Gantt, tap to view task detail.
- [ ] **Milestone markers** — special milestone task type shown as diamond on Gantt.
- [ ] **Critical path highlight** — visually show which tasks are blocking the end date.

### Technical notes
- Use a Gantt library (recommend `@dhx/trial-gantt` or build with `react-grid-layout` + SVG for dependency lines)
- AI generation: POST estimate items to `/api/ai/schedule` → Gemini Flash → return structured task list
- Client portal toggle: add `scheduleVisibleToClient: Boolean` to Project schema
- Keep tasks in existing Task model but add `ganttOrder`, `startDate`, `endDate`, `dependsOnTaskId`, `estimateItemId` fields
- Gantt should be the default view on `/projects/[id]/schedule`

---

## 🟠 High Priority

- [ ] **Consolidate CostCode/CostType** — dual system in schema. Schema comment says "use CostType going forward" — migrate and remove CostCode references
- [ ] **Error boundaries** — add to all page layouts, currently no centralized error handling
- [ ] **Form validation with Zod** — installed but underutilized. Add server-side validation with proper error propagation
- [ ] **Job Costing UI** — `/projects/[id]/costing/` delegates to JobCostingClient but implementation unclear — verify and complete
- [ ] **Reports page** — add export (PDF/Excel) functionality
- [ ] **Stripe webhook** — unhandled event types being silently dropped. Add proper handling or logging
- [x] **Customize Dashboard button** — implemented with localStorage widget toggle (2026-04-03)
- [x] **Add To-Do on dashboard** — wired to /manager/schedule (2026-04-03)

---

## 🟡 Medium Priority

### URL structure — friendly numeric IDs (like Houzz)
- Add `number Int @unique @default(autoincrement())` to Project, Lead, Estimate, Invoice, Contract, ChangeOrder, PurchaseOrder
- Migrate existing records (they'll get sequential numbers assigned)
- Update all `[id]` route segments to `[number]` and look up by number instead of CUID
- Result: `/projects/1042/overview` instead of `/projects/cmn7tlgiv0001.../overview`
- **Do as a dedicated session** — touches routes, actions, and links across the whole app
- Safe to do now — no external URLs to break yet

### Pages to complete
- [x] **Settings page** — fixed, now 72/100 (2026-04-03)
- [x] **Company page** — fixed, now 75/100 (2026-04-03)
- [x] **Daily Logs** — route mapped in compare.py, now 72/100 (2026-04-03)
- [x] **Project Overview** — /overview redirect added, now 72/100 (2026-04-03)
- [ ] **Leads List** — missing tabbed views and columns vs Houzz Pro (72/100)
- [ ] **Invoices** — significant layout/color/hierarchy gaps vs Houzz Pro (45/100)
- [ ] **Schedule** — fundamentally different layout; needs full Gantt rebuild (35/100)

### UI Components missing
- [ ] Button loading/disabled states
- [ ] Reusable empty state component
- [ ] Reusable data table/pagination component
- [ ] Error boundary component
- [ ] Breadcrumb navigation

### Data visualization
- [ ] Budget vs actual charts (Recharts installed but underutilized)
- [ ] Cost variance charts
- [ ] Revenue trend charts
- [ ] Project profitability visualization

---

## 🤖 AI Features — Infrastructure Already Ready (Gemini + Anthropic configured)

### Already built (verify they're wired in UI)
- [x] AI Estimate Generation — `/api/ai-estimate/route.ts`
- [x] AI Schedule Building — `/api/ai-schedule/route.ts`
- [x] AI Daily Log Enhancement — `/api/ai/daily-logs/route.ts`
- [x] AI Mood Board Generation — `/api/ai/mood-board/route.ts`
- [x] AI Lead Note Summary — `/api/leads/[id]/notes/ai/route.ts`
- [x] Takeoff-to-Estimate Conversion — `/api/takeoffs/ai-estimate/route.ts`

### High impact — build next
- [ ] **Lead Scoring** — "AI Score Lead" button on `/leads/[id]` → analyze messages, notes, meetings, stage → return close probability %, quality rating, recommended next actions → endpoint: `/api/leads/[id]/score`
- [ ] **Cost Forecast** — "AI Cost Forecast" card on `/projects/[id]/costing` → compare estimate vs actuals (time entries + expenses + POs) → predict final cost, flag overruns → endpoint: `/api/projects/[id]/cost-forecast`
- [ ] **Contract Drafting from Estimate** — "AI Draft Contract" button on contracts page → auto-generate contract with merge fields from estimate + project + client data → endpoint: `/api/contracts/ai-draft`
- [ ] **Schedule Risk Analysis** — "AI Risk Analysis" button on schedule page → analyze tasks, crew, dependencies → flag critical path gaps, recommend buffers → endpoint: `/api/projects/[id]/schedule-risk` (pair with Gantt rebuild)
- [ ] **Takeoff Refinement** — "AI Refine Items" in takeoffs → deeper plan analysis, detect missing items, suggest markup adjustments → endpoint: `/api/takeoffs/ai-refine`

### Medium impact
- [ ] **Daily Log Photo Analysis** — "AI Photo Analysis" after photo upload in daily logs → Gemini Vision extracts work progress, flags issues, auto-populates workPerformed field → endpoint: `/api/ai/daily-logs/photo-analysis`
- [ ] **Invoice Optimization** — "AI Invoice Plan" button → suggest milestone split, due dates, payment terms based on project scope → endpoint: `/api/invoices/ai-optimize`
- [ ] **Variance Analysis Narrative** — "AI Variance Report" on job costing → human-readable explanation of why costs vary (delays, scope creep, material waste) → endpoint: `/api/projects/[id]/variance-analysis`
- [ ] **Subcontractor Recommendations** — "AI Suggest Subs" on project → rank subs by past performance, availability, specialty match, cost → endpoint: `/api/projects/[id]/recommend-subs`
- [ ] **COI Extraction** — "AI Extract COI" in files/subcontractors → parse uploaded insurance PDFs → extract carrier, coverage limits, expiration, flag upcoming expirations → endpoint: `/api/documents/ai-extract-coi`

---

## 🟢 Nice to Have

- [ ] **Estimate templates** — UI for template-based estimation (AI functions exist, UI incomplete)
- [ ] **Recurring invoices** — automation for recurring billing
- [ ] **Team capacity planning** — resource allocation view
- [ ] **Custom report builder** — filter/group/export
- [ ] **Report scheduling** — automated report delivery
- [ ] **Client portal analytics** — client-side project progress view
- [ ] **Audit trail** — track changes to estimates, contracts, invoices (who changed what, when)
- [ ] **TypeScript cleanup** — extensive `any` usage, needs proper types on API responses
- [ ] **Skill/certification tracking** for team members
- [ ] **Multi-factor authentication**

---

## 📊 QA Scores

### April 3, 2026 (after session 2 fixes)

| Page | Score | Change | Notes |
|------|-------|--------|-------|
| Company | 75 | +60 | Was 404 |
| Projects List | 72 | +7 | |
| Project Overview | 72 | +37 | Was 404 (showing list) |
| Leads List | 72 | +27 | |
| Estimates | 72 | +17 | |
| Time & Expenses | 72 | +72 | Was server exception |
| Reports Overview | 62 | +27 | |
| Settings | 72 | +67 | Was 404 |
| Daily Logs | 72 | +32 | Was route not mapped |
| Invoices | 45 | -20 | Layout/hierarchy gaps |
| Schedule | 35 | -10 | Needs full Gantt rebuild |
| **Overall** | **~67/100** | **+25** | |

### April 2, 2026 (baseline)

| Page | Score | Root Cause |
|------|-------|------------|
| Projects List | 65 | Missing summary cards, wrong columns |
| Invoices | 65 | Nav structure, filter UI |
| Estimates | 55 | Missing right-hand summary panel |
| Schedule | 45 | Missing onboarding wizard |
| Leads List | 45 | Missing tabbed views, columns |
| Daily Logs | 40 | Route not mapped |
| Reports | 35 | Wrong view, sidebar |
| Project Overview | 35 | Showing list instead of detail |
| Company | 15 | 404 |
| Settings | 5 | 404 |
| Time & Expenses | 0 | Server exception |
| **Overall** | **42/100** | |

---

## ✅ Completed

- [x] Time & Expenses — fixed budgetBucket → costCode + costType (2026-04-02)
- [x] compare.py --local flag added for instant local feedback loop
- [x] SENTRY_AUTH_TOKEN + SENTRY_ORG added to Vercel
- [x] config.py gitignored
