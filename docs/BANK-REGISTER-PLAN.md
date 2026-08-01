# Bank Register in ProBuild — plan v2 (post Codex plan review)

Codex r1 verdict on v1: blocker — approved direction, rejected framing + entity-list fetch. All corrections
below are incorporated. QBO = accounting system & bank mirror; ProBuild = control center. Plaid deferred.

## Honest framing (Codex blocker, adopted verbatim)
The page is a **"QuickBooks WTB account register"**: posted QuickBooks entries affecting account 154,
fetched at [time]. It CANNOT see WTB transactions that are pending, excluded, unmatched, or absent from
QuickBooks, and does not prove bank clearance. No "In QuickBooks ✓" column (circular). True bank-side
completeness = monthly WTB CSV compare (phase 5 — Marge already exports bank CSVs today).

## Phase 1 — /automation/bank (BUILD NOW)
Fetch: QBO **GeneralLedger report** (spiked OK 2026-08-01: account=154 param works; rows carry txn type +
txn id + signed amount; July histogram: Expense 119, Journal Entry 6, Deposit 2, Payment 1, Sales Tax
Payment 1 — confirms entity-allowlist would miss types). No entity WHERE-by-account queries (unsupported).
- `src/lib/qbo-bank-register.ts`: report fetch + nested-row walker → BankRow {date, qbType, qbTxnId,
  docNum, name, nameId, amountCents(signed)}; skips balance/summary rows. Module cache keyed
  realm+account+range, TTL ~120s, fetchedAt surfaced, stale-on-QBO-error serves cache with stale flag.
  Range: default 30d, max 92d.
- Verdicts (server, batched):
  - Purchase-like rows (Expense/Check/Credit Card types) → Expense by qbPurchaseId: linked → project name
    via estimate + cent-exact amount check (mismatch flagged). Not linked → "Not in ProBuild job costs —
    open in QuickBooks to check" (NEVER "missing" — per Codex: absence of link ≠ missing; receipt-ingest
    path can create expenses without qbPurchaseId; sync lag exists). If newer than the last successful
    sync run, label "awaiting next sync".
  - Deposit/Payment/Transfer/Journal/Tax rows → typed informational verdicts (money in / transfer / etc.),
    no job-cost claims.
- Attachments: NOT bulk-fetched (no multi-id Attachable query exists). v1 shows the ProBuild receipt copy
  when the linked Expense has receiptUrl; QBO deep link covers the rest. Never cache TempDownloadUri.
- Deep links: purchase-like only (existing best-effort pattern) + copy-ID fallback everywhere else.
- UI: summary strip (in/out/linked/review counts), filters (type: checks with doc_num / electronic-other /
  deposits / transfers / journal; needs-review toggle), signed colored amounts, fetchedAt + refresh.
  NO "card vs ACH" split (not derivable — Codex).
- Rate safety: one report call per page render (cached); no per-row QBO calls.

## Phase 2 — shared classifier extraction (NEXT, small)
Extract the sync's overhead/equity/no-customer assembly into one pure classifier reusable by the register
so unlinked purchase rows can say "expected: owner draw / overhead" instead of generic review. (Codex:
today that logic lives inline in syncQboExpenses; loans are NOT classified anywhere — add a loan heuristic
there, not in the page.)

## Phase 3 — BankImage ingest (deposit photos + check images)
Hard requirements from review: table {id, source, sourceExternalId (unique with source — idempotency key),
kind enum, capturedAt, documentDate?, driveFileId unique, fileName, mime, normalizedCheckNumber?,
amountCents?, createdAt, updatedAt} + indexes (kind,capturedAt), (kind,normalizedCheckNumber); separate
confirmed-match link table {qbType, qbTxnId, confirmedBy, at}; separate BANK_IMAGE_INGEST_SECRET; strict
validation, size/rate limits, RLS in the migration script; Drive access via authenticated ProBuild proxy
re-checking financialReports (no anyone-with-link); ingestion via Drive API under a named identity (GAS as
jadkins@), not the desktop I:\ mount. Deposit photos: Google Chat Main Office (needs meta-server session
or OAuth connect — not available in this session). Check#: match on number+date+amount, manual confirm.
Photo proximity display labeled "Nearby photo candidate — unconfirmed" with date delta.

## Phase 4 — Missing-receipt affidavit
Marge clicks "Request affidavit" on an unlinked/receipt-less purchase row → prefilled PDF (existing /api/pdf
machinery) → EMAIL-first delivery v1 (Codex: SMS only after consent/expiry/one-time-token spec) →
mobile magic-token page (sub-portal token pattern) with project picker + signature (contract signature
component) → on submit: extract an attach-to-EXISTING-Purchase operation from qbo-receipt-attachments
(today it's private + tied to Purchase creation — must NOT ride intake rails or it creates a second
Purchase); save signed PDF to Drive receipt repo; upsert ProBuild expense receiptUrl.

## Phase 5 — WTB CSV compare (the real completeness check)
Upload/drop a WTB CSV export; diff against the register (amount+date+check#); report bank rows with no QBO
entry. Closes the "pending/absent from QBO" blind spot honestly.

## Standing constraints
- Claude never enters bank credentials (WTB creds shared in chat should be rotated). Check-image
  acquisition = Marge's monthly download or Justin-driven browser session.
- Register is read-only against QBO. No new writes to books.
