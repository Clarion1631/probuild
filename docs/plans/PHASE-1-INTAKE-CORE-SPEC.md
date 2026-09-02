# Phase 1: Intake Core — Implementation Spec

Date: 2026-09-01. Parent plan: `docs/plans/RECEIPT-PIPELINE-V2-PLAN.md` (Phase 1 row).
Planner output for the executor: build exactly this; do not guess.

**Concurrency note:** another agent is editing `src/lib/quickbooks.ts` and
`src/app/api/integrations/qbo-receipts/create/route.ts` (adding fetch timeouts). Do NOT
modify either file. `QBTimeoutError` already exists in `src/lib/quickbooks.ts` (~line 31)
— import it. Reuse `createQBReceiptPurchase` from `src/lib/qbo-receipt-push.ts` by direct
import; never copy its logic and never call the HTTP route from the worker.

## Verified code facts

- The one QBO write core is `createQBReceiptPurchase(tokens, input, deps?)` in
  `src/lib/qbo-receipt-push.ts` (~462). Idempotency = DocNumber `input.fileId.slice(0,21)`
  + PrivateNote marker `[gtr-file:<fileId>]` + QBO requestid. Result union (~158):
  `ok:true {qbPurchaseId, alreadyExists}` | `ok:false {reason}`. Terminal error classes:
  `QboPurchaseFaultError`, `QboAccountConfigError`, `QboVendorDuplicateError`.
- `Expense` (prisma/schema.prisma:580) REQUIRES `estimateId` (FK, cascade); `qbPurchaseId`
  is `@unique`; has `costCodeId?`, `receiptUrl?`, `vendor?`, `date?`, `status` default "Pending".
  No Drive-file-id column on Expense; `AutomationEvent.driveFileId` exists (:2440).
- v1 ingest precedent: `src/app/api/integrations/receipt-ingest/route.ts` resolves the
  "primary estimate" as the project's latest (`orderBy createdAt desc, take 1`, line 69) and
  matches projects/cost codes via `matchProjectByName` / `matchCostCode` (`src/lib/project-match.ts`).
- Gemini: no shared lib helper; callers hit `generativelanguage.googleapis.com` REST with
  `GEMINI_API_KEY`. Current working text model is `"gemini-3.5-flash"`
  (`src/lib/daily-log-task-match.ts:26`). The Apps Script model list
  (`qbo-clasp/runReceiptAutomation.js:115`) is stale (2.5-era) — do not port it verbatim.
- Storage: `getSupabase()` + `STORAGE_BUCKET="project-files"` (PUBLIC) in `src/lib/supabase.ts`;
  `SECURE_BUCKET="secure-docs"` (PRIVATE) + `secure:` ref scheme + `resolveDocUrl()` /
  `downloadDocBytes()` in `src/lib/secure-storage.ts`. Receipts go in the private bucket.
- Server-side Drive access exists (`src/lib/lead-drive.ts`) but uses a NextAuth Google OAuth
  refresh token (user identity), not a service account. No service-account Drive credential
  exists anywhere in `src/`.
- Apps Script dedup (`qbo-clasp/runReceiptAutomation.js`): strong key `date|ref` (:1558, built
  only when the OCR date is valid AND `refLooksReal_` :1581 passes), weak key
  `canonicalVendor|date|amount|"amt"` (:1598), `VENDOR_ALIASES` (:1609), `sanitize()` (:1478),
  `cleanMoney()` (:1519), placeholder list (:1578). Gemini prompt: :1099–1133. Tax-split group
  building: `qbo-clasp/sendToQBOviaAPI.js:129–178`.
- Mobile auth: `authenticateMobileOrSession(req)` in `src/lib/mobile-auth.ts`. Proxy
  (`src/proxy.ts`): Bearer passes only for `MOBILE_AUTHENTICATED_ROUTE_PATTERNS`; machine
  endpoints with their own shared secret use the exact-match public bypass (precedent:
  `api/office-tasks/ingest`, :47–50). `/api/integrations/*` and `/api/cron/*` are excluded
  from the proxy matcher entirely (:228).
- Cron auth convention (fail closed): `src/app/api/cron/drain-notifications/route.ts:15–19`.
  pgbouncer forbids session advisory locks (`src/lib/review-alert-rollout.ts:8`); use
  `pg_try_advisory_xact_lock` inside a short claim transaction (pattern:
  `src/lib/qbo-expense-sync.ts:572`, `src/app/api/automation/sync-now/route.ts`).

## 1. Goals and acceptance criteria

1. **Schema**: `ReceiptIntake` live in prod and in `prisma/migrations/`.
   Verify: `node scripts/apply-receipt-intake.mjs` twice (second run all "already exists");
   CI `migrations` job green; `prisma generate` + `npx tsc --noEmit` clean.
2. **Intake endpoint** `POST /api/receipts/intake` accepts session, mobile Bearer, and
   `x-receipt-intake-secret`; idempotent on `sourceRef`.
   Verify: e2e API test posts the same payload twice → same `id`, one DB row; no-auth AND
   bogus-session-cookie requests both 401 (getclients-auth-gate lesson).
3. **Reader** `readReceipt()` ports the v3.6 prompt + phase suggestion + `tax_amount` +
   `doc_type` multi/non_receipt. Verify: node:test with an injected fetch asserts the prompt
   carries the load-bearing sentences (final-amount rule, never-estimate-tax rule, multi
   rule) and that responses parse into `ReadResult`.
4. **Dedup + routing** ports the Apps Script keys faithfully. Verify: fixture table (§9)
   and `routeState` truth table pass under node:test.
5. **Booking** creates the QBO Purchase via `createQBReceiptPurchase`, then the `Expense`,
   sets `qbPurchaseId`; retry queue with backoff. Verify: node:test with injected fake
   `createPurchase` covers success, terminal fault → NEEDS_REVIEW, `QBTimeoutError` → retry
   per backoff table; project-without-estimate → NEEDS_REVIEW reason `no-estimate`.
6. **Cron** `/api/cron/receipt-intake-worker` every 5 min, ≤10 rows/run, non-overlapping.
   Verify: `vercel.json` entry; claim-query unit test (two sequential claims never return
   the same row); manual `curl -H "Authorization: Bearer $CRON_SECRET"` on prod returns
   `{processed, byState}`.
7. **Dry-run shadow mode** default ON: rows read+dedup+route but never book. Verify: with
   `RECEIPT_INTAKE_DRYRUN` unset, worker test proves zero `createPurchase` calls and zero
   Expense rows.
8. **Build**: `npm run build` 0 errors; Codex review of the money path before merge.

## 2. Schema

Repo convention: `state` is a `String` with a SQL CHECK, not a Prisma enum (matches
`BankLine.state`, `Expense.status`). Prisma model (add to `prisma/schema.prisma`):

```prisma
model ReceiptIntake {
  id        String  @id @default(cuid())
  source    String  // mobile | email | drive | chat | web
  sourceRef String  @unique // "drive:<fileId>" | "email:<gmailMsgId>:<sha16>" | "mobile:<uploadId>" | "chat:<messageName>:<n>" | "web:<uuid>"
  state     String  @default("RECEIVED") // RECEIVED READ NEEDS_JOB NEEDS_REVIEW BOOKING BOOKED ARCHIVED DUPLICATE VOID NON_RECEIPT
  dryRun    Boolean @default(true)
  stateReason String? // no-estimate | multi-doc | zero-total | weak-dup:<id> | strong-dup-amount-mismatch:<id> | qbo-fault:<code> | max-retries | push-disabled | push-paused

  projectId  String?
  project    Project?  @relation(fields: [projectId], references: [id], onDelete: SetNull)
  costCodeId String?
  costCode   CostCode? @relation(fields: [costCodeId], references: [id])
  suggestedCostCodeId String?
  suggestedConfidence Float?
  createdById String?
  createdBy   User?   @relation(fields: [createdById], references: [id], onDelete: SetNull)

  // file (Supabase secure-docs, private)
  storagePath String  // receipts/intake/<id>.<ext> in the `receipt-intake` bucket
  // When the signed upload URL /intake/start last issued stops working. The
  // sweeper uses THIS, not createdAt: a row whose URL was re-issued is older
  // than its lease, and judging it on row age parked receipts whose own upload
  // link was still live. Null on rows that never had a signed URL.
  uploadUrlExpiresAt DateTime?
  // Bumped every time a signed upload URL is issued, and EMBEDDED IN THE PATH
  // that URL points at (`receipts/intake/<id>.v<n>.<ext>`). /start claims the
  // new lease in ONE checked update before it signs anything; every park,
  // publish and reject fences on the version it observed. That is what makes a
  // sweep verdict about v1 land on nothing once the client has resumed on v2.
  uploadLeaseVersion Int       @default(0)
  fileName    String?
  mimeType    String
  fileSize    Int
  fileSha256  String

  // read results (cents, like AutomationEvent)
  vendor     String?
  txnDate    DateTime? @db.Date
  totalCents Int?
  taxCents   Int?
  docType    String?   // receipt | check | multi | non_receipt
  refNumber  String?   // cleaned invoice #, or "Check<num>" for checks
  memo       String?
  readJson   String?   // raw Gemini JSON, audit only
  readAt     DateTime?

  // dedup
  dedupStrongKey String?
  dedupWeakKey   String?
  duplicateOfId  String?

  // booking + archive
  qbPurchaseId       String?
  expenseId          String?  @unique
  archiveDriveFileId String?
  attempts    Int       @default(0)
  lastError   String?
  nextRetryAt DateTime?
  bookedAt    DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // NOTE: a partial UNIQUE index on dedupStrongKey (WHERE state NOT IN
  // ('DUPLICATE','VOID') AND dedupStrongKey IS NOT NULL) exists in SQL only —
  // Prisma cannot represent partial indexes and silently drops them (CLAUDE.md,
  // baseline notes). Keep this comment; never regenerate it away.
  @@index([state, nextRetryAt])
  @@index([projectId])
  @@index([dedupWeakKey])
  @@index([createdAt])
}
```

Add back-relations `receiptIntakes ReceiptIntake[]` on `Project`, `CostCode`, `User`.

`scripts/apply-receipt-intake.mjs` (additive, idempotent, `$executeRawUnsafe` over the
pooler — same shape as prior `scripts/apply-*.mjs`) and byte-identical DDL in
`prisma/migrations/<ts>_receipt_intake/migration.sql`:

```sql
CREATE TABLE IF NOT EXISTS "ReceiptIntake" (
  "id" TEXT PRIMARY KEY, "source" TEXT NOT NULL, "sourceRef" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'RECEIVED', "dryRun" BOOLEAN NOT NULL DEFAULT true,
  "stateReason" TEXT, "projectId" TEXT, "costCodeId" TEXT, "suggestedCostCodeId" TEXT,
  "suggestedConfidence" DOUBLE PRECISION, "createdById" TEXT,
  "storagePath" TEXT NOT NULL, "fileName" TEXT, "mimeType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL, "fileSha256" TEXT NOT NULL,
  "expectedSha256" TEXT, "uploadUrlExpiresAt" TIMESTAMP(3),
  "uploadLeaseVersion" INTEGER NOT NULL DEFAULT 0,
  "vendor" TEXT, "txnDate" DATE, "totalCents" INTEGER, "taxCents" INTEGER,
  "docType" TEXT, "refNumber" TEXT, "memo" TEXT, "readJson" TEXT, "readAt" TIMESTAMP(3),
  "dedupStrongKey" TEXT, "dedupWeakKey" TEXT, "duplicateOfId" TEXT,
  "qbPurchaseId" TEXT, "expenseId" TEXT, "archiveDriveFileId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT, "nextRetryAt" TIMESTAMP(3),
  "bookedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReceiptIntake_state_check" CHECK ("state" IN ('RECEIVED','READ','NEEDS_JOB',
    'NEEDS_REVIEW','BOOKING','BOOKED','ARCHIVED','DUPLICATE','VOID','NON_RECEIPT'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_sourceRef_key" ON "ReceiptIntake"("sourceRef");
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_expenseId_key" ON "ReceiptIntake"("expenseId");
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_dedupStrongKey_active_key"
  ON "ReceiptIntake"("dedupStrongKey")
  WHERE "dedupStrongKey" IS NOT NULL AND "state" NOT IN ('DUPLICATE','VOID');
CREATE INDEX IF NOT EXISTS "ReceiptIntake_state_nextRetryAt_idx" ON "ReceiptIntake"("state","nextRetryAt");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_projectId_idx" ON "ReceiptIntake"("projectId");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_dedupWeakKey_idx" ON "ReceiptIntake"("dedupWeakKey");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_createdAt_idx" ON "ReceiptIntake"("createdAt");
-- FKs guarded with DO $$ ... IF NOT EXISTS (pg_constraint) blocks, per prior apply scripts:
--   projectId  -> "Project"(id)  ON DELETE SET NULL
--   costCodeId -> "CostCode"(id)
--   createdById-> "User"(id)     ON DELETE SET NULL
--   expenseId  -> "Expense"(id)  ON DELETE SET NULL
```

Run the apply script against prod BEFORE merging (CLAUDE.md pre-deploy rule #2):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_KEY=...   node scripts/apply-receipt-intake.mjs --yes --expect-db postgres --expect-host <host>
```

It does BOTH halves of the rollout and verifies each:

1. **Schema** — additive, idempotent DDL, then a shape check (every column, the CHECK
   constraint, the FKs, and the partial unique index verified by its DEFINITION, not its
   name).
2. **Storage** — creates the private `receipt-intake` bucket, or verifies the existing one.
   It exits nonzero on a different file-size limit, a different MIME allow-list, or a public
   bucket, and never rewrites one.

Both halves are safe to re-run. The bucket step needs `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY`; without them the script refuses rather than skipping it, because a
missing bucket policy is invisible until a 400 MB object is already stored.

## 3. Endpoint contracts

### POST /api/receipts/intake  (new file `src/app/api/receipts/intake/route.ts`)
- **Proxy**: add exact-match `/api/receipts/intake` to the public bypass set in
  `src/proxy.ts` (precedent + comment style of `api/office-tasks/ingest`: machine callers
  need a clean 401, not a /login redirect; exact match only, no descendants). The handler
  is then the sole auth boundary and MUST fail closed.
- **Auth, in order**: (1) `x-receipt-intake-secret` header equals env
  `RECEIPT_INTAKE_SECRET` — 401 when the env var is unset (never fail open; a NEW secret,
  not `RECEIPT_INGEST_SECRET`, so v1 and v2 rotate independently); else
  (2) `authenticateMobileOrSession(req)`; else 401.
- **Body**: multipart (`file`, `source`, `projectId?`, `costCodeId?`, `sourceRef?`,
  `threadName?`) or JSON `{fileBase64, mimeType, fileName?, source, sourceRef?, projectId?,
  costCodeId?, threadName?}`. `source` in mobile|email|drive|chat|web. Machine callers MUST
  send `sourceRef`; session/Bearer callers get `web:<uuid>` / `mobile:<uuid>` minted
  server-side. Max 8 MiB (QuickBooks' attachment ceiling). Accept pdf/jpeg/png/heic/webp/gif; sniff magic bytes for
  images the way `receipts/parse` does (route.ts:37).
- **Behavior**: sha256 the bytes; create the row (catch P2002 on `sourceRef` and return the
  existing row with `{ok:true, alreadyReceived:true}`); upload to `SECURE_BUCKET` at
  `receipts/intake/<id>.<ext>`; state RECEIVED; `dryRun` = (env `RECEIPT_INTAKE_DRYRUN`
  is not "false"). When a session/Bearer user supplies `projectId`, check
  `userCanAccessProject` and set `createdById`. Return 200 with the serialized row
  (id, state, sourceRef, projectId). No Gemini call here — sub-second, fire-and-forget safe.
- Deterministic bad input (missing file, bad source, oversize, bad mime) → 400 JSON.

### GET /api/receipts/intake?state=&projectId=&take=  (same route file)
- Staff only: session or Bearer user with role ADMIN | MANAGER | FINANCE, else 403 (proxy
  bypass means the handler enforces this itself).
- Rows newest-first (`take` max 200, default 50), fields = the row minus `readJson`. Keep
  the select in one exported function (mirroring `src/app/automation/register-data.ts`
  style) so the Phase 2 `/automation` Receipts tab reuses it unchanged.

### POST /api/receipts/intake/[id]/archived  (secret-auth only)
- Body `{driveFileId}`. Sets `archiveDriveFileId`, state BOOKED → ARCHIVED. Used by the
  nightly Apps Script mirror (§6). 404 for unknown id; 409 if state is not BOOKED.

## 4. Worker library — `src/lib/receipt-intake/*.ts` (pure core, I/O at the edges)

- **`keys.ts`** (pure; port verbatim from `runReceiptAutomation.js`): `sanitize` (:1478),
  `cleanMoney` (:1519), `normalizeDateStr`/`isValidDate`, `refLooksReal` (:1581 with the
  :1578 placeholder list verbatim), `VENDOR_ALIASES` (:1609 verbatim), `canonicalVendor`
  (:1615), and `dedupKeys(read) -> {strong: string|null, weak: string}`:
  - strong = `dateStr + "|" + ref.toLowerCase()` ONLY when the date was read off the
    document and is valid AND the ref passes `refLooksReal` (checks test `checkNum` and use
    `"Check"+checkNum`; receipts use the cleaned invoice; `NoInv` / `CheckNoNum` give
    null). Vendor and amount stay OUT of the key — v3.6 rationale at :1545–1557.
  - weak = `canonicalVendor(vendor) + "|" + dateStr + "|" + amount + "|amt"` where amount
    is the `cleanMoney` 2-dp string; built for EVERY document.
  - Fallback date when unreadable = the intake row's `createdAt` date (v1 used the Drive
    upload date — same semantic).
- **`read.ts`**: `readReceipt(fileBytes, mime, projectPhases) -> ReadResult`. REST to
  `generativelanguage.googleapis.com/v1beta/models/<m>:generateContent` with
  `responseMimeType "application/json"`; models `["gemini-3.5-flash",
  "gemini-flash-latest"]` with the Apps Script retry discipline: 429/503 backs off up to 5
  tries then falls to the next model; 404 falls to the next model; a decisive failure
  (valid HTTP, unusable JSON) returns `{decisive:true}` so callers never burn retries on a
  hopeless document (:1143–1184 rationale). Prompt = :1099–1133 VERBATIM (A/B/C roles,
  multi rule, final-amount-paid rule, tax never-estimate rule, empty-string-for-unreadable
  rule), plus ONE appended section: the project's active cost codes as a phase list
  (code — name per line) and one extra output field `"suggested_phase"` restricted to that
  list or empty. The v1 extraction fields must stay byte-identical.
  `ReadResult = {docType, vendor, date, invoice, checkNumber, memo, totalAmount, taxAmount,
  suggestedPhaseCode, raw}`. `text/plain` files go in as a text part (v1 :1093).
- **`route-state.ts`** (pure): `routeState(read, dedupHits, hasProject)`:
  | condition (first match wins) | state |
  |---|---|
  | docType "multi" | NEEDS_REVIEW `multi-doc` |
  | docType "non_receipt" | NON_RECEIPT |
  | total "0.00" (unreadable-total rule, :531) | NEEDS_REVIEW `zero-total` |
  | no projectId | NEEDS_JOB |
  | strong hit, same totalCents | DUPLICATE (+`duplicateOfId`) |
  | strong hit, different total | NEEDS_REVIEW `strong-dup-amount-mismatch:<id>` |
  | weak hit (another live row, different id) | NEEDS_REVIEW `weak-dup:<id>` |
  | otherwise | READ |
  The strong-key CLAIM is the partial unique index: the read step UPDATEs the row with its
  keys and treats a unique violation as the hit signal, then loads the owner row to compare
  totals — the database replaces the Apps Script Properties lock. Weak hits are a plain
  query (same `dedupWeakKey`, different id, state not in DUPLICATE/VOID/NON_RECEIPT) and
  always route to a human (:1591–1596).
- **`book.ts`**: `bookReceipt(row)`:
  1. Guards: `QBO_RECEIPT_PUSH_ENABLED === "true"` and not
     `isPaused(PAUSE_KEYS.receiptPush)` — the same two switches the qbo-receipts/create
     route checks. Off/paused: stay BOOKING, `stateReason` push-disabled|push-paused,
     `nextRetryAt` +1h, attempts NOT incremented.
  2. Estimate = project's latest (`orderBy createdAt desc, take 1`, the receipt-ingest
     rule); none: NEEDS_REVIEW `no-estimate` (terminal, no attempt spent).
  3. Groups (port `sendToQBOviaAPI.js:129–178`): docType receipt, job project, and
     `0 < taxCents < totalCents` gives two groups
     `[{category:"Receipt (pre-tax)", amount:(total-tax)/100},
       {category:"Sales tax", amount:tax/100, tax:true}]`; otherwise one full-total group.
     Checks never split tax (:148).
  4. `createQBReceiptPurchase(await getFreshQBTokens(), input)` with `fileId` = the Drive
     fileId when source=drive (keeps DocNumber idempotency continuous with any v1 booking
     of the same file), else the intake `id`; `fileBase64` via
     `downloadDocBytes(storagePath)`; `projectName` = project.name.
  5. On `ok:true`, one transaction: create `Expense` (estimateId; costCodeId = chosen, else
     `matchCostCode(suggestedPhaseCode)`; **amount = the GROSS total paid, tax INCLUDED**
     (Justin, 2026-09-01 — this REPLACES the "pre-tax" rule this line used to state; see
     the as-built note in §7); vendor; date=txnDate; status "Pending"; receiptUrl
     = Drive view URL when a Drive fileId is known, else the `secure:` ref; qbPurchaseId)
     and set the row BOOKED {qbPurchaseId, expenseId, bookedAt}. Also log one
     `AutomationEvent {kind:"receipt-push", source:"intake-worker"}` so the /automation
     register keeps seeing v2 bookings. `alreadyExists:true` results book the same way
     (idempotent re-drive after a lost response).
  6. Failure classification: `QboPurchaseFaultError` / `QboAccountConfigError` /
     `QboVendorDuplicateError` / any `result.ok:false` reason are TERMINAL: NEEDS_REVIEW
     with the reason (4xx class, never retried). `QBTimeoutError`, `QBNotConnectedError`,
     network/fetch errors, QBO 429/5xx, DB errors are RETRYABLE: attempts+1, lastError,
     `nextRetryAt = now + backoff(attempts)`; backoff = attempts 1 gives 5m, 2 gives 15m,
     3 gives 1h, 4+ gives 6h; attempts > 20: NEEDS_REVIEW `max-retries`.

## 5. Cron — `src/app/api/cron/receipt-intake-worker/route.ts`

- `vercel.json`: `{"path": "/api/cron/receipt-intake-worker", "schedule": "*/5 * * * *"}`.
- `export const maxDuration = 60; export const dynamic = "force-dynamic";` Auth = the
  fail-closed drain-notifications pattern (Bearer CRON_SECRET; 401 when unset on Vercel).
- Claim step (overlap safety under pgbouncer — session advisory locks are unusable, see
  review-alert-rollout.ts:8): one SHORT transaction:
  `SELECT pg_try_advisory_xact_lock(hashtextextended('receipt-intake-worker', 0))` — if
  false, return `{skipped:"already-running"}`; else select up to 10 ids where
  `state IN ('RECEIVED','READ','BOOKING') AND (nextRetryAt IS NULL OR nextRetryAt <= now())`
  ordered by createdAt, and UPDATE their `nextRetryAt = now() + interval '10 minutes'`
  (the claim). Process OUTSIDE the transaction: RECEIVED rows get read+dedup+route (dry-run
  rows park at READ / NEEDS_* / DUPLICATE); READ rows with `dryRun=false` move to BOOKING;
  BOOKING rows get `bookReceipt`. If two runs ever interleave anyway, the bumped
  `nextRetryAt` keeps each row single-claimed and QBO DocNumber idempotency backstops the
  booking itself.

## 6. Archive decision

**Recommendation: (b) Supabase-only now + nightly Apps Script mirror.** Reasons: (1) no
service account or Drive-writer credential exists in ProBuild — option (a) needs Justin to
provision one and share `Processed Receipts/` with it (a Workspace-admin human step);
(2) the Apps Script project already owns working Drive auth and the archive-naming code —
a ~50-line `mirrorBookedReceipts()` (Apps Script PR) polls
`GET /api/receipts/intake?state=BOOKED` with the shared secret, downloads each file via a
short-lived signed URL, writes `Processed Receipts/YYYY/MM/` with the v1 filename
convention `<Project>_<date>_<vendor>_<ref>_$<total>.<ext>` (keys.ts sanitize rules), then
POSTs `/api/receipts/intake/<id>/archived {driveFileId}`; (3) Drive stays the archive
Marge uses, byte-identical to today. Cost: the archive copy lags up to a day — acceptable
because job cost (`Expense`) and QBO no longer wait on it. Revisit a native Drive copy in
Phase 6 if the mirror proves flaky.

## 7. Forwarder contracts (Apps Script side — separate PR in qbo-clasp, spec only)

All gated on Script Property `V2_FORWARD === "true"`; all send `x-receipt-intake-secret`.
- `runReceiptAutomation`: on picking up a job-folder file, POST JSON
  `{source:"drive", sourceRef:"drive:"+fileId, projectId: resolved from the folder name,
  fileBase64, mimeType, fileName}`.
- `pullReceiptEmails`: `{source:"email", sourceRef:"email:"+messageId+":"+sha16(bytes), ...}`.
- `sweepChatReceipts`: `{source:"chat", sourceRef:"chat:"+messageName+":"+idx, threadName, ...}`.
- Non-200: leave the file in place and retry next run (intake idempotency makes replays safe).
- Shadow-week wrinkle: during shadow the forwarder COPIES bytes to intake and leaves the
  original for v1 to process as usual. The move-to-`_Forwarded` branch (which hides the
  file from v1) activates only under a second property `V2_LIVE === "true"` at cutover.

### As-built notes (2026-09-01) — where the implementation differs from the plan above

The Apps Script side is a separate PR in `qbo-clasp`. The endpoint contract it must code
against is the one above, with these six clarifications from the build:

1. **`GET /api/receipts/intake` accepts the shared secret as well as a staff session.**
   §3 said staff-only, but §6's nightly mirror polls `?state=BOOKED` with
   `x-receipt-intake-secret` — it has no session to present. A SESSION caller still needs
   ADMIN | MANAGER | FINANCE (403 otherwise); the secret caller is the mirror.
2. **`POST /api/receipts/intake/<id>/archived` is also on the proxy's public bypass**,
   spelled out as its own exact pattern (`/api/receipts/intake/[^/]+/archived`). It is a
   DESCENDANT of the intake path, and the intake bypass is exact-match on purpose, so
   without its own entry the proxy would answer the mirror with a 307 to /login. The
   route is secret-only: a session, however privileged, is refused, because only the
   mirror can know that a file now exists in Drive. It is also state-conditional
   (`updateMany WHERE state = 'BOOKED'`), so two mirror runs racing one row cannot both
   claim the transition — the loser gets 409.
3. **`threadName` is accepted and NOT persisted.** The chat forwarder should keep sending
   it, but `memo` belongs to the read step (it holds a check's handwritten memo line) and
   there is no other column for it yet. Phase 2 adds one when the queue page needs to link
   back to the thread.
4. **The phase suggestion is resolved to `suggestedCostCodeId` at READ time**, not at
   booking, using the same `matchCostCode` the v1 ingest uses. Booking then takes
   `costCodeId ?? suggestedCostCodeId`. Same outcome as §4 step 5, but the suggestion is
   visible in the queue before anything books.
5. **A non-Drive row's intake id is a UUIDv4**, so its QBO DocNumber is the first 21
   characters of that UUID (risk 5 above, unchanged in substance — the PrivateNote marker
   check in `createQBReceiptPurchase` still turns any truncation collision into a
   `docnumber-conflict` rather than a mis-attached Purchase).
6. **Tests live in `tests/receipt-intake-*.test.ts`, run by `tsx --test`**, not
   `test/receipt-intake/*.test.mjs`. That is the repo's existing convention (every other
   suite is there and wired into `npm run test:unit`); the rule that mattered — no
   `mock.module`, function injection only, because CI pins Node 20 — is followed.

### Round-1 review changes (2026-09-01)

**DECISION (Justin, overrides §4.5): `Expense.amount` is the GROSS total paid, tax
included.** The QBO Purchase still splits the sales tax onto its own reclaimable account —
that is unchanged and it is what the reseller-permit filing reads. But `Expense` has no tax
column, and the expenses already imported from QuickBooks (`lib/qbo-expense-sync.ts`)
record the gross line total, so booking pre-tax here would put two meanings of `amount` in
one table and silently under-count every receipt this pipeline touched. `ReceiptIntake.taxCents`
keeps the split; Phase 3 adds `Expense.taxAmount` and can derive the pre-tax figure without
re-reading a single document.

Also changed, all with tests:

- **Dry-run rows are excluded from the claim, not skipped inside it.** The batch is ten
  rows; after a couple of shadow days the ten oldest were all parked ones, so no NEW receipt
  was ever reached and the queue looked healthy while processing nothing. A one-shot
  `requeueDryRunParked` on the first live pass un-parks the backlog (and flips `dryRun` in
  the same statement, or the rows would re-park forever). This is the one thing that changes
  a row's `dryRun` after intake.
- **Read budget: 25s per row, 2 retries per model at 1s/3s.** The Apps Script's 5 retries at
  2s..32s suits a 6-minute trigger, not a 60-second function shared by ten rows. The worker
  also stops TAKING new rows once 40s of its 60s are gone. Exhaustion returns AI_UNAVAILABLE,
  which never spends `attempts` — but `busyPasses` now counts them and parks the row after 20
  (v3.4), so an endless outage still ends in front of a human.
- **`sourceRef` reuse is decided on `fileSha256`.** The row is inserted BEFORE the upload, so
  the unique index is the decision point: same bytes is a replay (200, the existing row),
  different bytes is 409 `sourceRef-conflict` and storage is never touched. Previously both
  cases got a 200 and a second, real receipt could be swallowed.
- **Vendor is not part of the strong KEY, but it is part of the CONFIRMATION.** The v3.6
  vendor-less key stands; a same-total hit whose canonical vendor differs now routes to
  NEEDS_REVIEW `vendor-mismatch:<id>` rather than DUPLICATE.
- **Negative and zero totals** route to NEEDS_REVIEW `refund-or-zero` (replacing
  `zero-total`) and claim no key.
- **A second weak-dedup check runs INSIDE the READ→BOOKING transaction**, the last instant
  before money moves. The claim advisory lock is one global constant so only one batch runs
  at a time.
- **A NEEDS_REVIEW park RELEASES the strong key unless a QBO send was attempted** (v3.5
  rule): otherwise the key is held by a document that never became a purchase, and a
  corrected re-send is quarantined against nothing.
- **Transient throws (storage, Prisma, network) retry on the normal backoff.** Only the
  classified QBO fault types are terminal. `MAX_BOOK_ATTEMPTS` is now `>=`, so it means 20
  attempts in total.
- **Non-secret callers cannot choose `source` or `sourceRef`** — the server mints both from
  the auth kind; anything else is a 400. Only shared-secret callers may declare
  drive/email/chat. An existing row's fields come back only to its creator or a bookkeeping
  role.
- **The shared-secret GET is limited to `state=BOOKED|ARCHIVED`** and a minimal field set
  (no error text, hashes, or user ids).
- Archive callback is idempotent for an identical retry (200), 409 only for a DIFFERENT
  Drive file id. HEIC sniffing accepts `hevc`/`hevx`; `mif1`/`heif` store as image/heif.
  P2002 resolves the owner by `dedupStrongKey` instead of string-matching Prisma's `meta`
  (which is empty for a partial index on some engine builds). The apply script matches
  `--expect-host` exactly and verifies the index is UNIQUE with the exact predicate.

**Left as-is, deliberately:** the pre-existing asset-suffix proxy bypass (not introduced
here); multipart buffering before the size check (the platform body limit applies first);
PDFs carrying embedded JavaScript (never opened server-side — the bytes go to Gemini and to
QBO as an attachment).


### Objects are sealed on finalize

The upload path is writable by whoever holds the signed URL, and that URL is `upsert: true`
so a resumed `/start` can replace its own partial upload. Both are necessary, and together
they mean the bytes at the upload path can change AFTER verification.

So `/finalize` verifies, then **copies** the bytes to `receipts/<id>/<sha256>.<ext>` — a
content-addressed path the client was never given a URL for — deletes the upload path, and
points the row there. Every later reader (the Gemini read step, the booker) re-hashes what
it downloads and refuses on a mismatch: `content-changed`, terminal. A hash stored once and
never re-checked proves nothing about what is being served now.

A failed delete of the upload path is an orphan, not a correctness problem (the row already
points at the sealed copy), so it goes on the `storage-cleanup-pending` queue.

**Sweeper timing.** A `STAGING` row is only parked `file-missing` once the signed upload
URL's **2-hour** lifetime has passed — parking at the 15-minute sweep window declared
receipts missing while their own upload link was still usable. A late `/finalize` on a row
the sweeper already parked re-validates and **recovers** it rather than reporting
`alreadyFinalized`, which would leave a real receipt parked while telling the caller it was
fine.

### Upload limits, and text receipts

| path | ceiling | why |
|---|---|---|
| `POST /api/receipts/intake` (JSON) | **3 MiB raw** | base64 inflates by 4/3, so 3 MiB encodes to ~4 MiB and fits the serverless body cap. 4 MiB raw would be a ~5.4 MiB request that dies at the edge with a 413 this code never sees. |
| `POST /api/receipts/intake` (multipart) | **4 MiB** | bytes are sent as-is. |
| two-step (`/start` + signed URL + `/finalize`) | **8 MiB** | the bytes never pass through this server. The ceiling is QuickBooks' own attachment limit: anything larger is a receipt that would be stored, read, and then stranded `unsupported-attachment:size` after we had already told the sender we had it. One constant, `QBO_ATTACHMENT_MAX_BYTES` in `intake-core.ts`. |

Both inline ceilings answer with a 413 naming the two-step path.

**The 8 MiB ceiling is set on the Supabase bucket as well as in code.** The signed upload
URL bypasses this server entirely, so application code cannot stop the write — it can only
refuse the object afterwards, by which time the bytes are already paid for and sitting in
the bucket. Set it where the write happens:

> `node scripts/apply-receipt-intake.mjs --yes --expect-db … --expect-host …`, with
> `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the environment. It creates the bucket when
> missing and VERIFIES it when present, and exits **nonzero** if it exists with a different
> file-size limit, a different MIME allow-list, or as a public bucket. It never silently
> "corrects" one: overwriting a limit somebody set deliberately is how a 400 MB upload
> becomes possible again next quarter.

Receipts live in their **own** bucket, `receipt-intake` — not `secure-docs`:

* Those limits are **per bucket**, so `secure-docs` cannot carry a receipt policy without
  imposing it on contracts, e-signatures and invoice PDFs.
* A signed upload URL is a **write capability**. Issuing one against the bucket that also
  holds countersigned contracts means a path-handling bug in intake is a write into the
  contract store.
* The orphan sweep **deletes** objects, unattended, from paths read out of an event log. It
  must not be able to reach anything but receipts.

All intake reads and writes go through `src/lib/receipt-intake/bucket.ts`, which is the one
place that names the bucket.

The server-side check stays regardless, and is checked in this order:
1. **Object metadata first** (`list({ search })` → `metadata.size`) — one small request that
   costs the same whatever the object weighs. Oversize is rejected here, with no body read.
2. **Then the downloaded byte length**, as a second line for anything the metadata missed.

An **unknown** size is `transient`, not permission to proceed: a storage hiccup, a missing
client or an API without metadata all used to fall through to the download — which is the
read this check exists to avoid, taken on exactly the objects we know least about. Both
callers retry a transient answer.

**`text/plain` is refused with a 415.** QuickBooks cannot attach a `.txt`, so accepting one
meant reading it with Gemini and then stranding it unbookable at
`unsupported-attachment` — worse than a clear refusal at the door. v1 converted these using
Apps Script's HTML→PDF `getAs`, which has no Node equivalent: a real port means a PDF
generator with wrapping, pagination and WinAnsi encoding (pdf-lib's standard fonts THROW on
characters they cannot encode), which is a new silent-corruption surface on a money document
for the rarest input in the pipeline. The 415 says to send a PDF or an image instead.

### Every worker write is fenced on the claim token

`ReceiptIntake.claimToken` is re-stamped on every claim, and each row carries it through the
pass. Every transition — `finishRouting`, `promoteToBooking`, `markSendAttempted`, each
book-result write, and the `BOOKED` commit — is a CAS on `{id, state, claimToken}`.

The one that matters most is `markSendAttempted`: it is the **last fence before
QuickBooks**. A worker whose invocation was killed and whose row has since been re-claimed
finds zero rows there and aborts with `outcome: "stale"` **having sent nothing** — so a
zombie cannot post a Purchase the live worker is about to post as well. A claim lost later,
between the create and the commit, rolls the transaction back (Expense included); the
successor's retry hits QBO's DocNumber idempotency, gets the same Purchase, and books it
once under one owner.

### Two machine secrets, not one

They belong to different programs, so they are different keys and rotate independently.
A single shared secret gave a script that only copies files to Drive the power to inject
Purchases into the books, and gave the ingest forwarders the power to enumerate every
receipt in the system.

| secret | may do | may NOT do |
|---|---|---|
| `RECEIPT_INTAKE_SECRET` (the Apps Script forwarders) | `POST /api/receipts/intake`, `/intake/start`, `/intake/{id}/finalize`, declaring `source` in **drive, email, chat** only | read the queue; archive anything |
| `RECEIPT_ARCHIVE_SECRET` (the nightly Drive mirror) | `GET /api/receipts/intake?state=BOOKED|ARCHIVED` (minimal field set + signed URL), `POST /api/receipts/intake/{id}/archived` | create, publish or modify a row; declare any source |

Cross-use is **403**, not 401: the caller is authenticated, it is just holding the other
program's key, and saying so is what makes a mis-wired script obvious instead of looking
like a rotation problem. Setting both variables to the same value is refused at runtime —
that would silently undo the split.

### Phase suggestion: confidence, and re-validation at booking

The reader returns `suggested_phase_confidence` (0..1) alongside the phase code. It is
persisted as `ReceiptIntake.suggestedConfidence`, so the queue can sort by it, and it is
recorded on the booking's `AutomationEvent` when the suggestion is what got used. Absent or
unparseable is **null, never 0** — "the model didn't say" and "the model is sure it is a
poor match" have to stay distinguishable.

At booking, BOTH the captured `costCodeId` and the suggestion are re-checked against the
project the row will actually book to, via the same `isCostCodeAllowedForProject` the
clock-in uses. The row may have been read while it had no project (`NEEDS_JOB`) or a
different one that a human then corrected, and a cost code from the old project is not a
phase of the new one. A mismatch clears the code and books UNCODED with a note — the
receipt and its total are still right, and a bookkeeper assigning a phase is routine, while
an expense silently attached to the wrong phase is not.

### Upload paths (two of them)

`POST /api/receipts/intake` carries the file in the REQUEST BODY, so it is limited by the
serverless body cap (~4.5 MB, and base64 JSON inflates a payload by a third). It rejects
anything over **4 MB** with a 413 that names the two-step path. That limit is about the
transport, not the document.

For anything larger — most phone photos — use the two-step flow, which never puts the bytes
through this server at all:

1. `POST /api/receipts/intake/start` with `{mimeType, fileName?, fileSize?, source?,
   sourceRef?, uploadId?, projectId?}` -> `{id, uploadUrl, token, storagePath, maxBytes}`.
   Creates the row in `STAGING` (invisible to the worker) and returns a short-lived Supabase
   signed upload URL bound to a server-chosen path.
2. `PUT` the bytes straight to `uploadUrl`.
3. `POST /api/receipts/intake/{id}/finalize` with `{sha256?}` -> publishes `STAGING` ->
   `RECEIVED`. The server re-reads the object and derives the mime, the size and the sha
   FROM STORAGE; a declared `sha256` is checked against that and a mismatch is a 409. Over
   8 MiB or an unreadable format deletes the row and refuses.

Both paths share `decideSource` (provenance and idempotency), so a session/Bearer caller can
never choose `source` or `sourceRef` on either, and `uploadId` is scoped to the authenticated
user on both. Both new paths are on the proxy's exact-match bypass and both refuse a
`next-action` dispatch with 403.

### CUTOVER SEQUENCE — do these in this order (2026-09-02)

The hazard this order exists to prevent: v2's QuickBooks identity for an
email/chat/mobile/web row is the intake UUID, which v1 never saw. QBO's DocNumber
idempotency therefore CANNOT recognise a Purchase v1 already created for the same
document. Run both pipelines live at once, or replay the shadow backlog through v2, and
those receipts book twice on real books.

Drive rows are the exception: v2 books them under the Drive file id, which IS v1's
identity, so an overlap on a Drive-sourced file is idempotent. That is not enough to make
an overlap safe in general.

1. **Flip the Apps Script to forwarder mode** (`V2_FORWARD=true`). It now COPIES bytes to
   `/api/receipts/intake` and still books everything itself. ProBuild is in dry-run:
   it reads, dedups and routes, and books nothing.
2. **Run the shadow week.** Gate on §8: 5 consecutive days where every archived v1 file has
   a v2 row agreeing on vendor/date/total, and no v2 row stuck in RECEIVED over an hour.
3. **Flip the Apps Script to `V2_LIVE=true`.** It now MOVES files to `_Forwarded` instead of
   booking them. v1 stops writing to QuickBooks. ProBuild is still in dry-run, so for this
   window NOTHING books — that is intended and it is why the window is short.
4. **Confirm zero v1 bookings for 24 hours.** Watch the Automation register and QBO. This
   is the step that makes the next one safe: it proves v1 is out of the books before v2
   enters them, so the two can never both create a Purchase for one document.
4a. **Record the boundary.** When step 3 happens, write the instant v1 stopped booking into
   the `cutoverV1StoppedAt` AutomationSetting row (or the `CUTOVER_V1_STOPPED_AT` env var) as
   an ISO timestamp. This is the ONLY input that separates "v1 booked it" from "nobody booked
   it", and nothing in the database can infer it.
5. **Only then set `RECEIPT_INTAKE_DRYRUN=false`.** On its first pass the worker splits the
   shadow backlog. The boundary narrows the CANDIDATES; **evidence** decides each one:
   - before the boundary AND provably booked by v1 -> `SHADOW_DONE` / `booked-by-v1`.
     Terminal; v2 never books these. Evidence is either an `AutomationEvent`
     (`kind: receipt-push`, status `created`/`already-exists`) whose `driveFileId` matches
     the row — v1's pushes go through ProBuild's create route, which logs them — or the
     forwarder sending `archivedByV1: true` on the forward.
   - before the boundary, NO evidence, and a **Drive** row -> handed to v2. Safe precisely
     because a Drive row books under the **Drive file id**, so if v1 did book it after all,
     QBO's DocNumber/requestid idempotency collapses the two into one Purchase.
   - before the boundary, NO evidence, and **not** a Drive row -> `SHADOW_QUARANTINE`.
     There is no shared identity here: v2 would book under the intake UUID, which v1 never
     saw, so a duplicate would go through silently. Booking risks double-paying; retiring
     risks losing a real expense. Terminal, never auto-requeued — it surfaces on the
     Receipts tab with a "book anyway" action for whoever has checked QuickBooks.
   - after the boundary -> handed to v2. v1 had already stopped, so nobody booked these.
   With no boundary recorded in live mode the worker **halts the entire pass before
   claiming anything** and logs `cutover-boundary-missing`. Not just the retire: booking
   anything while we cannot tell what v1 already booked is the double-booking this whole
   mechanism exists to prevent.

Retired rows keep their read results and dedup keys, so a post-cutover resend of a
shadow-week receipt still collides with them and is caught as a duplicate.

**Rolling back** after step 5 means turning `V2_LIVE` off again and `RECEIPT_INTAKE_DRYRUN`
back on. Rows received while v2 was live are already booked and stay `BOOKED`; v1 will not
re-book them, because its own `_Forwarded` move already took those files out of its path.

Two things a human must do before this can leave shadow mode:

- Set `RECEIPT_INTAKE_SECRET` (new, independent of `RECEIPT_INGEST_SECRET`) in Vercel, and
  give the same value to the Apps Script as a Script Property.
- Re-run `node scripts/snapshot-prisma-blind-spots.mjs --write` against production AFTER
  `scripts/apply-receipt-intake.mjs` has run there. The new partial index and CHECK
  constraint were added to `prisma/prisma-blind-spots.json` by hand (the snapshotter needs
  a live production connection, which this branch never had), so their rendered
  definitions are asserted, not observed. CI's `migrations` job is what will catch a
  mismatch.

## 8. Shadow-week gate

- `RECEIPT_INTAKE_DRYRUN` unset/true: every row gets `dryRun=true` — reader, dedup, and
  routing all run; booking never does (goal 7 test proves it). No QBO write, no Expense.
- Daily comparison (checker or scratchpad script): v1 truth = that day's files in
  `Processed Receipts/YYYY/MM/` (filenames encode project/date/vendor/ref/total) vs
  `SELECT "sourceRef", vendor, "txnDate", "totalCents", "refNumber", state
   FROM "ReceiptIntake" WHERE "createdAt" >= <day>`. Match on the weak-key triple
  (canonicalVendor, date, amount).
- Gate to call Phase 1 done: 5 consecutive days where every archived v1 file has a v2 row
  agreeing on vendor/date/total with state READ (or DUPLICATE when v1 also quarantined),
  and zero v2 rows stuck in RECEIVED for more than an hour.
- Cutover (Justin's explicit call): set `RECEIPT_INTAKE_DRYRUN=false` and `V2_LIVE=true`.

## 9. Tests (node:test in `test/receipt-intake/*.test.mjs`; NO mock.module — CI is Node 20)

- `keys.test.mjs` — fixtures from real August archive filenames
  (I:\My Drive\Expenses\Processed Receipts\2026\August); expected keys per the ported rules:
  | file (project_date_vendor_ref_$total) | strong | weak |
  |---|---|---|
  | Berg_ADU_2026-08-03_Lowes_82766_$364.98 | 2026-08-03(pipe)82766 | lowes(pipe)2026-08-03(pipe)364.98(pipe)amt |
  | Berg_ADU_2026-08-03_Lowes_Home_Improvement_99908_$277.19 | 2026-08-03(pipe)99908 | lowes(pipe)...(pipe)277.19(pipe)amt — alias collapses the vendor variants |
  | Berg_ADU_2026-08-04_WINLOCK_HARDWARE_12_$14.50 | null (ref "12" under 3 chars) | winlockhardware(pipe)2026-08-04(pipe)14.50(pipe)amt |
  | Berg_ADU_2026-08-04_WINLOCK_HARDWARE_4_$16.17 | null | winlockhardware(pipe)2026-08-04(pipe)16.17(pipe)amt |
  | Berg_ADU_2026-08-07_CRC_-_WEST_VAN_260807091421373F2A9_$91.50 | 2026-08-07(pipe)260807091421373f2a9 | assert actual canonicalVendor output for a non-alias vendor |
  | Berg_ADU_2026-08-09_Amazon.com_113-9992333-7801840_$248.27 | 2026-08-09(pipe)113-9992333-7801840 | amazon(pipe)...(pipe)248.27(pipe)amt |
  | Berg_ADU_2026-08-10_Grover_Electric_Plumbing_Supply_NoInv_$22.57 | null (NoInv) | groverelectricplumbingsupply(pipe)...(pipe)22.57(pipe)amt |
  | Berg_ADU_2026-08-14_LOWES_HOME_CENTERS_LLC_58302_$304.23 | 2026-08-14(pipe)58302 | lowes(pipe)2026-08-14(pipe)304.23(pipe)amt |
  Plus placeholder-ref cases: "NA 000" null, "0000" null, "INV-95870" real (:1571–1580).
- `route-state.test.mjs` — the full section-4 truth table (multi, non_receipt, zero-total,
  no-project, strong-same, strong-diff, weak, clean).
- `backoff.test.mjs` — attempts 1..4 give [5m,15m,1h,6h], 10 gives 6h, 21 gives
  NEEDS_REVIEW max-retries; QBTimeoutError classed retryable; QboPurchaseFaultError terminal.
- `book.test.mjs` — dependency-injected `createPurchase`/prisma-shaped stubs (function
  injection, never module mocks): success creates the Expense with the correct amount and
  tax split; no-estimate short-circuits without an attempt; disabled/paused spends no attempt.
- e2e (Playwright, CI postgres): `e2e/receipt-intake.spec.ts` — idempotent POST (same
  sourceRef twice, one row, same id), 401 matrix (no auth, bogus session cookie, wrong
  secret, secret-env-unset), GET requires a staff role. Teardown deletes created rows
  (docs/TESTING.md rule).

## 10. Risks and open questions for Justin (max 5)

1. **Public-bypass route**: `/api/receipts/intake` bypasses the proxy, so the handler is
   the only gate. Mitigated by the fail-closed secret check + the 401 e2e matrix; Codex
   must review the auth block specifically. (Risk to watch, no decision needed.)
2. ~~**Expense.amount = pre-tax when tax is split**~~ **RESOLVED 2026-09-01: GROSS.**
   Justin's call. `Expense.amount` is the total paid, tax INCLUDED, matching what the
   QBO-imported expenses in `lib/qbo-expense-sync.ts` already record. The QBO Purchase
   still splits the tax onto its own reclaimable account — that is unchanged and it is
   what the reseller-permit filing reads. `ReceiptIntake.taxCents` keeps the split so
   Phase 3 can add `Expense.taxAmount`. No open question here.
3. **Archive via nightly Apps Script mirror** (§6) instead of a Drive service account —
   confirm, or provision a service account now if same-hour archiving matters to Marge.
4. **HEIC**: stored and read fine (Gemini accepts image/heic), but the Phase 2 queue page
   cannot preview HEIC natively in most browsers. OK to defer conversion?
5. **Non-Drive booking identity** uses the intake cuid as the QBO DocNumber (21-char
   slice). A truncation collision is backstopped by the PrivateNote marker check in
   `createQBReceiptPurchase` (it fails as docnumber-conflict rather than mis-attaching).
   Accepting that; flag if you want a dedicated short id instead.

HUMAN DECISION REQUIRED only before cutover (questions 2–3); the build and the shadow week
can start under the recommendations above.
