# Should we ingest Probuild into Cognee?

> **File location:** `C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site\COGNEE_INGEST_DECISION.md`
> **Status:** Recommendation — not yet executed
> **Date:** 2026-04-10

## Context

You're hitting errors while working on Probuild and suspect the AI lacks "full picture" context. You're asking whether ingesting the codebase into Cognee (the knowledge-graph MCP currently running at `http://localhost:8000/sse` for Vista/Viewpoint SQL schema lookups) would fix that.

## Short answer

**Don't do a full-repo ingest. Refactor the two hotspot files first. Then, if you still want semantic navigation, run a *scoped* four-file Cognee pilot to decide empirically — not theoretically.**

This recommendation went through peer review via Codex; corrections are listed at the bottom.

## What's actually in Probuild right now

From a fresh survey:

- **397 TS/TSX files, ~58K LOC** — substantial but not beyond Grep/Explore range.
- **`src/lib/actions.ts` — 4,640 lines.** One monolithic server-actions file. **128 files import `@/lib/actions`**, so any split needs a compatibility layer.
- **`src/components/EstimateEditor.tsx` — 2,012 lines.** Where bugs like `FIX_PORTALPAYBUTTON_TOTAL.md` (Prisma `Decimal` string-concat showing `$272,078.88` instead of `$2,798.88`) live.
- **`prisma/schema.prisma` — 1,362 lines.** Fine as-is.
- **`src/lib/prisma-helpers.ts`** — hosts `safeEstimate*` helpers that `actions.ts` depends on; any code-graph exercise must include it.
- **CLAUDE.md already has**: VISION.md, DESIGN_SYSTEM.md, ProbuildTodo.md as reference context. Duplication risk is real.
- **Sentry is configured** (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`) and `sentry-cli` is in your global toolbelt, but not in your day-to-day debug loop.

## Why full-repo Cognee ingest is the wrong fix *here*

Not because Cognee is weak — its code-graph mode builds real symbol tables, import edges, and call/dependency links. The arguments are narrower:

| Factor | Why it bites for Probuild |
|---|---|
| **ROI vs. existing tools** | Claude Code's Grep/Glob/Read/Explore already answers 90% of "where is X defined / used" at 58K LOC. You'd be paying ingest+maintenance cost for the last 10%. |
| **Staleness — conditional** | Only a problem if the index runs unattended. You have no CI hook to re-ingest on push/merge. Until you build one, the graph drifts within a day of first commit. |
| **Duplication** | Your four reference docs already encode product shape. A graph of the source would largely re-represent what's already in the system prompt. |
| **Not the bottleneck** | The AI's errors in Probuild aren't coming from "couldn't find the file." They're coming from *loading a file that's too big to reason about in one pass*. Semantic indexing doesn't fix that — splitting the file does. |

## The actual root cause of the errors

`actions.ts` at 4,640 lines and `EstimateEditor.tsx` at 2,012 lines. When the AI has to read either file to make a change, it burns most of its working memory on the file itself, leaving little room for the change. That's how bugs like the `$272,078.88` Decimal-concat slip through.

## Recommended approach (ordered)

### Step 0 — Unblock the refactor by fixing CLAUDE.md *first*

This is the sharpest finding from peer review. Your own `CLAUDE.md` currently says:

> Server actions go in `src/lib/actions.ts` by default; existing split files (client-actions.ts, lead-note-actions.ts, subcontractor-actions.ts) are legacy — don't add new ones

That rule was written when `actions.ts` was small. Any split you do today will be reverted by the next AI session following the old rule. **Edit `CLAUDE.md` first** to authorize a new convention, e.g.:

> Server actions live in `src/lib/actions/<domain>-actions.ts`. `src/lib/actions.ts` is a barrel re-export for backwards compatibility with the 128 existing imports — do not add new code to it.

### Step 1 — Split `src/lib/actions.ts` by domain, behind a barrel

- Create `src/lib/actions/estimate-actions.ts`, `invoice-actions.ts`, `lead-actions.ts`, `project-actions.ts`, `client-actions.ts`, etc.
- **Keep `src/lib/actions.ts` as a barrel** that re-exports from the new files — the 128 existing importers keep working with zero diff.
- Each domain file targets < 800 lines.

**Hard constraints when splitting a `"use server"` module** (peer review flagged these — they're real, not blockers):
- Every export must be an **async function**. No constants, types, or class exports at the module top level — those cause a Next.js build error under `"use server"`. Move shared types to a separate `*.types.ts` file.
- **Auth/authorization stays per-action** — don't hoist permission checks to module load time. `src/lib/permissions.ts` calls must live inside each action body.
- **`revalidatePath` / `revalidateTag` stay co-located with each mutation.** Don't centralize them.
- Acceptance test: `npm run build` with 0 errors, then smoke-test the affected flows (estimate create/edit, invoice create, lead conversion).

### Step 2 — Break up `EstimateEditor.tsx` as part of CONTRACT_EDITOR_REDESIGN

You already have `CONTRACT_EDITOR_REDESIGN.md` drafted. Use that redesign as the forcing function to split EstimateEditor into:
- `src/components/estimate-editor/LineItemsTable.tsx`
- `src/components/estimate-editor/TermsAndConditions.tsx`
- `src/components/estimate-editor/TotalsPanel.tsx`
- `src/components/estimate-editor/SigningFields.tsx`

Fix `FIX_PORTALPAYBUTTON_TOTAL.md` (the Decimal bug) as part of this pass — the cleaner TotalsPanel is where the concat lives.

### Step 3 — Wire Sentry into your debug loop, not Cognee

For the "lots of errors" part of your question, the right tool is already installed:

```bash
sentry-cli issues list --org golden-touch-remodeling --project probuild --output json
```

Feed the top issue's stack trace directly into the AI. That's the "full picture" you actually need — scoped to the failing code path, not the whole repo.

### Step 4 — *Then* run a scoped Cognee pilot to decide empirically

After Steps 1–3, if you still want to know whether Cognee earns its keep, ingest only these four files:

- `prisma/schema.prisma`
- `src/lib/actions.ts` (post-split barrel — or pick one domain file)
- `src/components/EstimateEditor.tsx` (post-split — or pick one sub-component)
- `src/lib/prisma-helpers.ts`

Then judge it against a real task such as: *"Where does the Estimate.totalCents Prisma field flow through mutations into the UI?"* If the answer is faster/more complete than an Explore-agent run, expand scope. If not, you've spent 30 minutes instead of ingesting 397 files.

**Caveat**: a four-file scoped ingest has incomplete edges to everything else in the repo, so treat it as a navigator, not a complete call graph.

**Optional**: if you want Cognee for docs only (its real sweet spot — unstructured, slow-changing text), ingest the repo's `.md` files (VISION, DESIGN_SYSTEM, ProbuildTodo, HANDOFF, PROJECT_GUIDE, STRIPE_ESTIMATE_PAYMENT, QA_REPORT_2026-04-07). ~8 files, low staleness, clear win.

## Critical files referenced

- `CLAUDE.md` (Step 0 — update the server-actions rule **before** any code change)
- `src/lib/actions.ts` (4,640 lines — split into `src/lib/actions/` + barrel)
- `src/components/EstimateEditor.tsx` (2,012 lines — split during CONTRACT_EDITOR_REDESIGN)
- `src/lib/prisma-helpers.ts` (include in the scoped Cognee pilot)
- `prisma/schema.prisma` (1,362 lines — unchanged)
- `CONTRACT_EDITOR_REDESIGN.md` (already drafted; aligns with Step 2)
- `FIX_PORTALPAYBUTTON_TOTAL.md` (Decimal bug — fix as part of EstimateEditor breakup)
- `src/lib/permissions.ts` (auth checks that must stay inside each split action body)

## Verification

This is a recommendation, not code, so verification = decision gates:

1. **Agree the root cause is the two god files + the CLAUDE.md rule that prevents splitting them** — not missing context infra.
2. **Pick which fix to build first** — Step 1 (split `actions.ts`) is the highest-leverage. I'd scope it as its own plan with `npm run build` + smoke-test of estimate/invoice/lead flows as the acceptance criteria.
3. **Optional follow-up**: scoped 4-file Cognee pilot (Step 4) — own plan, ~30 min of work, decides the Cognee question empirically instead of theoretically.

## Peer-review corrections applied

For transparency, the first draft of this recommendation had several errors that Codex peer review caught:

- Claimed Cognee is "NLP-based similarity search" — **wrong**, it has real code-graph mode. Reframed as an ROI argument.
- Had stale line counts (5,205 / 2,097 / 64K LOC) — **corrected** to 4,640 / 2,012 / 58K.
- Missed the `CLAUDE.md` rule that actively forbids splitting `actions.ts` — **added as Step 0**.
- Missed the 128-importer blast radius — **added the barrel re-export requirement**.
- Didn't spell out the `"use server"` split constraints — **added** (async-only exports, per-action auth, co-located revalidation).
- Framed refactor vs. Cognee as either/us either/or — **corrected** to "refactor first, scoped pilot second."
