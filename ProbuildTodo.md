# ProBuild — Todo & Improvement List
_Last updated: 2026-04-02_

---

## 🔴 Critical (Fix Now)

- [ ] **Hardcoded "Justin Account"** on dashboard — replace with session user name (`/src/app/page.tsx` line ~13)
- [ ] **Financial Float → Decimal** — all money fields in Prisma schema use Float, causing precision errors. Migrate to Decimal
- [ ] **Mock email/SMS** — `src/lib/email.ts` and `src/lib/sms.ts` are still mock implementations. Wire real Resend + Twilio
- [ ] **Remove console.logs** — 8+ production console.logs across actions.ts, email.ts, sms.ts, stripe webhook, API routes
- [ ] **Project Overview uses local DB ID** — always query prod project IDs via API, not local DB (see CLAUDE.md)
- [ ] **Dead buttons** — audit every page for unlinked buttons/nav items and wire them intelligently

---

## 🟠 High Priority

- [ ] **Consolidate CostCode/CostType** — dual system in schema. Schema comment says "use CostType going forward" — migrate and remove CostCode references
- [ ] **Error boundaries** — add to all page layouts, currently no centralized error handling
- [ ] **Form validation with Zod** — installed but underutilized. Add server-side validation with proper error propagation
- [ ] **Job Costing UI** — `/projects/[id]/costing/` delegates to JobCostingClient but implementation unclear — verify and complete
- [ ] **Reports page** — "Open Invoices" links to /invoices twice. Fix + add export (PDF/Excel) functionality
- [ ] **Stripe webhook** — unhandled event types being silently dropped. Add proper handling or logging
- [ ] **Customize Dashboard button** — wired to nothing. Implement or remove
- [ ] **Add To-Do on dashboard** — creates empty state instead of actually creating a task

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
- [ ] **Settings page** — currently 404ing in production. Fix runtime error
- [ ] **Company page** — currently 404ing in production. Fix runtime error
- [ ] **Daily Logs** — route not mapped in compare.py, showing /projects instead
- [ ] **Project Overview** — showing list instead of detail view
- [ ] **Leads List** — missing tabbed views and columns vs Houzz Pro

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

## 📊 QA Scores (April 2, 2026)

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
