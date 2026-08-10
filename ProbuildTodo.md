# ProBuild — Build Plan
_Last updated: 2026-07-17_

This file is the live backlog. History older than the current quarter lives in git history of this file.

---

## 🔥 Active / In Flight

- [ ] **Null-rate tax billing** — PR #202 (DRAFT, do not merge). Fixes direct-invoicing under-billing + milestone rounding drift, but blocked on a data-model decision: `taxRatePercent: null` is ambiguous between editor-created estimates (total stored tax-INCLUSIVE) and connector-created ones (tax-EXCLUSIVE). Decision needed: persist the displayed rate in the editor + backfill legacy rows. Details in the PR body.
- [ ] **Unified Property 3D** — spec drafted on `spec/20260717040628-unified-property-3d` (`.specs/20260717040628-unified-property-3d.md`), **awaiting Justin's review** before any implementation. One 3D model per property: room placement layer, whole-house RoomPlan scan intake, outdoor spaces, USDZ/AR Quick Look walk-through (builds on `src/lib/studio/usdz-generator.ts`).

## ⏳ Waiting on Justin

- [ ] Review the Unified Property 3D spec (above)
- [ ] Decide the null-rate tax ambiguity fix for PR #202 (above)
- [ ] QBO + Google Drive account setup for the money rail / receipt intake
- [ ] Decide on PR #117 (job costing: cost-code gate + WA compliance, 85 files, from May) — merge after rework, or close
- [ ] Decide on PR #85 (schedule color picker expansion, from May) — still wanted?

## 🟠 Next Up (engineering)

- [ ] **Finish Float → Decimal** — ~31 Float money/quantity fields remain in `prisma/schema.prisma` (47 already Decimal). Migrate via the raw-SQL script flow, never `prisma db push`.
- [ ] **Invoice idempotency under concurrency** — `Invoice.estimateId` isn't unique; two concurrent approvals can each create an invoice for the same estimate. Recheck-and-return inside the locked transaction (flagged by Codex on #202).
- [ ] **Feature-permission gating on AI routes** — the routes landed in #196 (ai-furnish, assign-phases) ship without per-plan gating; bring to session parity with the older ai-estimate routes.
- [ ] **Unauthenticated `/api/expenses/parse`** — pre-existing; needs an auth check (task chip exists).
- [ ] **Unlink scrape-website Vercel project** — it stamps a failing check on every probuild PR (task chip exists).
- [ ] **Dependabot #165** (53 npm bumps) — take after a stable prod deploy, not before.

## 🤖 AI Differentiation backlog (unchanged priorities)

Built: estimate gen, schedule gen, punchlist, daily-log enhance, mood boards, lead note summary, takeoff→estimate, receipt OCR pipeline, AI furnish (Room Studio).

- [ ] Lead Scoring (close probability, next actions) on `/leads/[id]`
- [ ] Predictive Cost at Completion on `/projects/[id]/costing`
- [ ] AI Change Order Detection from daily logs
- [ ] Schedule Risk Analysis on the Gantt
- [ ] AI Monthly Business Summary (owner report)
- [ ] Weather-aware scheduling, sub performance scoring, historical pricing engine

## 🟡 Medium / Someday

- [ ] Friendly numeric document IDs (`/projects/1042/...`) — safe while external URLs are few
- [ ] Consolidate CostCode/CostType (schema says CostType is canonical)
- [ ] Zod server-side validation coverage
- [ ] Budget vs actual / revenue trend charts (Recharts under-used)
- [ ] Reusable data table + pagination component

## ✅ Landed recently (2026 Q2–Q3)

- **2026-07-17**: money-path lock-order chain merged (#191 canonical Estimate→Invoice lock order + retry, #194 five remaining paths, #197 milestone-paid notification outbox); #201 consolidated bot a11y/perf PRs (ARIA labels + chart code-splitting); GH Actions bumps #4/#55; 20 stale bot/legacy PRs triaged and closed; prod deploy incl. #196 payload
- Money rail: QBO milestone invoices + payment pull-back crons, profitability report, QBO break-invoice-link recovery
- Signature storage → Supabase (SSRF allowlist), contract countersign flow
- Room Studio rebuild (procedural meshes, LiDAR intake, client share links)
- #196 recovered WIP: AI Furnish, USDZ export→AR Quick Look, assign-phases route, mobile estimate APIs, receipts-pipeline cutover, crash-log ingest (secret configured in Vercel)
- WA tax defaulting + geocode-on-save (#180); mobile lead intake rails
- E2E test grounds: CI postgres container, prod-DB guard, money-pipeline spec

---

### Standing rules (unchanged)
- Build must pass with 0 errors before push — auto-deploy is ON, so pushing/merging `main` ships to prod (see CLAUDE.md "Deploying to Vercel"). `vercel --prod` from the canonical checkout is for shipping ahead of a merge
- Schema changes via the PowerShell SQL script, then `prisma generate` from PowerShell
- Money-path changes: codex review + `e2e/money-pipeline.spec.ts` green
- Every feature answers: which remodeling role does this serve, and what can AI automate?
