# Spec: Client Selections Playground → Decisions → Purchasing

Origin: Justin's reframe (2026-07-28) after Janet Hoppe & Tom White started using the suggestion flow unprompted.
Supersedes the approval-gate model shipped in PRs #250 / #256 / #258.

## The inversion

**Old model:** PM curates options → client picks. Client suggestions sit Pending until the PM approves them into existence.

**New model:** Selections is the CLIENT'S space. They add and organize whatever they want. The PM does not gate what may exist. The event that matters is the client *deciding* — a decided item becomes the company's record of truth and goes to Richard to **buy**, not to bless.

Approval moves from "may this item exist" → "this is final, go purchase it."

## The three surfaces, each with one job

| Surface | Job | Who drives |
|---|---|---|
| **Playground** (decisions + candidates) | Explore. Three faucets you're torn between live here. | Client |
| **Mood board** | See it all together, visually, as a room. | Client (existing collaborative canvas) |
| **Selection board** | The approved items. The final record both sides trust. | Produced by deciding |

A **Decision** ("Sink Faucet") holds candidates. Choosing one promotes it to the approved record. The mood board is the visual read across everything.

## Decisions locked with Justin

- **No prices on client-added items. Ever.** Not in the playground, not after deciding, not in a confirmation. Rule: *GTR controls whether a number appears.* PM-staged options on legacy boards keep their prices (there the price IS the decision); client-added items show name/photo/vendor link/notes only.
- `SelectionProposal.price` (clipped list price) keeps being captured **for the team's context only** — never returned by any portal read path, in any status. Stricter than today, where Approved proposals return price.
- **Allowances are internal-only.** Richard sees decided-item totals vs allowance; the client never sees budget math.
- **Richard gets a flag, not a veto** — mark a decided item "needs a look" with a client-visible note (wrong rough-in, discontinued, over allowance). Reopens the decision instead of silently blocking it.
- **Templates are authored by GTR only** — never by clients. The team builds "Bathroom Remodel" once, applies ("deploys") it to a project, and the client then plays inside that structure. Clients CAN create their own extra decisions on their project; they can never create or edit a company template.
- **Lose no existing customer data.** Nothing is deleted or destructively remapped; legacy boards keep rendering and their picks import on an explicit action, never automatically.

## Non-goals

- No change to estimates, change orders, invoices, or any money path.
- No client-visible budget/allowance numbers.
- Legacy `SelectionBoard` flow (Draft/Sent/Selections Made, one-pick-per-category, prices shown) keeps working untouched.

---

## Phase 1 — Playground, decisions, approved record

**Data model** (all additive; `scripts/apply-selections-playground.mjs`, idempotent, no deletes):

```
model Decision {
  id             String   @id @default(cuid())
  projectId      String
  name           String            // "Sink Faucet"
  area           String?           // "Master Bath" — grouping in the UI
  status         String   @default("Open")  // Open | Decided | Flagged | Ordered | Received
  chosenItemId   String?  @unique  // → SelectionProposal
  sortOrder      Int      @default(0)
  templateKey    String?           // provenance when seeded from a template
  // Phase 2 fields land here: dueDate, scheduleTaskId, leadTimeDays
  createdByClient Boolean @default(false)
  decidedAt      DateTime?
  pmNote         String?           // client-visible note from the flag path
  createdAt/updatedAt
  @@index([projectId, status])
}
```

`SelectionProposal` gains `decisionId String?` (→ Decision, SetNull) and new status semantics:
`"Idea"` (default — client added it, ungated) · `"Chosen"` · `"Archived"` (client dropped it; hidden, not deleted).
Legacy `"Pending"`/`"Approved"`/`"Declined"` remain readable so in-flight rows never break.

**Client (portal):**
- Add an item — clipper, paste-a-link, manual — lands as `Idea`, no gate.
- Create/rename/reorder their own decisions; drag an item into a decision; ungrouped items sit in "Unsorted".
- **"This is the one"** on a candidate → decision `Decided`, `chosenItemId` set. Siblings stay visible as candidates (never auto-archived — the runner-up matters).
- Un-choose while not yet Ordered; once Ordered it's blocked with a friendly "your team has already ordered this, message them."
- Archive items they've cooled on.
- **Never sees a price on their own items.**

**Team (project Selections tab):**
- Client's decisions and candidates, with clipped list price visible (internal context only).
- **Approved Items** view: every Decided decision with its chosen item — the shared record of truth.
- Flag a Decided item with a client-visible note → `Flagged`, reopens on the client side with the reason shown.
- Add a candidate into a client decision ("Richard suggests") — appears as a peer candidate.
- Legacy boards render alongside, unchanged, plus a per-project **"Import board picks as decisions"** action (explicit, never automatic).

**Notifications:** client decides → team email + activity log (this is the loud one, it demands action). Client adds an Idea → quiet/batched. Team flags → client email.

## Phase 2 — Templates + schedule-driven due dates (the domino layer)

**Decision templates — team-authored, team-applied** (fills the existing `/templates/selections` placeholder). Authoring and applying are ADMIN/MANAGER only; no portal route may create, edit, or apply a template.
```
model DecisionTemplate      { id, name ("Bathroom Remodel"), description, items[] }
model DecisionTemplateItem  { id, templateId, name ("Shower Valve"), area, defaultLeadTimeDays, costCodeId?, stageHint?, sortOrder }
```
- Seed real GTR templates: Bathroom Remodel, Kitchen, ADU.
- Apply a template to a project → seeds `Decision` rows (skip-if-name-exists, so re-applying is safe). Client opens their space to a *checklist of what needs deciding*, not a blank page.

**Schedule linkage** — `Decision` gains `scheduleTaskId String?`, `leadTimeDays Int?`, `dueDate DateTime?`, `dueDateManual Boolean @default(false)`:
- `dueDate` = linked `ScheduleTask.startDate` − `leadTimeDays`, recomputed whenever the task moves — UNLESS `dueDateManual`, in which case Richard's typed date always wins and recompute leaves it alone.

**Where Richard controls the date** (three layers, one primary):
1. **Template default** — each template item carries `defaultLeadTimeDays`. Applying a template to a project sets the initial lead time, so most dates are right without anyone touching them.
2. **Project → Selections tab, team view (PRIMARY)** — each decision row has a "Needed by" cell: pick the schedule task it feeds + lead-time days (auto-computes and stays live as the schedule shifts), or type a hard date (sets `dueDateManual`). This is the answer to "where do we go for that."
3. **Cross-project decision pipeline** — every open decision across active jobs sorted by due date, overdue first, editable inline. Richard's triage view when he wants to see what's about to stall a job.
- **Client-facing decision tracker** in the same Domino's-style language as the portal project tracker (`src/lib/portal-tracker.ts`, PR #243): **Needed now** (due ≤ 7 days or overdue) · **Coming up** · **Decided**. Each shows "Decide by Aug 12" and, once decided, what happens next ("Ordering next — install week of Aug 22").
- **Team pipeline view**: decisions sorted by due date across active projects, overdue flagged — the thing that keeps a job from stalling on a faucet.
- Overdue/approaching nudges to the client, and to the job's Google Chat space for the team.

## Phase 3 — Purchasing queue

`/purchasing` (team): every Decided decision across active projects — vendor link, clipped price, client note, due date. Mark **Ordered** (date, order ref, actual cost) → **Received**. Adds `orderedAt/receivedAt/orderRef/actualCost`. Status flows back to the client as a plain line ("Ordered Aug 2 · arriving Aug 12") with **no cost shown**.

## Phase 4 — Internal allowances

Allowance per decision or area, team-side only; decided-item total vs allowance with over/under. Feeds Richard's flag decision. Never rendered in any portal route.

---

## Migration (Janet is mid-flight — strand nothing)

- `SelectionProposal` `"Pending"` → `"Idea"` (live playground items; nothing was rejected), `"Approved"` → `"Chosen"`, `"Declined"` → `"Archived"`. All keep `pmNote`.
- Hoppe's 2 in-flight items (CalFaucets wall faucet trim + ZeroDrain drain, both with notes) become Ideas, ungrouped, ready to sit in a "Sink Faucet" decision with a third candidate.
- Legacy `SelectionBoard`/`SelectionCategory`/`SelectionOption` rows are **not touched**. Boards keep rendering and functioning; importing their picks as Decisions is an explicit per-project action.
- `MoodBoard` untouched.
- Additive DDL + guarded status remap only. No deletes, no drops. **Run against prod before deploying** per the pre-deploy checklist.

## Verification

- Portal returns **zero** price fields for client-added items in every status — grep every portal read path and assert.
- Client cannot read/write another project's decisions or items (`assertPortalProjectOwnership` + `isPortalEnabled`/`showSelections`).
- Choose/un-choose/flag are CAS-guarded and transactional so double-submits no-op (follow `decideSelectionProposal`'s pattern).
- Legacy flow untouched: `PortalSelectionsClient.tsx` and `submitClientSelections` unchanged; existing boards still send and submit.
- Re-applying a template creates no duplicates.
- `npm run build` 0 errors; no money-path files in the diff; Codex review after implementation.
