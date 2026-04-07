# Agent A — Budget & Financial Pipeline

Work on branch `feat/budget-pipeline`. Run `git checkout -b feat/budget-pipeline` first.

## Your Scope
You build NET-NEW files only. You do NOT touch `src/lib/actions.ts`, `prisma/schema.prisma`, or `EstimateEditor.tsx`.

## Collision Rules
- Put all new server actions in `src/lib/budget-actions.ts` (NEW file)
- Put time/expense actions in `src/lib/time-expense-actions.ts` (NEW file)
- For DB schema changes, write SQL in `C:\Users\jat00\AppData\Local\Temp\apply_schema_a.ps1` — do NOT modify `prisma/schema.prisma`
- Only existing file you may edit: `src/components/ProjectInnerSidebar.tsx` (add Budget link)
- Do NOT touch `src/lib/actions.ts` — Agent B owns that file
- Do NOT create or modify anything in `src/app/projects/[id]/estimates/`

## Task 1: Budget Page (THE #1 priority)
Create `/projects/[id]/budget` — Houzz Pro's most powerful financial feature.

**Files to create:**
- `src/app/projects/[id]/budget/page.tsx` — server component, auth check, data fetch
- `src/app/projects/[id]/budget/BudgetClient.tsx` — client component
- `src/app/api/projects/[id]/budget/route.ts` — API for budget data aggregation

**Requirements (from Houzz Pro capture):**
- 4-panel summary bar with tooltips:
  1. Revised Estimated Cost = Original Estimate + Change Orders (markup included)
  2. Actual = linked Expenses + Time Entries + POs (taxes excluded)
  3. Variance = Revised - Actual ($ and %, green when positive, red when negative)
  4. Invoiced = total invoiced to client (taxes excluded, shows %)
- Table: Name | Original Est | Revised Est | Actual | Variance ($) | Variance (%) | Invoiced ($) | Invoiced (%)
- "View by: Category" dropdown
- "Budget Settings" modal: Sync Documents (which statuses count) + Customize Columns (toggle/reorder)
- "Generate Report" button (CSV export)
- "Preview & Share" button (client-facing view)
- Collapse All button for category rows
- **KEY**: Budget pulls Actuals from Expenses, Time Entries, and Purchase Orders linked to estimate line items. Per-line-item variance when linked.

**Add to ProjectInnerSidebar.tsx** — add "Budget" link in Finance section:
`{ name: "Budget", href: \`/projects/\${projectId}/budget\`, icon: BarChart3 }`
Place it between "Retainers & Credits" and "Financial Overview".

## Task 2: Time & Expenses Restructure
Currently only `/projects/[id]/timeclock` exists. Create a proper two-tab layout.

**Files to create:**
- `src/app/projects/[id]/time-expenses/page.tsx` — server component with two-tab layout
- `src/app/projects/[id]/time-expenses/TimeTab.tsx` — time tracking tab
- `src/app/projects/[id]/time-expenses/ExpensesTab.tsx` — expense tracking tab
- `src/app/projects/[id]/time-expenses/NewTimeEntryModal.tsx`
- `src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx`

**Time Tab requirements:**
- Summary bar: Total Duration | Total Billable | Total Invoiced | Total Cost (non-billable)
- Filters: Team Members, Date Range, Service
- New Time Entry modal: Reported By, Service, Hourly Rate, Taxable/Billable toggles, Date, Hours, Description, Attach Files, "Log Another Entry" checkbox
- Table: checkbox | Reported By | Date | Service | Description | Hours | Rate | Total | Billable | Taxable | Invoice | Files
- "Create Invoice" from selected time entries
- Import/Export time entries

**Expenses Tab requirements:**
- Summary bar: Total Billable | Total Invoiced | Total Cost (non-billable)
- Additional filter: Sync to QuickBooks status
- New Expense Entry modal with AI receipt OCR:
  - Upload area: "Upload Files — AI will fill in the details for you"
  - Use Gemini Flash 3 Preview (`gemini-3.0-flash-preview`) for receipt parsing (follow pattern in `/api/ai/daily-logs/route.ts` — uses `@google/genai` with `GEMINI_API_KEY`)
  - Do NOT use Claude/Anthropic for receipt OCR — Gemini is faster/cheaper for vision tasks
  - Fields: Reported By, Service, Payment Method, Cost, Taxable/Billable, Reference Number (auto EX-NNNNN), Sync to QuickBooks toggle, Date, Qty, Description
- Table: checkbox | Reported By | Date | Service | Description | Quantity | Cost | Total | Billable | Taxable | Sync | Payment Method | Invoice | Files

**Update ProjectInnerSidebar.tsx** — change "Time & Expenses" href from `/projects/${projectId}/timeclock` to `/projects/${projectId}/time-expenses`

## Task 3: Document Code Display Component
Create `src/components/DocumentCode.tsx` — renders formatted doc numbers like `ES-10085`, `IN-10046`.

```tsx
// Usage: <DocumentCode type="estimate" number={85} />
// Renders: ES-10085
const PREFIXES = { estimate: 'ES', invoice: 'IN', changeOrder: 'CO', purchaseOrder: 'PO', retainer: 'RR', expense: 'EX', payment: 'PM' };
```

## AI Model Rules
- `ANTHROPIC_API_KEY` is configured in `.env.local` and Vercel for Claude endpoints
- `GEMINI_API_KEY` is configured in `.env.local` and Vercel for Gemini endpoints
- Receipt/expense image parsing → Gemini Flash 3 Preview `gemini-3.0-flash-preview` (vision/OCR tasks)
- All new AI endpoints should guard with `if (!process.env.KEY)` early return
- Use existing `@google/genai` package for Gemini

## Design System
Follow `DESIGN_SYSTEM.md` in project root:
- Colors: hui-primary (#4c9a2a), hui-background (#f8f9fa), hui-border (#e1e4e8)
- Status colors: green=complete, blue=in-progress, amber=sent, red=overdue, slate=draft
- Page layout: Type A (List Page) or Type C (Detail/Editor)
- Use `hui-btn`, `hui-card`, `hui-input` class patterns

## When Done
- Run `npm run build` — must pass with 0 errors
- Commit all changes to `feat/budget-pipeline` branch
- Do NOT merge to main — wait for coordination
- Do NOT push to remote yet
