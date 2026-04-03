# ProBuild — Build Plan
_Last updated: 2026-04-03_

---

## 🗺️ Build Plan — Phase 1 Complete

All 7 parity sessions completed. Build passes clean. All routes deployed to production.

> **Schema migration note:** `npx prisma db push` hangs interactively in WSL.
> Use the PowerShell Supabase Management API script instead:
> `powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"`
> Then: `./node_modules/.bin/prisma generate` (via git bash)

### Verification loop
```
npm run build              # must pass 0 errors
git push origin main       # triggers Vercel deploy
# click through affected pages on prod to verify
```

---

### ~~Session 1 — Settings, Client Portal, Reports Layout~~ ✅ DONE
Completed 2026-04-03

### ~~Session 2 — Project Tasks, Lead Notes, Company Sidebar~~ ✅ DONE
Completed 2026-04-03

### ~~Gantt Polish (unplanned)~~ ✅ DONE
Completed 2026-04-03

### ~~Session 3 — Report Sub-pages + Global Tracker~~ ✅ DONE
Completed 2026-04-03: open-invoices, payments, time-billing, global-tracker

### ~~Session 4 — Visual Polish~~ ✅ DONE
Completed 2026-04-03: stat cards on projects list, activity feed on project overview


---

### ~~Session 4 — Visual Polish~~ ✅ DONE
Completed 2026-04-03: stat cards on projects list, activity feed on project overview

### ~~Session 5 — Lead Schedule, My Items, Settings Completion~~ ✅ DONE
Completed 2026-04-03: settings/calendar, settings/contacts, settings/sales-taxes, lead schedule, catalog items

### ~~Session 6 — Templates Hub + Schedule Gantt Final Polish~~ ✅ DONE
Completed 2026-04-03: templates hub (4 sub-routes: docs, schedules, selections, mood-boards)

### ~~Session 7 — Bid Packages~~ ✅ DONE
Completed 2026-04-03: full bid packages with 3-section editor, schema, actions

### ~~Sub-Contractor Portal~~ ✅ DONE
Completed 2026-04-03: sub-portal with schedule access, status updates, comments


---

## 🗺️ Phase 2 — Polish, Integrations & AI

Now that all pages/routes exist, focus shifts to: making them production-quality, wiring real integrations, and adding AI automation.

### Next Sessions (pick any order)

~~**Session 8 — Invoice & Leads Polish**~~ ✅ DONE (2026-04-03)
- [x] Invoice page: 4 stat cards (Total Invoiced, Collected, Outstanding, Overdue), status tabs with count badges, column reorder
- [x] Leads list: tabbed views (All, Hot, Won, Lost), sortable columns, lead scoring button
- [x] Daily logs: weather icon picker, photo thumbnails in list view

~~**Session 9 — Real Email & SMS + Console Log Cleanup**~~ ✅ DONE (2026-04-03)
- [x] Wire `src/lib/email.ts` to Resend API — already real; keys live in Vercel
- [x] Wire `src/lib/sms.ts` to Twilio — already real; wired subcontractor invite SMS
- [x] Remove all production console.logs (email, sms, supabase init, approveEstimate, COI debug, stripe webhook)
- [x] Add error boundaries to all page layouts (projects, settings, reports, company, portal, sub-portal)

~~**Session 10 — Financial Precision + Friendly IDs**~~ ✅ Migration SQL ready (2026-04-03)
- [x] `migrations/session10_float_to_decimal.sql` — 30 ALTER COLUMN statements for all money fields
- [x] `migrations/session10_friendly_ids_and_integration.sql` — SERIAL number columns on 7 models + integrationData TEXT on CompanySettings
- [ ] **PENDING (needs Windows):** Run both via apply_schema.ps1 → `./node_modules/.bin/prisma generate` → update schema.prisma Float→Decimal

**Session 11 — QuickBooks Integration**
- [ ] GL account mapping table in settings
- [ ] Manual sync button for estimates/invoices/expenses
- [ ] Two-way sync architecture (see VISION.md)

**Session 12 — Gusto + Email Receipt Capture**
- [ ] Gusto time export: employee name, hours, date
- [ ] Email receipt capture: forward-to address + AI parsing (Gemini Vision)
- [ ] Bookkeeper approval queue → QB sync

**Session 13 — AI Features (High Impact)**
- [ ] Lead Scoring — close probability %, quality rating
- [ ] Cost Forecast — predict final cost, flag overruns
- [ ] Contract Drafting from Estimate
- [ ] Schedule Risk Analysis
- [ ] Daily Log Photo Analysis (Gemini Vision)

---

## 🗂️ Critical Files Reference
- `src/components/ProjectInnerSidebar.tsx` — every new project sub-route must be registered here
- `src/app/settings/layout.tsx` — settings sidebar needs expansion
- `src/app/company/layout.tsx` — company sidebar has wrong hrefs
- `src/lib/actions.ts` — all new server actions (no new split files per CLAUDE.md)
- `prisma/schema.prisma` — all schema changes
- `compare.py` — optional QA tool for quarterly sanity checks only

---

## 🔴 Critical (Fix Now)

- [ ] **Financial Float → Decimal** — all money fields use Float, causing precision errors. Migrate to Decimal
- [x] **Mock email/SMS** — Resend + Twilio already wired; subcontractor SMS now live (2026-04-03)
- [x] **Remove console.logs** — removed from email.ts, sms.ts, supabase.ts, actions.ts, stripe webhook (2026-04-03)
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

- [x] All 7 parity sessions completed (2026-04-03)
- [x] Sub-contractor portal with schedule access (2026-04-03)
- [x] Schedule Gantt: drag/resize, dependencies, AI generation, milestones, critical path, punch list, comments, team/sub assignment, touch support (2026-04-02–03)
- [x] Report sub-pages: open-invoices, payments, time-billing, global-tracker (2026-04-03)
- [x] Templates hub: schedules, selections, mood-boards (2026-04-03)
- [x] Bid packages: full 3-section editor (2026-04-03)
- [x] Settings: calendar, contacts, sales-taxes, notifications, payment-methods, integrations (2026-04-03)
- [x] Visual polish: stat cards on projects list, activity feed on project overview (2026-04-03)
- [x] Production fix: DATABASE_URL credentials + pgbouncer flag (2026-04-03)
- [x] VISION.md, DESIGN_SYSTEM.md created (2026-04-03)
- [x] CLAUDE.md rewritten with efficiency rules (2026-04-03)
