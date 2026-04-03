# ProBuild — Houzz Pro Parity Build Plan
_Last updated: 2026-04-02_

---

## 🗺️ Active Build Plan (Session Roadmap)

Current score: **~67/100** across 11 tracked pages. Execute sessions in order below.

> **Schema migration note:** `npx prisma db push` hangs interactively in WSL.
> Use the PowerShell Supabase Management API script instead:
> `powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"`
> Then: `./node_modules/.bin/prisma generate` (via git bash)

### Verification loop (after every session)
```
npm run build                          # must pass 0 errors
git push origin main                   # triggers Vercel deploy
gh api repos/Clarion1631/probuild/commits/HEAD/statuses   # wait for green
python compare.py --force              # updated production scores
python compare.py --local --page "Page Name"   # in-session feedback
```

---

### Session 1 — Settings, Client Portal, Reports Layout (+20 avg)
Items: T1-2, T1-6, Visual Polish: reports/layout, dead sidebar quick-fixes

- [ ] **T1-2** `/projects/[id]/client-portal` — server component, import existing `PortalVisibilityToggles.tsx`; fix sidebar href `client-dashboard` → `client-portal`
- [ ] **T1-6** Settings sidebar expansion — add nav items + 3 new pages:
  - [ ] `src/app/settings/notifications/page.tsx`
  - [ ] `src/app/settings/payment-methods/page.tsx`
  - [ ] `src/app/settings/integrations/page.tsx`
  - [ ] `src/app/settings/layout.tsx` — rename "Your Houzz Pro Account" → "Company Info"; add Business + Team sections
- [ ] **Reports layout** — `src/app/reports/layout.tsx` with secondary sidebar nav (fixes Reports 62→75+)
- [ ] **Dead link quick-fixes** (2 lines each):
  - [ ] ProjectInnerSidebar: "Selections Tracker" → redirect to `/selections`
  - [ ] ProjectInnerSidebar: "Budget" → redirect to `/financial-overview`

compare.py: Add "Client Portal Config" entry

---

### Session 2 — Project Tasks, Lead Notes, Company Sidebar (+8 avg, fixes 5 dead links)
Items: T1-1, T1-3, dead company/sidebar links

- [ ] **T1-1** `/projects/[id]/tasks` — server component + `TasksClient.tsx` (two tabs: Tasks grouped by status, Punchlist per task); reuse `getScheduleTasks()`, `togglePunchItem()`, `addTaskPunchItem()`
- [ ] **T1-3** `/leads/[id]/notes` — server component; reuse `getLeadNotes()`, `createLeadNote()`; update LeadSidebar "Notes" from modal → href
- [ ] Fix `company/layout.tsx` dead hrefs:
  - [ ] "My Items" → `/company/my-items` (create stub page for now)
  - [ ] "Catalogs" → `/company/catalogs` (create stub page for now)

compare.py: Add "Project Tasks" entry

---

### Session 3 — Report Sub-pages + Global Tracker (+12, adds 4 tracked pages)
Items: T1-4, T1-5, T2-1

- [ ] **T1-4** `src/app/reports/open-invoices/page.tsx` — invoices where status in [Issued, Overdue]; aging buckets (0–30, 31–60, 61–90, 90+)
- [ ] **T1-5a** `src/app/reports/payments/page.tsx` — PaymentSchedule where status=Paid; group by project/month
- [ ] **T1-5b** `src/app/reports/time-billing/page.tsx` — TimeEntry groupBy employee|project via searchParam
- [ ] **T2-1** `src/app/reports/global-tracker/page.tsx` — all projects: budget, invoiced/paid, schedule %, last activity

compare.py: Add Open Invoices, Payments, Time Billing, Global Tracker entries

---

### Session 4 — Visual Polish on Existing Pages (+10 avg)
Items: Projects list stat cards, Invoice polish, Project overview activity feed

- [ ] **Projects list** — add 4 stat cards (Total, In Progress, Completed, Revenue); audit table columns
- [ ] **Invoice polish** — 4 stat cards (Total Invoiced, Collected, Outstanding, Overdue); status tabs with count badges; fix column order to match Houzz Pro
- [ ] **Project overview** — "Quick Actions" grid + Recent Activity feed (merge DailyLog + ChangeOrder + Invoice events)
- [ ] **Daily logs** — weather icon picker; photo thumbnails in list

---

### Session 5 — Lead Schedule, My Items, Settings Completion (adds 4 pages)
Items: T2-2, T2-3, T2-4, T2-5, T2-6

Schema changes needed (apply via PS1 script):
```sql
-- T2-2: make ScheduleTask.projectId nullable, add leadId
ALTER TABLE "ScheduleTask" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "leadId" TEXT;

-- T2-3: CatalogItem model
CREATE TABLE IF NOT EXISTS "CatalogItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL, "description" TEXT, "unitCost" FLOAT NOT NULL,
  "unit" TEXT, "costCodeId" TEXT, "isActive" BOOLEAN DEFAULT true,
  "imageUrl" TEXT, "createdAt" TIMESTAMPTZ DEFAULT now()
);

-- T2-5: CompanySettings work calendar
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "workDays" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "workdayStart" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "workdayEnd" TEXT;

-- T2-6: sales taxes
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "salesTaxes" TEXT;
```

- [ ] **T2-2** `/leads/[id]/schedule` — task list view for lead-scoped tasks; fix LeadSidebar "Schedule" href
- [ ] **T2-3** `/company/my-items` — CRUD table + inline add/edit; `/company/catalogs` — vendor list + PDF upload
- [ ] **T2-4** `/settings/contacts` — Client CRUD table; name, email, phone, project count; add to settings/layout.tsx
- [ ] **T2-5** `/settings/calendar` — 7-day checkbox grid + start/end time inputs
- [ ] **T2-6** `/settings/sales-taxes` — CRUD table of tax rates with default toggle

---

### Session 6 — Templates Hub + Schedule Gantt Final Polish
Items: T2-7, T3-2

Schema changes:
```sql
ALTER TABLE "SelectionBoard" ADD COLUMN IF NOT EXISTS "isTemplate" BOOLEAN DEFAULT false;
ALTER TABLE "MoodBoard" ADD COLUMN IF NOT EXISTS "isTemplate" BOOLEAN DEFAULT false;
CREATE TABLE IF NOT EXISTS "ScheduleTemplate" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "createdAt" TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS "ScheduleTemplateTask" ("id" TEXT NOT NULL PRIMARY KEY, "templateId" TEXT NOT NULL, "name" TEXT NOT NULL, "durationDays" INT NOT NULL, "order" INT DEFAULT 0, "dependsOn" TEXT);
```

- [ ] **T2-7** Templates hub:
  - [ ] `src/app/templates/page.tsx` — card grid linking to sub-pages
  - [ ] `src/app/templates/schedules/page.tsx` — list + "Apply to Project"
  - [ ] `src/app/templates/selections/page.tsx`
  - [ ] `src/app/templates/mood-boards/page.tsx`
- [ ] **T3-2** Schedule Gantt final polish (most already done — verify and fill gaps):
  - [ ] Milestone task type — diamond shape on Gantt bar
  - [ ] Critical path highlighting — shade non-critical tasks
  - [ ] Client portal read-only view toggle (add `scheduleVisibleToClient Boolean` to Project)

---

### Session 7 — Bid Packages (New Feature)
Items: T3-1

Schema changes:
```sql
CREATE TABLE IF NOT EXISTS "BidPackage" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT, "dueDate" TIMESTAMPTZ, "status" TEXT DEFAULT 'Draft', "totalBudget" FLOAT, "createdAt" TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS "BidScope" ("id" TEXT NOT NULL PRIMARY KEY, "packageId" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT, "budgetAmount" FLOAT, "order" INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS "BidInvitation" ("id" TEXT NOT NULL PRIMARY KEY, "packageId" TEXT NOT NULL, "subcontractorId" TEXT, "email" TEXT NOT NULL, "status" TEXT DEFAULT 'Invited', "bidAmount" FLOAT, "sentAt" TIMESTAMPTZ);
```

- [ ] `src/app/projects/[id]/bid-packages/page.tsx` — list with status, # invitations, due date
- [ ] `src/app/projects/[id]/bid-packages/[bidId]/edit/page.tsx` — 3-section editor: details, scope, invite subs
- [ ] New actions: `createBidPackage`, `updateBidPackage`, `addBidScope`, `inviteSubToBid`, `recordBidResponse`, `awardBid`
- [ ] Fix ProjectInnerSidebar "Bids" href → `/projects/${projectId}/bid-packages`

compare.py: Add "Bid Packages" entry

---

## 🗂️ Critical Files Reference
- `src/components/ProjectInnerSidebar.tsx` — every new project sub-route must be registered here
- `src/app/settings/layout.tsx` — settings sidebar needs expansion
- `src/app/company/layout.tsx` — company sidebar has wrong hrefs
- `src/lib/actions.ts` — all new server actions (no new split files per CLAUDE.md)
- `prisma/schema.prisma` — all schema changes
- `compare.py` — add URL_MAP entry for every new page built

---

## 🔴 Critical (Fix Now)

- [ ] **Financial Float → Decimal** — all money fields use Float, causing precision errors. Migrate to Decimal
- [ ] **Mock email/SMS** — `src/lib/email.ts` and `src/lib/sms.ts` are mock. Wire real Resend + Twilio
- [ ] **Remove console.logs** — 8+ production console.logs across actions.ts, email.ts, sms.ts, stripe webhook
- [x] **Hardcoded "Justin Account"** — replaced with session user name (2026-04-03)
- [x] **Project Overview 404** — /overview redirect added (2026-04-03)
- [x] **Dead buttons** — audited and wired across app (2026-04-03)

---

## 🟠 High Priority (Non-Parity)

- [ ] **Consolidate CostCode/CostType** — schema comment says use CostType going forward; remove CostCode refs
- [ ] **Error boundaries** — add to all page layouts
- [ ] **Form validation with Zod** — installed but underutilized; add server-side validation
- [ ] **Job Costing UI** — verify `/projects/[id]/costing/` implementation is complete
- [ ] **Stripe webhook** — unhandled event types silently dropped; add handling/logging
- [x] **Customize Dashboard button** — implemented (2026-04-03)
- [x] **Add To-Do on dashboard** — wired to /manager/schedule (2026-04-03)

---

## 🤖 AI Features (Infrastructure Ready — Gemini + Anthropic configured)

### Already built
- [x] AI Estimate Generation — `/api/ai-estimate/route.ts`
- [x] AI Schedule Building — `aiGenerateSchedule()` in actions.ts, wired to Gantt UI
- [x] AI Punchlist Generation — `aiGeneratePunchlist()` in actions.ts, wired to task detail panel
- [x] AI Daily Log Enhancement — `/api/ai/daily-logs/route.ts`
- [x] AI Mood Board Generation — `/api/ai/mood-board/route.ts`
- [x] AI Lead Note Summary — `/api/leads/[id]/notes/ai/route.ts`
- [x] Takeoff-to-Estimate Conversion — `/api/takeoffs/ai-estimate/route.ts`

### High impact — build next
- [ ] **Lead Scoring** — "AI Score Lead" button on `/leads/[id]` → close probability %, quality rating, next actions
- [ ] **Cost Forecast** — "AI Cost Forecast" on `/projects/[id]/costing` → predict final cost, flag overruns
- [ ] **Contract Drafting from Estimate** — "AI Draft Contract" → auto-generate with merge fields
- [ ] **Schedule Risk Analysis** — "AI Risk Analysis" on schedule → flag critical path gaps, recommend buffers
- [ ] **Takeoff Refinement** — "AI Refine Items" → detect missing items, suggest markup adjustments

### Medium impact
- [ ] **Daily Log Photo Analysis** — Gemini Vision extracts progress from photos, flags issues
- [ ] **Invoice Optimization** — suggest milestone split, due dates, payment terms
- [ ] **Variance Analysis Narrative** — human-readable cost variance explanation
- [ ] **Subcontractor Recommendations** — rank subs by past performance, availability, specialty
- [ ] **COI Extraction** — parse insurance PDFs, extract coverage, flag expirations

---

## 🟡 Medium Priority

### Friendly numeric IDs (like Houzz — dedicated session)
- Add `number Int @unique @default(autoincrement())` to Project, Lead, Estimate, Invoice, Contract, ChangeOrder, PurchaseOrder
- Update all `[id]` route segments to `[number]`, look up by number instead of CUID
- Result: `/projects/1042/overview` instead of `/projects/cmn7tlgiv0001.../overview`
- **Safe now — no external URLs to break yet**

### Pages still below par
- [ ] **Leads List** — missing tabbed views and columns vs Houzz Pro (72/100)
- [ ] **Invoices** — significant layout/color/hierarchy gaps (45/100) ← Session 4

### UI Components missing
- [ ] Button loading/disabled states
- [ ] Reusable empty state component
- [ ] Reusable data table/pagination component
- [ ] Breadcrumb navigation

### Data visualization
- [ ] Budget vs actual charts (Recharts installed but underutilized)
- [ ] Revenue trend charts
- [ ] Project profitability visualization

---

## 📊 QA Scores

### April 3, 2026 (after session 2 fixes)

| Page | Score | Change | Notes |
|------|-------|--------|-------|
| Company | 75 | +60 | Was 404 |
| Projects List | 72 | +7 | |
| Project Overview | 72 | +37 | Was 404 |
| Leads List | 72 | +27 | |
| Estimates | 72 | +17 | |
| Time & Expenses | 72 | +72 | Was server exception |
| Reports Overview | 62 | +27 | |
| Settings | 72 | +67 | Was 404 |
| Daily Logs | 72 | +32 | Was route not mapped |
| Invoices | 45 | -20 | Layout/hierarchy gaps |
| Schedule | 35 | -10 | Gantt rebuilt — needs rescore |
| **Overall** | **~67/100** | **+25** | |

### April 2, 2026 (baseline)

| Page | Score | Root Cause |
|------|-------|------------|
| Projects List | 65 | Missing summary cards, wrong columns |
| Invoices | 65 | Nav structure, filter UI |
| Estimates | 55 | Missing right-hand summary panel |
| Schedule | 45 | Missing Gantt |
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

- [x] Schedule Gantt rebuilt — drag/resize, dependency arrows, AI generation, punch list, comments, team assignment, subcontractor assignment (2026-04-02)
- [x] ScheduleTask schema — added `type`, `estimateItemId` columns via Supabase Management API (2026-04-02)
- [x] Prisma client regenerated (2026-04-02)
- [x] compare.py --local flag added for instant local feedback loop
- [x] Time & Expenses — fixed budgetBucket → costCode + costType (2026-04-02)
- [x] SENTRY_AUTH_TOKEN + SENTRY_ORG added to Vercel
- [x] config.py gitignored
- [x] Hardcoded "Justin Account" → session user name (2026-04-03)
- [x] Dead buttons audited and wired across Sidebar, Company, Leads, Estimates, Reports, Projects, Change Orders (2026-04-03)
- [x] Project Overview /overview redirect added (2026-04-03)
- [x] Customize Dashboard with localStorage widget toggle (2026-04-03)
