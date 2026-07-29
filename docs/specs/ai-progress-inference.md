# SPEC: Nightly AI progress inference — Chat evidence → project snapshot → stage proposals

Status: **draft, not approved**. Written 2026-07-28. Extends the field-evidence arc
(`~/.claude/plans/ok-so-we-staged-curried-minsky.md`) with three things that plan does not cover:
a durable per-project progress snapshot, photo evidence, and advancement of the **client-visible
portal stage**.

Owner intent, verbatim anchors: *"the AI has a cron job that goes in every night to see how far
along we've progressed"*; *"in order to be efficient, we probably should have an AI go in and build
out where each project was at, store … a whole database somewhere of information so we know the
progress … so it doesn't have to read everything over again to simply update the status"*;
*"try to look at the photos in the Google Chat in order to analyze how well it's come along"*;
*"it needs the ability to allow an override from the specific schedule within the project"*;
*"I like the domino tracker, and I like the task name under all of the schedules … the task name
come from the milestone"*.

---

## What exists today (verified 2026-07-28 against main @ `319566f`, not assumed)

| Thing | State |
|---|---|
| Google Chat integration | **None.** Zero matches for `google_chat` / `chat.googleapis` / `spaces/AAQ` in `src/`. |
| Crons | 7 exist (`vercel.json`): scheduled-messages, COI check, QBO payments, notification drain, CO billing sweep, AR digest, payment reminders. **None touch progress or Chat.** |
| `DailyLog` model | Exists — `workPerformed`, `materialsDelivered`, `issues`, `weather`, `crewOnSite`, `sharedToPortal`, `sharedContentHash`, `photos[]`. Company-wide row count was **0** at the last prod survey, but see the MCP row below. |
| Daily logs via MCP | **New** — PR #257 shipped `create_daily_log` (`src/lib/mcp-pm-tools.ts:527`), so Richard's AI can now write daily logs through the connector. This is a live evidence source that does **not** depend on the Chat rail. |
| Arc PR-1 (truth layer) | **Merged** (PR #253). `src/lib/task-evidence.ts`, `punch-task-binding.ts`, `company-day.ts` are on main, and `TaskPunchItem.completedAt` exists. Use `toCompanyDayKey` from `company-day.ts` — do not re-implement day keys. |
| `ScheduleProposal` | **Does not exist.** Arc PR-3 is unbuilt; Goal 3 below is what creates it. |
| `ScheduleTask` | Has `progress Int @default(0)`, `status String @default("Not Started")`, `parentId`, `type`, `estimateItemId`. **No** `progressLockedAt` and **no** AI-vs-human provenance field. |
| Portal stage | `Project.portalStageOverride` (nullable `CLIENT_STAGES` label) + `setPortalStageOverride` action + picker in the portal staff-preview banner. Shipped `42aa81d`, live on prod. |
| Domino labels | Hardcoded `CLIENT_STAGES[].label`. `ProjectTrackerStage` is `{label, state, pct}` — **no milestone name is carried through.** See Goal 5. |
| Vision / photo analysis | None. `GEMINI_API_KEY` is configured and Gemini is used elsewhere (clipper `url_context`), but nothing analyses images. |
| Progress snapshot table | **None.** |

**Dependency:** Goals 2 and 3 need an evidence stream. Three now exist or are close:

1. **Daily logs written through MCP** (`create_daily_log`, shipped in #257) — live today, no new
   integration required. If Richard's AI starts logging, this layer has real input immediately.
2. **Task edits** — always available, weakest signal.
3. **Chat messages** — arc PR-2, unbuilt, the richest source and the one with the most unknowns.

Goal 1 is deliberately built so it works against sources 1 and 2 *before* Chat exists, and gains Chat
as one more watermarked source afterwards. That ordering matters: it means this layer can be proven
on real data without waiting on Workspace scope approval.

---

## Invariants (non-negotiable — a change here is a product decision, not an implementation detail)

1. **The portal stage is client-visible, so AI never writes it directly.** Stage changes are
   proposals that a human applies. An AI misreading "we'll start drywall next week" as "drywall
   started" tells the customer the job advanced. This is the whole reason the column is separate
   from task progress.
2. **The roundel stays ≤99 while any stage is `current`.** Already enforced in `buildProjectTracker`.
   Any new writer must not defeat it.
3. **Task progress stays clamped 1–99, In-Progress leaves only** (existing arc decision). AI never
   marks anything Complete.
4. **"Complete" is never proposed as a stage.** Project completion is a contractual event — final
   payment, punch signoff, warranty start. No evidence classifier gets to declare it.
5. **A human edit wins and is durable.** Once a human sets the stage or a task's progress, AI may
   propose a change but never silently overwrite.
6. **Photos corroborate, they never trigger.** See Goal 2 rationale.
7. **All model-facing text is untrusted input** — Chat messages, photo captions, task names, OCR'd
   text in images — fenced the way `src/app/api/ai/change-order-detect/route.ts:139` fences it.
8. **Day keys are LA-local** via `toCompanyDayKey` (`src/lib/company-day.ts`, on main since PR #253),
   never `.toISOString().slice(0,10)`. A 7pm PDT message reads as tomorrow in UTC and inflates
   freshness.
9. **RLS on every new table**, matching `scripts/apply-dispatch-b1-schema.mjs:170`, asserted in the
   verify script.

---

## Goal 1 — `ProjectProgressSnapshot`: the incremental state store

This is the efficiency mechanism Justin asked for. One row per project holding what the AI currently
believes, plus per-source watermarks so a nightly run reads only what is new.

**Schema** (additive; `scripts/apply-progress-snapshot-schema.mjs`, RLS as above):

```
ProjectProgressSnapshot
  id                String   @id @default(cuid())
  projectId         String   @unique
  narrative         String   @db.Text   -- running plain-English summary of where the job stands
  stageLabel        String?              -- AI's believed CLIENT_STAGES label
  stageConfidence   String?              -- "low" | "medium" | "high" (banded, per change-order-detect precedent)
  evidenceRefs      String   @db.Text    -- JSON array of {kind, id, dayKey} the narrative rests on
  watermarks        String   @db.Text    -- JSON: per-source cursors, see below
  inputHash         String?              -- sha256 of the evidence set consumed at last write
  modelVersion      String
  promptVersion     String
  rebuiltAt         DateTime             -- last FULL rebuild (not incremental)
  lastRunAt         DateTime
  createdAt/updatedAt
  @@index([projectId])
```

**Watermarks are per-source**, because sources advance independently and a single global cursor
silently drops evidence:

```json
{
  "chatMessage": { "lastCreateTime": "...", "lastResourceName": "spaces/X/messages/Y" },
  "dailyLog":    { "lastDayKey": "2026-07-28", "lastId": "..." },
  "photo":       { "lastId": "..." },
  "taskEdit":    { "lastUpdatedAt": "..." }
}
```

**Nightly incremental pass:** read snapshot → fetch only evidence past each watermark (bounded batch,
see Goal 6) → prompt the model with `previous narrative + new evidence only` → write updated
narrative, advance watermarks, stamp `lastRunAt`. If nothing is past the watermark, **write nothing
and make no model call** — a quiet project costs zero.

**Full rebuild — this is the part that must not be skipped.** A narrative that is only ever
summarised from the previous narrative compounds its own errors and can never self-correct, because
nothing re-reads the source. Rebuild (ignore watermarks, read the project's full evidence history):

- weekly, staggered across projects so the cost is spread;
- on demand from a staff button;
- automatically whenever `stageConfidence` drops to `low`, or a human rejects a stage proposal
  (a rejection means the belief is wrong — keeping it as the baseline poisons every later run).

`evidenceRefs` stores IDs, not just prose, precisely so a rebuild is possible and so the review tray
can show *"this sentence, from this message, on this day."*

**Model routing (cost).** Incremental updates run on Haiku — the input is one short narrative plus a
handful of new messages. Full rebuilds and any project where confidence is `low` route to a stronger
model. Record which in `modelVersion`.

**Overlap-window caveat inherited from PR-2:** `spaces.messages.list` filters on `createTime` only, so
an *edited* message never reappears past a pure cursor. The watermark must be paired with the same
upsert-on-`(resourceName, lastUpdateTime|contentHash)` the Chat rail uses.

---

## Goal 2 — Photo observations (vision), corroboration only

**Why corroboration and not a trigger.** Framing photos taken three days apart look nearly identical
to a vision model; a photo of one finished room says nothing about the other four; and lighting and
angle change the answer more than progress does. Photo-only stage advancement would be confidently
wrong on a client-facing surface. So:

> A stage proposal **requires at least one text evidence item**. Photos may raise the confidence band
> by one step or corroborate an existing signal. Photos alone never create a proposal.

**Schema:**

```
PhotoObservation
  id            String @id @default(cuid())
  photoId       String @unique   -- DailyLogPhoto (and Chat attachment photos once PR-2 lands)
  projectId     String
  summary       String @db.Text  -- what the model sees
  stageHints    String @db.Text  -- JSON array of {stageLabel, strength}
  modelVersion  String
  promptVersion String
  createdAt
  @@index([projectId])
```

Observations are computed **once per photo and cached** — that is the same efficiency principle as
the snapshot, applied to images, which are the expensive input. Re-analysis only on prompt/model
version bump.

**Bounds:** cap photos analysed per project per run (start at 10, newest first). Photos live in the
**private** bucket per the arc's storage decision.

**Open decision for Justin:** analysing job-site photos means sending customer property images to
Google's Gemini API. `GEMINI_API_KEY` is already in use elsewhere in the product, so this is likely
fine, but it is a new *category* of data leaving the system and should be an explicit yes.

---

## Goal 3 — Stage inference → proposals

Extend the arc's `ScheduleProposal` table with a `kind` discriminator rather than forking a second
table: `kind: "task_progress" | "portal_stage"`. Same state machine
(`pending → applied | rejected | undone`, never deleted), same evidence refs, confidence band, model
+ prompt version, dedup key, actor/timestamps on every transition.

**Deterministic eligibility, validated independently of the model's self-reported confidence:**

- proposed label is a real `CLIENT_STAGES` label and is **not** `"Complete"` (invariant 4);
- every returned evidence ID actually belongs to that project;
- at least one evidence item is text (invariant 6);
- a **forward** move (later stage index) is the normal case;
- a **backward** move is allowed but flagged `regression: true` in the tray with a required reason —
  going backwards on a client-facing rail is either a genuine setback the client should hear about
  from a human, or a bad inference. Either way it is not routine.
- no `pending` stage proposal already exists for the project (dedup).

**Apply is CAS-guarded and human-only.** ADMIN/MANAGER, expected-`Project.updatedAt` +
expected-current-`portalStageOverride`, writing the override, the proposal transition, and the audit
row in one transaction. Undo takes the same CAS so it cannot clobber a later human correction.

**Surfacing:** stage proposals appear in the same review tray as task-progress proposals, with the
photo and the sentence they came from inline. One-tap apply, one-tap reject, one-tap undo.

---

## Goal 4 — Override authority from the schedule, plus provenance

Justin: *"it needs the ability to allow an override from the specific schedule within the project."*
Today the picker only exists in the portal staff-preview banner — the wrong place, because Richard
works in the schedule.

- Add the same stage control to the **project schedule page** header (staff-only, reusing
  `setPortalStageOverride` — no second writer).
- Add provenance to `Project`: `portalStageOverrideSetBy String?` (userId or `SYSTEM:ai`) and
  `portalStageOverrideAt DateTime?`. Without these, nothing can distinguish a human pin from an
  applied proposal, and invariant 5 is unenforceable.
- Add `progressLockedAt DateTime?` to `ScheduleTask` (the arc already assumes it exists; it does
  not). Human progress edits stamp it in `schedule-task-core.ts`; AI eligibility requires it null.
- `setPortalStageOverride` records the actor in the existing ActivityLog row (it already logs
  from/to) **and** in the new provenance columns.

---

## Goal 5 — Domino labels carry the real milestone name

Justin believes the label under each domino comes from the milestone. It does not — `CLIENT_STAGES`
labels are hardcoded and `ProjectTrackerStage` is `{label, state, pct}` with nothing task-derived.
On a job whose schedule says "Master bath tile" the client sees the generic "Finishes".

- Extend `ProjectTrackerStage` with `detail: string | null` — the name of the representative task for
  that stage: prefer the stage's `type: "milestone"` task, else the current in-progress task, else the
  earliest incomplete one. Run it through the existing `clientTaskName()` scrubber so cost-code
  prefixes ("03-100 …") never reach the client.
- Render it as a small second line under the stage label. Null renders nothing — no layout shift.
- Keeps the domino tracker exactly as it is otherwise; Justin explicitly wants it retained.

This goal is independent of the AI work and can ship on its own.

---

## Goal 6 — The nightly cron

`/api/cron/progress-inference`, added to `vercel.json`. **02:00 America/Los_Angeles**, chosen because:

- it is after any Chat ingestion pass, so watermarks are fresh;
- it is outside dispatch hours — `dispatch-intent.ts:392` rejects publish for any task whose
  `updatedAt` moved, so a chatty daytime job would fail Richard's date/crew review for nothing more
  than a progress tick.

Requirements, all matching existing repo patterns:

- **Fail-closed auth** like `src/app/api/cron/drain-notifications/route.ts:15` — `VERCEL_ENV` set and
  `CRON_SECRET` missing or mismatched ⇒ 401.
- `?dryRun=1` runs full selection and reports without writing, plus a
  `PROGRESS_INFERENCE_DRY_RUN=1` env kill switch that **forces** dry-run and cannot be turned off by
  the query param (precedence enforced in the lib, not the route — same shape as
  `sendPaymentReminders`).
- **Bounded batches + lease** so overlapping runs cannot double-process; durable cursor is the
  snapshot's own `watermarks`.
- Real `(job, LA-local-date)` uniqueness key with spring-forward / fall-back tests.
- Per-project **feature flag**, Shop job first.
- Per-run cost ceiling; log projects skipped for budget rather than silently truncating.

---

## Goal 7 — Verification

`scripts/verify-progress-inference.ts` (test-first, DB-backed, `ALLOW_PROD_VERIFY` guard, fixture
cleanup), covering:

- **Watermark correctness**: evidence before the watermark is not re-read; an *edited* message past
  the cursor is still picked up; a project with no new evidence produces zero model calls and zero
  writes.
- **Rebuild**: a rejected proposal forces `rebuiltAt` to advance and clears the stale narrative.
- **Eligibility**: `"Complete"` is never proposed; photo-only evidence produces no proposal;
  cross-project evidence IDs are rejected; a second pending proposal is deduped.
- **CAS**: concurrent human pin + proposal apply — the human wins, the proposal does not clobber.
- **Invariant 2**: applying a stage proposal for the last stage still renders ≤99 while that stage is
  current (extends the existing `verify-portal-tracker.ts` boundary cases).
- **Timezone**: 7pm PDT evidence binds to the correct LA day, both DST boundaries.
- **RLS**: asserted the way `scripts/verify-task-materials.ts:97` does.

Plus: `npx tsc --noEmit` and `npm run build` clean; Codex review on the CAS write path, the watermark
logic, and the date handling; browser walk on **Shop**.

> Note: CI does **not** run `verify-*.ts` scripts — it runs lint, format, build, and Playwright
> against a throwaway Postgres. To actually gate this, add a step to the existing `playwright` job,
> which already has a Postgres service and a throwaway `DATABASE_URL`.

---

## Suggested ship order

| Step | Contents | Ships value alone? |
|---|---|---|
| A | Goal 5 (domino milestone names) | Yes — pure UI, no AI, no schema |
| B | Goal 4 (schedule-side override + provenance + `progressLockedAt`) | Yes — Richard gets the control where he works |
| C | Goal 1 (snapshot + watermarks) over MCP daily logs + task edits | Yes — a readable "where does this job stand" per project |
| D | arc PR-2 (Chat read rail) feeds the same watermarks | Yes |
| E | Goals 2 + 3 (photos, stage proposals, tray) behind per-project flag | Yes |
| F | Nightly cron (Goal 6) turned on for Shop | Yes |

A–C need no Chat integration at all, which matters because Chat is the piece with the most unknowns
(scope approval, space membership, Workspace admin policy). With `create_daily_log` now live, step C
has a real evidence source on day one rather than waiting for D.

---

## Open questions for Justin

1. **Photos to Gemini** — OK to send job-site photos to Google's vision API? (Goal 2.)
2. **Rebuild cadence** — weekly full rebuild per project, or only on rejection / low confidence?
   Weekly is safer against drift and costs more.
3. **Backward stage moves** — should the AI be allowed to propose them at all, or only ever propose
   forward and leave regressions entirely to humans?
4. **Who reviews** — is the tray Richard's alone, or do you want to see stage proposals before they
   reach a client-facing rail?
