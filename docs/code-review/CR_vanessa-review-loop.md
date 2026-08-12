# Code Review: feat/vanessa-review-loop

- Plan: docs/plans/vanessa-review-loop-plan.md (Codex plan review: 4 rounds → APPROVED)
- Reviewer: Codex CLI, gpt-5.6-sol @ xhigh, read-only sandbox
- Rounds: 3 (start + 2 resumes) → **APPROVED** 2026-08-12
- Independent checker verification: PASS (build + 3 suites re-run, diff audited point-by-point)
- Final state: commits 4290d74, 0457db4, 9994d3b, 3a3cf7e, b1681ff · 174/174 unit,
  45/45 qbo-expense-sync, 37/37 qbo-receipt-push, tsc 0, build 0, lint 0

## Findings and resolutions

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | Major | Digest read project from top-level Purchase.CustomerRef; bot stores it per line | Line-level CustomerRef extraction, deduped, comma-joined (automation-digest.ts) |
| 2 | Major | Digest delivery failure returned HTTP 200 | digestResultResponse maps ok:false → 500 (route.ts) |
| 3 | Major | Terminal-failure alert result ignored; never retried | DigestRun.alertSent/lastError; every tick retries unalerted terminal failures, window-independent, same idempotency key |
| 4 | Major | Purchase changed after review could not be re-reviewed | Stale stamp + Re-review button submitting current SyncToken (journey-list.tsx) |
| 5 | Minor | "Bot read" showed journey-wide values overwritten by later events | Per-event vendor/amount/project captured and rendered |
| 6 | Major | Failed pending-alert retry still yielded ok:true → 200 | runTodaysDigestWork() split out; failed retry returns ok:false naming the stuck date → 500 |

## Deploy checklist (not yet done)
1. ~~Provision Vercel prod env: `VANESSA_EMAIL`, `DIGEST_CC_EMAIL`, cron secret if new~~ — moot, see below
2. Run `scripts/apply-purchase-reviews.mjs` against prod (additive)
3. Optionally `scripts/backfill-qbo-create-time.mjs`
4. Decide merge order vs feat/unified-money-register, merge, deploy per CLAUDE.md

## Goal 1 removed 2026-08-12 by owner decision — no email; review happens in the command center
Justin decided against the daily digest email. Goal 1 (findings #1, #2, #3, #6 above — all the
digest-specific ones) and everything it touched were deleted wholesale from
`feat/vanessa-review-loop`: `src/lib/automation-digest.ts`, `src/app/api/automation/digest/route.ts`,
the hourly `vercel.json` cron entry, the `DigestRun` model + `scripts/apply-digest-runs.mjs`, the
digest test files, and the now-unused `idempotencyKey` addition to `src/lib/email.ts`. Goals 2/2b
(audit timeline, `PurchaseReview` stamps, `qboCreateTime`) and Goal 3 (ops guide section) are
unaffected and remain exactly as reviewed above.

**The removal commit was a mechanical deletion, not re-reviewed by Codex** — it only deletes
code and reverts test/doc references to it; no new logic was introduced. See
`docs/plans/vanessa-review-loop-plan.md` for the same note against Goal 1 there.
