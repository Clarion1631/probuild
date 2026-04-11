# Agent B — Estimate Editor Polish + Cleanup

Work on branch `feat/estimate-polish`. Run `git checkout -b feat/estimate-polish` first.

## Your Scope
You MODIFY existing files. You own `src/lib/actions.ts` and `prisma/schema.prisma`.

## Collision Rules
- You own: `src/lib/actions.ts`, `prisma/schema.prisma`, `EstimateEditor.tsx`, `email.ts`, `sms.ts`
- Do NOT touch `src/components/ProjectInnerSidebar.tsx` — Agent A owns that
- Do NOT create files in `/budget/` or `/time-expenses/` — Agent A owns those
- Do NOT create `budget-actions.ts` or `time-expense-actions.ts` — Agent A owns those

## Task 1: Estimate Editor — Description Field
File: `src/app/projects/[id]/estimates/[estimateId]/EstimateEditor.tsx`

The `description` field exists in the DB (EstimateItem.description) and is saved in `saveEstimate`, but is NOT rendered in the editor UI. Add a description textarea below each item name input.

## Task 2: Estimate Editor — Tax from CompanySettings
Currently hardcoded at 8.7%. Pull from `CompanySettings.salesTaxes` (JSON array of `{name, rate, isDefault}`).

- In `actions.ts`: modify `getEstimate` to also fetch CompanySettings salesTaxes
- In `EstimateEditor.tsx`: replace hardcoded 8.7% with the default tax rate from settings
- Display tax name (e.g., "Vancouver City 8.7%") instead of just "Estimated Tax"

## Task 3: Estimate Editor — Processing Fee Markup
Add a processing fee line in the summary block, with an eye icon toggle to hide from client view.

- Add `processingFeeMarkup Decimal?` field to Estimate model in schema.prisma
- Add `hideProcessingFee Boolean @default(true)` to Estimate model
- In summary block: show "Processing Fee Markup" row with amount + eye toggle
- In Client view mode: hide this row when `hideProcessingFee` is true

## Task 4: Estimate Editor — Status Flow
Current status handling is incomplete. Implement full UI:
Draft → Sent → Viewed → Approved → Invoiced → Paid

- Add a status dropdown/badge in the editor header area
- The `viewedAt` field exists — use it to auto-set "Viewed" status
- Color-code: Draft=slate, Sent=amber, Viewed=blue, Approved=green, Invoiced=teal, Paid=green

## Task 5: Estimate Editor — Expiration Date
- Add `expirationDate DateTime?` to Estimate model in schema.prisma
- Add date picker in General Info section (next to Date Issued)
- Save via `saveEstimate` action

## Task 6: Estimate Editor — Log Payment Modal
Add "Log Payment" button on each payment schedule row.

Create `src/app/projects/[id]/estimates/[estimateId]/LogPaymentModal.tsx`:
- Fields: Total Amount (pre-filled), Payment Method (dropdown), Amount (editable), Date (calendar), Reference Number (auto PM-NNNNN)
- On save: update payment schedule row status to "Paid", record payment

## Task 7: Estimate Editor — Archive Action
- Add `archivedAt DateTime?` to Estimate model in schema.prisma
- Add `archiveEstimate` action in actions.ts (soft delete — set archivedAt)
- Add "Archive" option in the Actions dropdown (between "Delete" and separator)
- Filter archived estimates from default list view

## Task 8: Retainer Editor
Currently `/projects/[id]/retainers/page.tsx` is read-only list. Add editor.

Create `src/app/projects/[id]/retainers/[retainerId]/page.tsx` and `RetainerEditor.tsx`:
- Fields: Name, Status, Date, Amount, Due Date, Notes
- Actions: Save, Send to Client, Delete
- Add `createRetainer` and `updateRetainer` actions in actions.ts

## Task 9: Console Log Cleanup
Remove mock console.logs from production code:
- `src/lib/email.ts` lines 18-28: wrap in `if (process.env.NODE_ENV !== 'production')`
- `src/lib/sms.ts` lines 23-28: wrap in `if (process.env.NODE_ENV !== 'production')`
- `src/app/api/clients/[id]/invite/route.ts` line 113: remove `[DEV MODE]` log

Do NOT remove `console.error()` calls — those are proper error logging.

## Schema Changes Summary
Add to `prisma/schema.prisma` Estimate model:
```prisma
processingFeeMarkup Decimal?
hideProcessingFee   Boolean   @default(true)
expirationDate      DateTime?
archivedAt          DateTime?
```

After editing schema.prisma, run:
```bash
"C:\Program Files\Git\bin\bash.exe" -c "cd '/c/Users/jat00/.gemini/antigravity/workspaces/gtr-probuild-site' && ./node_modules/.bin/prisma generate"
```

For DB migration, write SQL to `C:\Users\jat00\AppData\Local\Temp\apply_schema_b.ps1` following the pattern of the existing `apply_schema.ps1`.

## AI Model Rules
- `ANTHROPIC_API_KEY` is configured in `.env.local` and Vercel
- Any new AI features in estimates should use Claude (`@anthropic-ai/sdk`) with `claude-sonnet-4-6`
- Vision/OCR tasks should use Gemini Flash 3 Preview (`gemini-3.0-flash-preview`) via `@google/genai` with `GEMINI_API_KEY`
- Guard with `if (!process.env.ANTHROPIC_API_KEY)` or `if (!process.env.GEMINI_API_KEY)` early return
- Also update `src/app/api/ai/daily-logs/route.ts` line 89: change `gemini-2.0-flash` to `gemini-3.0-flash-preview`

## Design System
Follow `DESIGN_SYSTEM.md` in project root:
- Colors: hui-primary (#4c9a2a), hui-background (#f8f9fa), hui-border (#e1e4e8)
- Status colors: green=complete/approved, blue=in-progress/viewed, amber=sent, red=overdue, slate=draft
- Typography: text-sm for body, text-xs font-semibold uppercase for labels

## When Done
- Run `npm run build` — must pass with 0 errors
- Commit all changes to `feat/estimate-polish` branch
- Do NOT merge to main — wait for coordination
- Do NOT push to remote yet
