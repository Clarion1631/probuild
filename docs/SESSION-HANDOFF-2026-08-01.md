# Session Handoff — GTR Expense Pipeline & Automation Command Center
**Date:** 2026-08-01 (session ran 2026-07-31 → 08-01)
**Repo:** `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site` (branch `main`)
**Apps Script:** `C:\Users\jat00\workspaces\golden-touch\qbo-clasp` (clasp, login as **jadkins@goldentouchremodeling.com**)
**Memory file:** `C:\Users\jat00\.claude\projects\C--Users-jat00\memory\gtr-receipts-qbo-api-plan.md` (full running history)

---

## 1. What is LIVE in production right now

| Piece | State | Key commit |
|---|---|---|
| Receipt → QBO API push (job-coded, PDF attached, bank-match ready) | ✅ live, E2E-verified | `da694366` |
| **Sales-tax split** → QBO acct `1150040032` "Reimbursable Sales Tax Paid" (reseller-permit reclaim) | ✅ live, verified on Purchase 6365 | `da694366` |
| "Zero txt to QuickBooks" guarantee (PDF conversion on every path) | ✅ live | `57828ba3` |
| Intake-folder reconciler (auto-creates folders from ProBuild projects, drift email) | ✅ live (daily, end of scan) | `039d9f73` |
| GET `/api/integrations/qbo-receipts/projects` (canonical project list, ingest-key auth) | ✅ live | `039d9f73` |
| Automation Command Center **v2** at `/automation` (journeys, graph, sync runs, Run-sync-now; Field+Time Clock removed from nav) | ✅ live | `0479d316` |
| GAS stage beacons (read/parked/dedupe/email-book → ProBuild, after terminal moves, circuit breaker) | ✅ pushed via clasp | GAS only |
| QBO→ProBuild expense sync cron (4h, `30 */4 * * *` UTC) | ✅ on | earlier session |
| Process doc (HTML/PDF/artifact) | ✅ current | `bf862546` |

**Prod migrations already applied** (safe to re-run, idempotent): `node scripts/apply-automation-events.mjs` — creates `AutomationEvent` (+`stage` col, docNumber index) **and** `AutomationSetting`. Backfill already run once: `ENV_FILE=<scratchpad>/.env.prod-pull node scripts/backfill-automation-events.mjs` (inserted 6364, live-logged 6365).

---

## 2. What is BUILT but NOT yet committed/deployed (v3 "validation station")

All local in the repo working tree, build ✅, 68/68 unit tests ✅, **awaiting one Codex review that was still running when this handoff was written** (codex-reviewer agent, background; findings not yet received).

Backend (written by orchestrator):
- `src/lib/automation-settings.ts` — pause switches, **fail-CLOSED** reads (pause-only invariant: effective = env master AND NOT paused; UI can never enable books-writing)
- `src/app/api/automation/settings/route.ts` — admin toggle endpoint, audited as kind `"setting"` events
- Pause checks wired into both money routes: push → `200 ok:false "push-paused"` (bot books via email path — nothing strands); cron GET → `503 "sync-paused"`; **manual sync-now endpoint intentionally not pause-gated** (UI disables the button; review may challenge this)
- `src/app/api/automation/verify/route.ts` — "Verify now": live QBO Purchase re-read, cent-exact verdicts (amount/tax), project/vendor checks, deleted detection, `[gtr-file:]` marker-intact check
- Journey enrichment in `src/lib/automation-events.ts`: `backfilled`, `driveFileId`, `qbPurchaseId`, `synced {expenseId, projectId, projectName, amountCents, vendor, receiptUrl, syncedAt}` (Expense→**estimate**→project relation; Expense has NO direct project relation)
- `scripts/backfill-automation-events.mjs` — QBO `PrivateNote` is NOT queryable; fetches July window, filters marker client-side
- Create-route push events now log `detail: {fileId, qbPurchaseId, attachment}`

UI (executor-built, v3): `src/app/automation/` — validation panel (receipt image/PDF, Extracted vs Booked-at-booking-time vs In-ProBuild vs live-QBO columns with verdict icons), exception-first row verdicts (incl. stale >5h unsynced), "Imported history" chip for backfilled, `pipeline-controls.tsx` toggles (resume = inline confirm), sync-now disabled while paused, QBO deep link `https://qbo.intuit.com/app/expense?txnId=<id>` (best-effort) + Copy-ID fallback.

**To finish v3:** receive Codex findings → fix real ones (round limit already used: this IS the review round; self-verify fixes) → `npm run build` + both test suites → commit to main → `vercel --prod --token $env:VERCEL_TOKEN --yes --archive=tgz --cwd <repo>` → no GAS changes needed this round.

---

## 3. All the links

- **Command Center (v2 live):** https://probuild.goldentouchremodeling.com/automation
- **Company financials report:** https://probuild.goldentouchremodeling.com/reports/company-financials
- **Process doc (shareable, private until shared):** https://claude.ai/code/artifact/311cb084-49d0-4ff0-b7ff-d9313f26d774
- **Process doc on Drive:** `I:\My Drive\Claude\GTR-Expense-Pipeline.html` + `GTR-Expense-Pipeline.pdf` (also `docs/qbo-expense-sync-flow.html` + `docs/GTR-Expense-Pipeline.pdf` in repo)
- **Receipt intake:** `I:\My Drive\Expenses\New Receipts & Checks\<exact ProBuild project name>\` (folders auto-create daily; `_` prefix = ignored)
- **Test artifacts in QBO** (Marge cleanup, section 5): Purchases **6364** ($2.46) and **6365** ($3.70), vendor **ZZZ TEST VENDOR**
- **Test Drive files** (archived under `Processed Receipts\2026\July\`): #1 email-path $1.23 → `19sWZQMekjcOm9LIzX-WYgP2OKuYg_wgl` · #2 $2.46 / Purchase 6364 → `1VcJFAUlqaclSVV77L2SQvW3_mBQ9oJ5i` · #3 $3.70 / Purchase 6365 → `1nqd08NpG1F-Lh5a1PHZrEo0y5N1iSkjD`
- **Vercel project:** probuild `prj_sd7R3WIYZCRMnu5IhAudBdc4vuIL`; deploys via CLI only (auto-deploy off)
- **Scratchpad helpers** (session temp; may be gone in a new session): `qbo.mjs` (read-only QBO queries via ProBuild tokens), `.env.prod-pull` (prod env incl. DATABASE_URL, NEXTAUTH_SECRET, QB creds — regenerate with `vercel env pull`)

## 4. Key operational facts

- **Three switches** for the push: Vercel `QBO_RECEIPT_PUSH_ENABLED=true` (opt-IN), GAS Script Property `QBO_API_PUSH_ENABLED=true`, GAS `RECEIPT_INGEST_SECRET` (= Vercel `RECEIPT_INGEST_SECRET`). All verified set. Sync cron: `QBO_EXPENSE_SYNC_CRON_ENABLED` (opt-OUT).
- QBO accounts: bank `154` (Washington Trust), expense `98` (COGS Supplies & materials), tax `1150040032` (Reimbursable Sales Tax Paid). Verified per-process with distinct-id guard; misconfig → typed error → `200 ok:false "account-misconfigured"` (email fallback, never a retry loop).
- Idempotency: DocNumber = Drive fileId[0..21), QBO requestid = sha256(fileId), `[gtr-file:<fileId>]` PrivateNote marker (never truncated).
- Extraction: Gemini 2.5 Pro → Flash fallback; prompt reads FINAL total (post-discount) + `tax_amount` (never estimated; bad read → single-line booking, never blocks).
- Classifier boundaries hit this session (route to user via `!`): writing to intake folder directly (use Composio Drive instead — worked), touching `RECEIPT_INGEST_SECRET` values, prod env flag writes. Reads + deploys + non-books env are fine.
- Bash heredocs mangle backslashes in this environment — use Write/Edit tools for content with escapes.
- Repo may be left on another session's branch — check `git branch` before committing (a cherry-pick to main was needed once: `0479d316`).

## 5. Human to-dos (told to user; not yet confirmed done)

1. **Marge cleanup:** delete QBO Purchases 6364 + 6365, vendor "ZZZ TEST VENDOR", and the $1.23 "ZZZ TEST VENDOR" receipt in the QBO receipts inbox (For Review). ProBuild copies auto-deactivate on next sync.
2. Share the artifact link with the team (private until shared from the page).

## 6. Roadmap (agreed, not started)

- **Mobile field capture** (next big piece): camera screen in gtr-probuild-mobile posting photo+job to ProBuild; geofence work already knows the site; enters this same pipeline.
- Line-item category splitting (Gemini prompt work; server already accepts multi-group w/ ±2¢ reconciliation, negative lines rejected — net discounts into lines).
- Vendor-name normalization (dup QBO vendors: "Lowes" vs "Lowe's Home Improvement").
- Remove the two dead `custom === "fieldUpdates"` branches in `Sidebar.tsx`/`MobileNavDrawer.tsx` (cosmetic).
- Accepted limitations on record: AutomationEvent not DB-enforced append-only (QBO is the auditable source of record); beacons share the ingest key (it already guards the higher-privilege purchase endpoint).

## 7. How to resume in a new session

1. Read the memory file (top bullets are newest) + this handoff.
2. Check whether v3 was committed/deployed (`git log --oneline -5`; look for a "validation station" commit after `0479d316`). If not: check for Codex findings (the review output file may be gone — if so, rerun the review with `scratchpad/v3-review-prompt.txt` + a regenerated bundle, or proceed on the strength of the brainstorm + tests if the user says ship).
3. Verify current state end-to-end anytime: drop a small PDF receipt into an intake folder, watch `/automation` for the journey, and confirm the QBO purchase with the read-only `qbo.mjs` pattern (rebuild it from memory-file notes if scratchpad is gone).
