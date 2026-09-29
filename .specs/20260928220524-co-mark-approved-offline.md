# Spec: Office-side "Mark approved" for change orders (customer approved outside ProBuild)

**ID:** 20260928220524
**Date:** 2026-09-28
**Status:** draft
**Branch:** `spec/20260928220524-co-mark-approved-offline` (from `origin/main` @ `139885b1`)

> Public repo. Every example below is generic: "Customer A", "CO-000NN", "INV-000NN", "$20,000",
> "Jordan Lee (example staff member)". Do not add real customer names, addresses, emails, check
> numbers, or real job amounts to code, fixtures, tests, commits, or the PR.

---

## Context

**Who this is for:** the office (PM, owner, bookkeeper) and, indirectly, the client.

Customers often approve a change order by phone, text, email, or in person. ProBuild has exactly one
way to reach CO status `Approved`, and that is the customer drawing a signature in the portal:

- `approveChangeOrder` (`src/lib/actions.ts:9825-9885`) → `approveChangeOrderWithSignature`
  (`src/lib/change-order-approval.ts:61-109`) → `approveChangeOrderCore`
  (`src/lib/change-order-core.ts:360-419`). The core requires status `Sent` (`:375-377`) and a
  persisted signature (`:379-381`). Staff (ADMIN/MANAGER) skip the ownership check (`actions.ts:9827-9836`)
  but not the signature.
- After a fresh transition, `approveChangeOrder` schedules `handleChangeOrderApproved` via `after()`
  (`actions.ts:9860-9879`). Correction to the brief: `handleChangeOrderApproved` itself lives in
  `src/lib/billing-core.ts:2189-2297`, not in actions.ts. It runs `billChangeOrderCore`
  (`billing-core.ts:1990-2187`) and then auto-emails a payment request for every freshly created
  milestone through `sendMilestoneInvoicesCore` (`billing-core.ts:2229-2238`, function at `:1150`),
  which pushes each milestone to QuickBooks (`:1270`) and stamps `qbInvoiceSentAt` (`:1417-1422`).
- Generic status setters were removed on purpose (`actions.ts:9820-9823`,
  `change-order-core.ts:116-122`).

Two real-world problems follow:

1. A phone or text approval cannot be recorded at all.
2. When the customer already paid part of the CO before approving (for example, money sitting
   unapplied in QuickBooks), the signature auto-emails a payment request for the full amount. The only
   workaround today is hand-creating a milestone named exactly `CO-000NN — <schedule row name>` with
   the tax-inclusive amount and recording it paid before the customer signs, so
   `billChangeOrderCore` reuses it (`billing-core.ts:2067-2099`) and only fresh rows get emailed
   (`:2223-2232`).

**Owner rule (overrides the original billing-choice decision):** an office "Mark approved" must send
**zero** customer-facing messages, ever. Customer messages only go out when staff explicitly push them
(the invoice's existing Send button, Send Receipt button, and so on). Staff-internal notifications are
fine.

## Goals

Each goal is independently verifiable; acceptance criteria are listed under it.

### G1. Persisted offline-approval record (schema + migration)

Add three nullable columns to `ChangeOrder` (see Data Model Changes) and ship them the repo's way:
committed migration, idempotent apply script, CI proof.

Acceptance:
- `prisma/schema.prisma` `ChangeOrder` (currently `:1882-1930`) has `approvalSource`, `approvalMethod`,
  `approvalNote`, all `String?`, placed with the other approval fields (`:1903-1906`).
- A new `prisma/migrations/<UTC timestamp>_change_order_offline_approval/migration.sql` adds exactly
  those three columns with `ADD COLUMN IF NOT EXISTS`.
- `scripts/apply-change-order-offline-approval.mjs` exists, applies the same three statements, is
  idempotent, and passes `tests/apply-scripts-inert-on-import.test.ts` (inert on import, allowlisted
  imports, one guarded `main()` call).
- CI `migrations` job applies it twice (absent then present) and asserts the columns exist, same
  pattern as the receipt-intake source-folder step (`.github/workflows/ci.yml:557-567`).
- `node scripts/check-migrations-match.mjs` stays green in CI.

### G2. Atomic, race-safe offline approval core

A new core function approves a Draft or Sent CO without a signature, runs the same validation as the
signed path, and (for fixed-price COs) creates or reuses the invoice milestones **in the same
transaction** as the status change. Approval and billing commit together or not at all.

Acceptance:
- On success the CO row has: `status = "Approved"`, `approvedBy = <staff display name>`,
  `approvedAt = <entered approval date>` (see Approach for the exact instant), `approvalSource =
  "OFFLINE"`, `approvalMethod ∈ {PHONE, TEXT, EMAIL, IN_PERSON, OTHER}`, `approvalNote` = trimmed
  note or null. `clientSignatureUrl` stays null. `companySigned*` untouched.
- Refuses, with no writes, when: CO not found; status not Draft/Sent; any customer-approval audit is
  already present (`approvedBy`, `approvedAt`, `clientSignatureUrl`, or `approvalSource` non-null);
  the row's `updatedAt` differs from the caller's `expectedUpdatedAt`; section-header rows exist;
  FIXED with no items; FIXED with stored or rendered subtotal ≤ $0; FIXED with stored subtotal ≠ item
  sum; COST_PLUS with any schedule rows; FIXED with exactly one schedule row, any schedule row ≤ $0,
  or schedule rows that do not sum to the stored subtotal; approval date invalid or in the future
  (company time zone); method missing/unknown; note over 1,000 characters.
- Negative credit lines are allowed (same `billableCoItems`/`coLineCents` math as today).
- FIXED: milestones are created or reused exactly as `billChangeOrderCore` does today (same names,
  amounts, tax split, `sourceChangeOrderId`, `sourceCoScheduleId`, invoice total increments, Paid →
  Partially Paid bump). If billing fails (for example, "This project has no invoice yet"), the whole
  transaction rolls back and the CO is still Draft/Sent.
- COST_PLUS: approval only, no billing (mirrors `handleChangeOrderApproved`'s awaiting-actuals branch,
  `billing-core.ts:2210-2212`).
- Calling it twice (double-click) produces one approval and one set of milestones; the second call
  returns an "already approved" result and writes nothing.
- An offline approval racing a portal signature on the same CO: exactly one wins, exactly one set of
  milestones exists, and the loser gets a clear error (portal path: its existing "must be Sent" error
  and signature cleanup at `change-order-approval.ts:105-107`).
- Never calls `sendMilestoneInvoicesCore`, `pushMilestoneToQuickBooks`, `sendChangeOrderToClientCore`,
  or any customer-addressed `sendNotification`/`sendSMS`.

### G3. Server action with an admin-level role gate

Acceptance:
- New exported server action `markChangeOrderApprovedOffline` in `src/lib/actions.ts`.
- Gate: `assertChangeOrderPermission()` (`actions.ts:4519-4521`) first (satisfies
  `tests/server-action-gates.test.ts`), then `isAdminOrManager(user)` (`src/lib/access-rules.ts:25-29`,
  already imported at `actions.ts:49`), then `canAccessProject`. FIELD_CREW and FINANCE get
  `Forbidden`. A portal client session gets `Unauthorized`.
- Role choice: ADMIN + MANAGER, the same gate as the other company-side CO action,
  `countersignChangeOrderAsCompany` (`actions.ts:9898-9900`), and the staff bypass in
  `approveChangeOrder` (`actions.ts:9835`). See Open Questions for the FINANCE alternative.
- The logged-in staff user (id + `name || email`) is passed to the core as the approver. The client
  cannot supply the approver name.
- Revalidates the CO page, CO list, and the project invoice pages.

### G4. CO editor UI: "Mark approved" button and dialog

Acceptance:
- Button **Mark approved** appears in the editor action bar (`ChangeOrderEditor.tsx:248-313`, between
  "Send for Approval" and "Save") only when `canMarkApproved` (computed server-side in
  `src/app/projects/[id]/change-orders/[coId]/page.tsx`) is true AND status is Draft or Sent AND no
  customer approval is on file. Hidden for everyone else.
- Clicking it saves unsaved edits first (same pattern as Send, `ChangeOrderEditor.tsx:285-286`), then
  opens the dialog. A failed save aborts.
- Dialog captures: method (required), date approved (default today in the company time zone, may be
  earlier, cannot be later; `max` = today), optional note. No billing radio.
- Dialog shows the amount being approved (subtotal, tax line, total) or the cost-plus terms, and the
  plain notice "The customer will not be notified. Send the bill from the invoice when you're ready."
- Submit disables the button while pending (no double submit). Success shows a toast and refreshes;
  errors show the server message in a toast and keep the dialog open.
- The "Details & Signatures" tab (`ChangeOrderEditor.tsx:606-640`) shows an offline approval as
  "Approved by {staff} on {date} ({method})", "Not signed electronically", and the note (staff only),
  instead of a signature image or a cursive rendering of the staff name.
- UI copy exactly as in the "UI copy" section. No em dashes in any new UI copy.

### G5. Records, audit trail, and internal team notification

Acceptance:
- One `ActivityLog` row per successful offline approval: `action = "approved_change_order_offline"`,
  `actorType = "TEAM"`, `actorName` = staff name, `actorUserId` = staff id, `entityType =
  "change_order"`, metadata `{ method, approvedOn, note, billing: "billed_no_send" | "awaiting_actuals",
  invoiceCode?, milestones?, amount? }`.
- FIXED: one `billed_change_order` ActivityLog row with the staff member as actor (the extracted
  in-transaction biller does not log; the offline path logs once after commit).
- Team email goes to the same address the signed path uses (`notificationEmail`, else company
  `email`; `billing-core.ts:2268-2269`) and only there. Subject and body say it was approved by
  {staff} ({method}) and that the customer was not notified. No client address in `to`, `cc`, or
  `bcc`.
- The schedule hook runs once after commit, the same call as `billing-core.ts:2247-2262`
  (`applyChangeOrderToSchedule`, mode `merge`), best effort.
- Post-commit steps never throw into the action; failures become `warnings` in the result.
- Read surfaces tell offline from signed: `getProjectBilling`'s CO list (`billing-core.ts:153-160`,
  MCP `list_project_billing`) and MCP `list_change_orders` (`route.ts:1351`) include
  `approvalSource` and `approvalMethod` (and `list_change_orders` the note).

### G6. Customer portal and PDF render offline approvals honestly

Acceptance:
- Portal CO page (`PortalChangeOrderClient.tsx`): for `approvalSource = "OFFLINE"` the header badge
  (`:178-180`) reads "✓ Approved" (not "Approved & Signed"), and the signed block (`:290-309`) is
  replaced by: title "Approved", line "Approved by {staff} on {date} ({method})", line "Recorded by
  the office. Not signed electronically." No `<img>`, no "Electronically Signed" wording, no blank
  signature box. The replacement block carries `data-pdf-row="true"` so the portal's Download PDF
  includes it.
- `approvalNote` never reaches the customer: stripped from `initialData` in
  `src/app/portal/change-orders/[id]/page.tsx:36-40` (it is loaded by `getChangeOrderForPortal`'s
  `include`, `actions.ts:9741-9753`), and never printed by the PDF.
- Staff/portal PDF (`generateChangeOrderPdf`, `src/lib/pdf.ts:1208`; approval block `:1442-1451`;
  route `src/app/api/pdf/change-orders/[id]/route.ts` serves staff and portal clients): offline rows
  print "Approved by {staff} on {date} ({method})" and "Recorded by the office. Not signed
  electronically." Signed and legacy rows render exactly as today.
- Dates in these labels are formatted in the company time zone on the server (no browser time-zone
  drift).

### G7. Zero customer notifications: audit every path and prove each stays silent

The full audit is in "Customer-notification audit" below. Three paths leak today and must be fixed;
the rest are proven silent by citation and tests.

Acceptance:
- `co-billing-sweep` (`src/app/api/cron/co-billing-sweep/route.ts:28-35`) skips offline approvals:
  its `findMany` where clause adds `approvalSource: null`.
- `handleChangeOrderApproved` (`billing-core.ts:2189`) returns early, before billing, sending,
  scheduling, or notifying, when the CO's `approvalSource` is `"OFFLINE"` (defense in depth for the
  sweep and any future caller). Signed and legacy COs are unaffected.
- Payment reminders (`src/lib/payment-reminders.ts`) never select a milestone that came from an
  offline-approved CO and has never been requested (`qbInvoiceSentAt IS NULL`). The exclusion is in
  both the selection where (`:167-172`) and the claim where (`:284-294`). Once staff sends the
  milestone (stamping `qbInvoiceSentAt`), normal reminder rules apply again. Ordinary milestones
  (no `sourceChangeOrderId`) keep today's behavior exactly.
- The paid-milestone notifier (`notifyMilestonePaid`, `src/lib/payment-notifications.ts:85`; client
  receipt condition `:181`) skips the automatic client receipt for a milestone that came from an
  offline-approved CO and has never been requested. Team alert and activity log still fire;
  `receiptSentAt` stays null so the explicit Send Receipt button (`actions.ts:4321`) still works.
  This single gate covers every settle path (manual Record Payment, deposit photo path, Stripe
  webhook, QuickBooks sync, outbox drain).
- Acceptance tests assert no customer-facing send is invoked for an offline approval, including when
  the sweep cron, the payment-reminder cron, and a later payment recording run afterward (see Test
  Plan T3).
- `docs/MILESTONE-EDITING.md` gains a row for the new milestone-creating path ("Offline CO approval",
  `approveChangeOrderOfflineCore`, notifies client: No), as that doc requires.

### G8. The signed portal path is unchanged

Acceptance:
- `approveChangeOrder`, `approveChangeOrderWithSignature`, and `approveChangeOrderCore` keep their
  signatures, error messages, and behavior. The shared-validation extraction (Approach §2) is
  behavior-preserving; existing messages are byte-identical.
- `billChangeOrderCore`'s external behavior (return shape, activity row, revalidation) is unchanged;
  it becomes a thin wrapper around the extracted in-transaction biller.
- `e2e/money-pipeline.spec.ts` (CO invariant cases around `:647-800`) stays green in PR CI.

### G9. (Optional, separate) MCP tool `approve_change_order_offline`

Ship only if time allows; G1 to G8 do not depend on it.

Acceptance:
- Registered in `src/app/api/mcp/[transport]/route.ts` with the same two-step confirmToken flow as
  `send_change_order` (`:1056-1115`; `mintPreviewToken`/`verifyPreviewToken` at `:85-99`).
- Inputs: `changeOrderId`, `method` (enum), `approvedOn` (optional `YYYY-MM-DD`, default today in
  company time zone), `note` (optional, ≤ 1,000), `confirmToken` (optional).
- The approver is a resolved human: `actor.resolveOnBehalfOf()` first, else the user behind
  `actor.resolveActorUserId()` (`route.ts:122-170`). That user must be ADMIN or MANAGER and not
  disabled; otherwise the tool refuses ("Mark it approved in ProBuild instead."). Never records a
  connector label as the approver.
- Preview (no token): code, title, status, subtotal/tax/total or cost-plus terms, method, date,
  recorded-by name, and "The customer will not be notified. Nothing goes to QuickBooks until you send
  it from the invoice." The token payload pins `changeOrderId`, `status`, `updatedAt`, `totalAmount`,
  schedule rows, `method`, `approvedOn`, `note`, and the approver user id.
- Confirm calls the same core with `expectedUpdatedAt` from the payload. Same zero-notification rule;
  the tool calls no send function.
- Added to `WRITE_TOOLS` (`route.ts:191-200`) and `ENTITY_TYPE_BY_TOOL` (`:235-239`) as
  `change_order`; NOT added to `SEND_TOOLS` (`:231-234`) or `READONLY_TOOLS`.
  `tests/mcp-readonly-key.test.ts` stays green.

## Non-Goals

- Automatic netting of unapplied QuickBooks payments against the new milestones.
- Any customer confirmation email, SMS, or portal notice for an offline approval.
- Changing the CO payment-schedule UI.
- Undoing an offline approval (see Rollback Plan for manual remediation).
- Fixing the pre-existing smells listed under Open Questions (separate issues).
- Changing who receives internal team notifications.

## Approach

### 1. Pure helpers (new `src/lib/change-order-offline-approval.ts`)

No Prisma or server-only imports, so it is unit-testable and importable by the client editor. It only
depends on `src/lib/tz-date.ts` primitives.

- Constants: `OFFLINE_APPROVAL_SOURCE = "OFFLINE"`; the method list with dialog labels (Phone, Text,
  Email, In person, Other) and display phrases (by phone, by text, by email, in person, other).
- `parseOfflineApprovalInput(raw, { now, timeZone })`: validates method against the list; validates
  `approvedOn` is a real `YYYY-MM-DD` calendar date (`classifyCalendarDate`) and not after today's
  company-time-zone day key (`dayKeyInTimeZone(now, timeZone)`); trims the note, empty → null,
  over 1,000 chars → error. Returns `{ method, approvedOn, approvedAt, note }` where `approvedAt =
  dateOnlyInTimeZone(approvedOn, timeZone)` (company-local noon, the repo's date-only convention, see
  `tz-date.ts:221-223`).
- `offlineApprovalSummary({ approvedBy, approvedAt, approvalMethod }, timeZone)`: returns
  "Approved by {name} on {Mon D, YYYY} ({method phrase})", formatting the date in the company time
  zone.
- `isOfflineApproval(co)`: `co.approvalSource === "OFFLINE"`.
- `offlineHoldMilestoneWhere(offlineCoIds)`: the null-safe Prisma fragment used by reminders (see §6).
  Returns `undefined` when the list is empty so callers can skip the clause.

### 2. Shared approval validation (`src/lib/change-order-core.ts`)

Extract the validation block of `approveChangeOrderCore` (`:383-406`: cost-plus schedule check,
section-row check, item presence, positive subtotal, stored = rendered subtotal) into an exported
in-transaction helper, for example `assertChangeOrderApprovableInTx(tx, current)`, taking the already
locked row. `approveChangeOrderCore` calls it in the same place with the same messages, so the signed
path is unchanged. Keeping one copy means the two approval paths can never drift.

Note `tests/estimate-item-payload.test.ts:568-580` counts `coSectionRowNames(` occurrences
(`change-order-core.ts`: 2 = write + approve; `billing-core.ts`: 2 = send + bill). With the extraction
the counts stay 2 and 2. If the doer duplicates instead, bump the count and its comment in the same
PR.

### 3. In-transaction biller (`src/lib/billing-core.ts`)

Extract the body of `billChangeOrderCore`'s transaction closure (`:1995-2150`) into
`billChangeOrderInTx(tx, changeOrderId)`, returning the same `outcome` union. `billChangeOrderCore`
becomes `withTxRetry(() => prisma.$transaction(tx => billChangeOrderInTx(tx, id), { timeout: 15_000 }))`
followed by its existing logging and revalidation (`:2153-2186`), unchanged. Lock order is unchanged:
CO row `FOR UPDATE` (`:1995-2000`), then `lockMoneyParents` estimate → invoice (`:2031`,
`src/lib/tx-retry.ts:103`).

### 4. Offline approval core (`src/lib/billing-core.ts`)

`approveChangeOrderOfflineCore(changeOrderId, input, dependencies?)`, placed next to
`handleChangeOrderApproved` (keep all billing-core edits below `:1787`, see Risks). One
`withTxRetry(prisma.$transaction(..., { timeout: 15_000 }))`:

1. Lock the CO row `SELECT ... FOR UPDATE` selecting `code, status, pricingType, totalAmount,
   updatedAt, projectId, approvedBy, approvedAt, clientSignatureUrl, approvalSource`. This is the same
   parent-row lock taken by edit, send, sign, bill, and co-audit repair (`change-order-core.ts:364-371`
   comment; `:92-112`; `billing-core.ts:1995-2000`; `:2328-2331`), so an offline approval and a portal
   signature serialize.
2. Not found → `NOT_FOUND`. Status `Approved` or any approval audit present → `ALREADY_APPROVED`
   (message names who: customer signed vs recorded by staff). Status not Draft/Sent → `NOT_APPROVABLE`.
3. `updatedAt` ≠ `input.expectedUpdatedAt` → `STALE`.
4. `assertChangeOrderApprovableInTx` (§2). Then, FIXED only, the schedule checks billing will need
   (mirror `billing-core.ts:2034-2057`): 0 or ≥ 2 rows, each > 0, sum = stored subtotal. Failing here
   gives a clear message before any write.
5. Update the CO: fields listed in G2.
6. FIXED: `billChangeOrderInTx(tx, id)`. On `ok: false`, throw a typed error carrying the billing
   message so the transaction rolls back; the core converts it to `BILLING_FAILED`.
7. Commit. Post-commit, best effort, each in its own try/catch, results into `warnings`: activity rows
   (G5), schedule hook (G5), team email (G5), revalidation of invoice pages.

`handleChangeOrderApproved` is **not** called. It re-bills and has customer-send logic; the offline
path does its own post-commit steps.

**Idempotency and races (existing patterns reused):** the CO row lock above; `withTxRetry`
(`tx-retry.ts:63`) for serialization retries, safe because everything rolls back; billing's
idempotent reuse of existing milestones by `sourceChangeOrderId`/name + exact amount
(`billing-core.ts:2067-2099`); and "only the call that transitioned runs automation"
(`actions.ts:9860-9865`, `billing-core.ts:2223-2228`). A second click sees status `Approved` inside
the lock and writes nothing.

### 5. Server action (`src/lib/actions.ts`)

Append `markChangeOrderApprovedOffline` at the **end** of `actions.ts` so no existing line moves
(two manifest tests key `actions.ts` by line number, see Risks). Extend the existing import on
`actions.ts:62` in place, or use a dynamic `await import("./billing-core")` like `:9868`. Steps: gate
(G3), load `projectId`, `canAccessProject`, resolve company time zone, call the core with
`actor = { userId: user.id, name: user.name?.trim() || user.email }`, revalidate, return a plain
serialized result. Business logic stays in the core.

### 6. Silence fixes (G7)

- **Sweep:** add `approvalSource: null` to the `findMany` where at `co-billing-sweep/route.ts:28-35`.
  Use an explicit `null` filter, not `{ not: "OFFLINE" }` (SQL `<>` drops NULL rows, which would skip
  every signed CO).
- **handleChangeOrderApproved guard:** add `approvalSource` to the select at `billing-core.ts:2200-2203`;
  if `"OFFLINE"`, return `{ billed: false, sent: false, issues: [], skippedOffline: true }`
  immediately. Extend the return type with the optional flag. The sweep reports
  "skipped (offline approval)" for that outcome.
- **Payment reminders:** once per run, read the ids of COs with `approvalSource = "OFFLINE"`. If any,
  add the hold clause to `eligibilityWhere` (`payment-reminders.ts:167-172`) and to the claim where
  (`:284-294`). The clause must be null-safe:
  `OR: [{ sourceChangeOrderId: null }, { sourceChangeOrderId: { notIn: ids } }, { qbInvoiceSentAt: { not: null } }]`.
  Do **not** write it as `NOT: { AND: [{ qbInvoiceSentAt: null }, { sourceChangeOrderId: { in: ids } }] }`:
  for an ordinary milestone `sourceChangeOrderId IN (...)` is NULL, `NOT(TRUE AND NULL)` is NULL, and
  every ordinary unrequested milestone would silently stop getting reminders. Do not add a second
  top-level `OR` key (eligibility already has `OR: throttleOr`); compose with `AND: [...]` exactly like
  the claim does at `:290`.
- **Receipt gate:** in `notifyMilestonePaid` add `sourceChangeOrderId` and `qbInvoiceSentAt` to the
  select (`payment-notifications.ts:87`). Before step 3 (`:174-181`), if `sourceChangeOrderId` is set
  and `qbInvoiceSentAt` is null, read that CO's `approvalSource`; if `"OFFLINE"`, skip the client
  receipt only. This adds a condition to the existing single writer; it does not add a writer
  (CLAUDE.md money-path rule).
- **RecordPaymentModal (nice to have, non-blocking):** when recording on such a milestone, show the
  same kind of note the modal already shows for back-dated payments
  (`src/components/RecordPaymentModal.tsx:122`): "This change order was approved outside ProBuild and
  hasn't been sent to the customer, so no receipt will be emailed automatically. Use the Send Receipt
  button if you want one." May ship as a follow-up if the plumbing is not trivial.

### 7. Editor, portal, PDF

- `page.tsx` (staff): compute `canMarkApproved` with `currentStaffUserOrNull()`
  (`src/lib/permissions.ts:81`) + `isAdminOrManager`; compute `todayInCompanyTz` and, for offline rows,
  the summary label; pass as props. The editor never decides the role itself.
- `ChangeOrderEditor.tsx`: new button, dialog modeled on the existing modals in the same file
  (`:688-746`), `hui-btn` classes, `sonner` toasts. Keep `latestUpdatedAt` state from the save result
  (`updateChangeOrder` returns the row) to pass as `expectedUpdatedAt`.
- Portal `page.tsx`: delete `approvalNote` from `initialData`; pass the server-formatted label.
- Portal client and `pdf.ts`: branch on `approvalSource === "OFFLINE"` as in G6; leave the signed and
  legacy branches untouched.

### Signatures (types only)

```ts
// src/lib/change-order-offline-approval.ts
export type OfflineApprovalMethod = "PHONE" | "TEXT" | "EMAIL" | "IN_PERSON" | "OTHER";
export function parseOfflineApprovalInput(
  raw: { method: unknown; approvedOn: unknown; note?: unknown },
  ctx: { now: Date; timeZone: string },
): { method: OfflineApprovalMethod; approvedOn: string; approvedAt: Date; note: string | null };

// src/lib/billing-core.ts
export type OfflineApprovalResult =
  | {
      ok: true;
      changeOrder: { id: string; code: string; projectId: string; pricingType: "FIXED" | "COST_PLUS" };
      approvedAt: string; // ISO
      billing:
        | { invoiceId: string; invoiceCode: string; amount: number; subtotal: number; taxAmount: number;
            milestones: Array<{ id: string; name: string; amount: number; created: boolean }> }
        | null; // null for COST_PLUS
      warnings: string[];
    }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_APPROVED" | "NOT_APPROVABLE" | "STALE" | "INVALID" | "BILLING_FAILED"; error: string };

export async function approveChangeOrderOfflineCore(
  changeOrderId: string,
  input: {
    method: unknown; approvedOn: unknown; note?: unknown; // parsed by parseOfflineApprovalInput
    expectedUpdatedAt: string;                           // ISO, optimistic-concurrency pin
    actor: { userId: string; name: string };
  },
  dependencies?: {
    now?: () => Date;
    logActivity?: typeof logActivityLazy;
    revalidatePath?: typeof revalidatePath;
    applySchedule?: (changeOrderId: string) => Promise<void>;
    notifyTeam?: typeof sendNotification; // team address only
  },
): Promise<OfflineApprovalResult>;

export async function billChangeOrderInTx(tx: Prisma.TransactionClient, changeOrderId: string): Promise</* same outcome union billChangeOrderCore builds today */ unknown>;

// src/lib/change-order-core.ts
export async function assertChangeOrderApprovableInTx(
  tx: Prisma.TransactionClient,
  current: { id: string; code: string; pricingType: string; totalAmount: unknown },
): Promise<void>;

// src/lib/actions.ts ("use server")
export async function markChangeOrderApprovedOffline(
  changeOrderId: string,
  input: { method: string; approvedOn: string; note?: string | null; expectedUpdatedAt: string },
): Promise<
  | { success: true; code: string; invoiceCode: string | null; milestoneCount: number; awaitingActuals: boolean; warnings: string[] }
  | { success: false; error: string }
>;
```

## UI copy

All new copy: plain words, no em dashes. `{…}` are values.

**Button:** `Mark approved`

**Dialog**
- Title: `Mark approved`
- Intro: `Use this when the customer approved {CO code} outside ProBuild, like on a call or by text.`
- Amount (fixed): rows `Subtotal {$}`, `{tax label} {$}`, `Total {$}`.
- Amount (cost plus): `Terms: cost + {n}% + tax, billed later from actual time and expenses.`
- Field: `How did the customer approve?` options `Choose one`, `Phone`, `Text`, `Email`, `In person`,
  `Other`. Error: `Choose how the customer approved.`
- Field: `Date approved`. Help: `You can pick an earlier date. It can't be in the future.` Error:
  `The approval date can't be in the future.`
- Field: `Note (optional)`. Placeholder: `For example: approved on a call with the project manager.`
  Help: `Only your team sees this note.`
- Notice (fixed): `The customer will not be notified. Send the bill from the invoice when you're
  ready.` Second line: `ProBuild adds this change order to the invoice now. Nothing goes to
  QuickBooks until you send it.`
- Notice (cost plus): `The customer will not be notified. Nothing is billed now. Bill the actual time
  and expenses from this page when the work is done.`
- Recorded by: `Recorded by {staff name}.`
- Buttons: `Cancel`, `Mark approved` (busy: `Marking approved…`).

**Toasts**
- Success (fixed): `{CO code} marked approved and added to invoice {INV code}. The customer was not
  notified.`
- Success (cost plus): `{CO code} marked approved. Bill actuals when the work is done.`
- Stale: `This change order changed since you opened it. Refresh and try again.`
- Already approved (customer signed): `The customer already signed {CO code}.`
- Already approved (office): `{CO code} is already marked approved.`
- Status: `Only Draft or Sent change orders can be marked approved.`
- Schedule: `The payment schedule doesn't add up to the subtotal. Fix the schedule, then try again.`
- Billing failed: `Couldn't add {CO code} to the invoice: {billing message}` (the reused billing
  messages are existing server text and are not rewritten).
- Warnings (post-commit): `Marked approved, but {warning}.`

**Details tab (staff):** chip `Approved offline` (instead of `Signed`); card lines `Approved by
{staff} on {date} ({method})`, `Not signed electronically.`, `Note: {note}` when present.

**Portal (customer):** badge `✓ Approved`; block title `Approved`; `Approved by {staff} on {date}
({method})`; `Recorded by the office. Not signed electronically.`

**PDF:** heading `Client Approval` (existing), `Approved by {staff} on {date} ({method})`,
`Recorded by the office. Not signed electronically.`

**Team email (internal):** subject `Change order approved by {staff} ({method phrase}): {CO code}
{title} ({total})`; body `{staff} recorded that the customer approved {CO code} {method phrase} on
{date}.` then fixed: `Added to invoice {INV code} as {n} unpaid milestone(s) for {total}. The
customer was not notified. Send the payment request from the invoice when you're ready.` or cost
plus: `No payment is due yet. Tag actual time and expenses to this change order, then run Bill
actuals.` then `Note: {note}` when present. HTML-escape every value (`escapeHtml`, as at
`billing-core.ts:2267`).

## Customer-notification audit (G7)

Method: every `sendNotification(`/`sendSMS(` call site in `src/` was enumerated and classified, plus
the QuickBooks email path and every cron in `vercel.json`. Verdicts as of `origin/main` `139885b1`.

| # | Path | Where | Verdict for an offline approval | Action |
|---|---|---|---|---|
| 1 | Signed-path automation (payment-request email + QB push) | `handleChangeOrderApproved` `billing-core.ts:2229-2238` → `sendMilestoneInvoicesCore` `:1150`, push `:1270`, email `:1123` | Not called by the offline path | Guard: early return for OFFLINE (G7) |
| 2 | CO billing sweep cron (hourly, :30) | `co-billing-sweep/route.ts:28-51` | **Would** call #1 for approvals aged 15 min to 2 h | Filter `approvalSource: null` + guard #1 |
| 3 | Payment-reminder cron (daily, emails client) | `payment-reminders.ts:161-172` selection, `:284-294` claim | **Leaks today**: selects any Pending milestone with a due date on an Issued/Overdue/Partially Paid invoice of a reminders-enabled project, with no check of `qbInvoiceSentAt` | Hold clause (G7) |
| 4 | Paid-milestone client receipt (manual Record Payment, Stripe, QB sync, outbox drain) | `notifyMilestonePaid` `payment-notifications.ts:85`, receipt `:181`; callers via `enqueueMilestonePaid` `payment-outbox.ts:43`; `payment-record-core.ts:184`; drain cron `drain-notifications` | **Leaks** when staff records a prior payment on the new milestone (auto receipt unless back-dated more than 3 days, `payment-date.ts:26`) | Receipt gate (G7) |
| 5 | Deposit photo path auto-apply | `deposit-ingest/route.ts:1618` (photo candidates need no `qbInvoiceSentAt`), receipt only suppressed for bank rows `:661-664` | **Leaks** if a check photo is applied to the new unrequested milestone | Covered by receipt gate #4 |
| 6 | Deposit bank sweep auto-apply | `deposit-ingest/route.ts:1391`, `:1551` (candidates must be requested), `:661-664` (suppresses receipt) | Silent: unrequested milestones are never candidates | None; test |
| 7 | QuickBooks payment sync cron | `quickbooks-payments.ts:3262-3268` (`qbInvoiceId: { not: null }`) | Silent: offline milestones have no QBO invoice | None; test |
| 8 | QuickBooks maintenance cron | `qbo-maintenance/route.ts:167` (`qbInvoiceId: { not: null }`), parked-marker sweep `:364-417` | Silent: no QBO invoice, no in-flight marker | None |
| 9 | QBO's own invoice email | `sendQBInvoice` `quickbooks.ts:2415-2431` has zero callers; QBO invoices are created only by explicit staff actions (`actions.ts:3835`, `billing-core.ts:900`, `:1270`, `:2924`, maintenance `push-milestone` POST) | Silent. QBO-side automatic reminders can only act on invoices that exist in QBO | None |
| 10 | Stripe / portal Pay | Pay buttons only for requested rows: `PortalInvoiceClient.tsx:395`, `portal/page.tsx:143`, `portal/projects/[id]/page.tsx:188`; unrequested rows show "Not yet due" | Silent (customer-initiated only, and gated) | None |
| 11 | Schedule hook | `applyChangeOrderToSchedule` `schedule-core.ts:3168`; module imports `:2-12` have no email/SMS | Silent | None |
| 12 | Activity log | `logActivity` `activity-log.ts:29` (DB write only); not rendered in any portal route | Silent | None |
| 13 | CO confirmation to client on approval | None exists; the signed path's only customer email is #1 | Silent | None |
| 14 | Signature request email | `sendChangeOrderToClientCore` `billing-core.ts:2304` refuses non Draft/Sent (`:2336-2338`); editor Send disabled when Approved (`ChangeOrderEditor.tsx:274`) | Silent after approval | None |
| 15 | Portal magic link | `emailPortalLinkToClient` `actions.ts:9444` (explicit button only) | Silent | None |
| 16 | Scheduled client messages cron | `send-scheduled-messages/route.ts:18-24` (only staff-composed `ClientMessage` rows) | Silent | None |
| 17 | AR digest, pipeline digest, Monday margin card, dragging line, COI check, receipt crons | `billing-core.ts:324-329`; `pipeline-digest`; `margin-digest.ts:206,251`; `check-cois`; receipt crons send no email | Internal/team or subcontractor only | None |
| 18 | Recurring docs | `cron/recurring-docs/route.ts` (contracts; not scheduled in `vercel.json`) | Silent | None |
| 19 | Invoice status bump | `billing-core.ts:2134` (Paid → Partially Paid); no listener sends on status change | Silent (reminder exposure handled by #3) | None |
| 20 | MCP tools | human-driven; send tools require confirmToken | Silent unless a human confirms a send | G9 follows the rule |

Explicit staff pushes that remain allowed: milestone Send (`actions.ts:2902` → `sendMilestoneInvoicesCore`),
whole-invoice Send (`billing-core.ts:653`), Resend (`:869`), Send Receipt (`actions.ts:4321`),
Send for Approval, portal-link email, client messages, and MCP send tools after confirmation.

## Files Touched

- `prisma/schema.prisma` (ChangeOrder fields)
- `prisma/migrations/<UTC timestamp>_change_order_offline_approval/migration.sql` (new)
- `scripts/apply-change-order-offline-approval.mjs` (new; pattern: `scripts/apply-receipt-intake-source-folder.mjs`, `scripts/lib/apply-target.mjs`)
- `scripts/ci-change-order-offline-approval-columns.mjs` (new; pattern: `scripts/ci-receipt-intake-source-folder-column.mjs`)
- `.github/workflows/ci.yml` (migrations job: apply-script step; DB test step like `:272-277`)
- `src/lib/change-order-offline-approval.ts` (new, pure)
- `src/lib/change-order-core.ts` (extract `assertChangeOrderApprovableInTx`)
- `src/lib/billing-core.ts` (`billChangeOrderInTx`, `approveChangeOrderOfflineCore`, post-commit team email, `handleChangeOrderApproved` guard, `getProjectBilling` fields)
- `src/lib/actions.ts` (new action appended at end; import line 62 extended in place)
- `src/app/projects/[id]/change-orders/[coId]/page.tsx`
- `src/app/projects/[id]/change-orders/[coId]/ChangeOrderEditor.tsx`
- `src/app/portal/change-orders/[id]/page.tsx`
- `src/app/portal/change-orders/[id]/PortalChangeOrderClient.tsx`
- `src/lib/pdf.ts`
- `src/app/api/cron/co-billing-sweep/route.ts`
- `src/lib/payment-reminders.ts`
- `src/lib/payment-notifications.ts`
- `src/components/RecordPaymentModal.tsx` (optional note)
- `src/app/api/mcp/[transport]/route.ts` (`list_change_orders` payload; G9 tool if shipped)
- `docs/MILESTONE-EDITING.md` (new table row)
- `tests/unit-list.txt` (the `test:unit` list)
- Tests: new files in the Test Plan; `tests/estimate-item-payload.test.ts` only if the section-row count changes; `tests/payroll-writer-manifest.test.ts` and `tests/payroll-user-writer-manifest.test.ts` only if a keyed line moves

## Data Model Changes

New nullable columns on `ChangeOrder` (additive, no backfill, no index; the offline set is small):

```prisma
  // Office-recorded approval: the customer approved outside ProBuild (phone, text, email, in person).
  // Set only by approveChangeOrderOfflineCore. Null for portal-signed and legacy rows.
  approvalSource String? // "OFFLINE" | null
  approvalMethod String? // PHONE | TEXT | EMAIL | IN_PERSON | OTHER (OFFLINE rows only)
  approvalNote   String? // staff-only; never rendered to the customer or printed on the PDF
```

Migration SQL:

```sql
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "approvalSource" TEXT;
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "approvalMethod" TEXT;
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "approvalNote" TEXT;
```

Semantics of existing columns on OFFLINE rows: `approvedBy` = staff display name; `approvedAt` = the
entered approval calendar date at company-local noon; `clientSignatureUrl` = null. No CHECK
constraints (Prisma cannot represent them and the migration-drift checks would flag them); the core
enforces the invariants.

**Deploy order (mandatory):** run the apply script against production **before** merging. Every CO
query uses `include`, so the new Prisma client selects the new columns immediately and would throw
P2022 on every CO page until they exist (CLAUDE.md pre-deploy checklist item 2; invocation per the
`scripts/apply-receipt-intake-source-folder.mjs` pattern and `docs/DB-MIGRATE-WORKFLOW.md`).

## Test Plan

Runner: Node's test runner through tsx. CI runs `npm run test:unit` on Ubuntu. Run single files directly, then the **whole** list before pushing:

```powershell
node --import tsx --test tests/change-order-offline-approval.test.ts   # one file
npm run test:unit                                                       # the whole list, before pushing
```

Every new hermetic test file must be added to `tests/unit-list.txt` (the `test:unit` list). Module fakes use
the scoped CommonJS `require` patch used by `tests/ar-digest-listing.test.ts` and
`tests/deposit-sweep.test.ts` (`mock.module()` is unusable; CI pins Node 20).

**T1. Pure helpers** (`tests/change-order-offline-approval.test.ts`, hermetic) → G2, G4, G6
- Each method accepted; unknown/empty rejected.
- `approvedOn` today and a past date accepted; tomorrow rejected; `2026-02-30` rejected; boundary
  checked in a non-UTC company zone near midnight.
- Note trimmed, empty → null, 1,001 chars rejected.
- `approvedAt` equals company-local noon of the date.
- Summary label renders the company-zone date for an instant that would be a different day in UTC.
- `offlineHoldMilestoneWhere([])` is `undefined`; non-empty returns the null-safe three-way `OR`.

**T2. Core behavior** (`tests/change-order-offline-approval-core.test.ts`, hermetic, loads real
`billing-core.ts` with fake `@/lib/prisma`, `./email`, `next/cache`, and fakes that throw if loaded
for `./quickbooks-payments` and `./quickbooks`) → G2, G5
- FIXED happy path: CO update carries every G2 field; `billChangeOrderInTx` runs on the same fake tx;
  activity rows written; team email sent only to the company notification address; no QuickBooks
  module loaded; no email to the client address.
- COST_PLUS happy path: approval only, `billing: null`.
- Each refusal in G2 returns its code and performs no `changeOrder.update`.
- Billing `ok: false` → `BILLING_FAILED` and the error propagates out of the transaction callback
  (rollback shape; real rollback is proven in T4).
- Post-commit failures (activity, schedule, email) become `warnings`; result still `ok: true`.

**T3. Silence** (`tests/change-order-offline-silence.test.ts`, hermetic) → G7 (owner acceptance)
- Sweep: the `findMany` where contains `approvalSource: null`. With a fake that ignores the filter and
  returns an OFFLINE CO in the time band, `handleChangeOrderApproved` returns `skippedOffline`, and no
  billing, send, QuickBooks call, or email of any kind happens.
- `handleChangeOrderApproved` for a signed CO (`approvalSource: null`) behaves as today (send path
  invoked once for fresh milestones).
- Reminders: with an OFFLINE CO's unrequested milestone due tomorrow on an Issued invoice of a
  reminders-enabled project, both the selection and the claim where carry the hold; the run sends
  nothing to the client. The same milestone with `qbInvoiceSentAt` set becomes eligible. An ordinary
  unrequested milestone (`sourceChangeOrderId: null`) stays eligible (guards the NULL trap).
- Receipt gate: `notifyMilestonePaid` for a held milestone sends the team alert and writes the
  activity row but no client receipt, and leaves `receiptSentAt` null; for the same milestone after
  `qbInvoiceSentAt` is set, the client receipt goes out as today.
- End to end in one harness: offline approval → sweep run → reminder run → Record Payment settle →
  outbox drain. Recorded sends: zero to the client address, zero SMS, zero QuickBooks calls.

**T4. Real Postgres** (`tests/change-order-offline-approval-db.test.ts`, opt-in by URL like
`tests/change-order-tag-race-db.test.ts`; new step in the CI migrations job modeled on `ci.yml:272-277`)
→ G2, G8
- Approve + bill commit together: CO Approved with OFFLINE fields, milestone rows exist, invoice
  totals incremented once.
- No invoice on the project: result `BILLING_FAILED`, CO still Draft/Sent, no approval fields written,
  no milestones.
- Double call: second returns `ALREADY_APPROVED`; one set of milestones.
- Offline vs portal signature started concurrently on real connections: exactly one Approved outcome,
  one set of milestones; if offline won, `approveChangeOrderCore` throws "must be Sent".
- Two offline calls concurrently: one wins, one `ALREADY_APPROVED`.

**T5. Server action gate** (hermetic or extend `tests/server-action-gates.test.ts` expectations) → G3
- The new export passes the AST gate test. ADMIN and MANAGER allowed; FIELD_CREW and FINANCE
  `Forbidden`; no session `Unauthorized`.

**T6. Regression** → G8
- The whole `test:unit` list passes, including `tests/estimate-item-payload.test.ts`,
  `tests/server-action-gates.test.ts`, `tests/mcp-readonly-key.test.ts`,
  `tests/apply-scripts-inert-on-import.test.ts`, and both writer-manifest tests.
- `npm run build` passes with 0 errors.
- PR CI Playwright job keeps `e2e/money-pipeline.spec.ts` green.

**T7. UI and portal, manual** → G4, G6
- As ADMIN on the sanctioned prod test project ("Shop", see CLAUDE.md) after deploy: create a CO with
  two schedule rows, Mark approved (Phone, earlier date, note). Confirm the toast, the Details tab
  text, invoice milestones marked "Not yet due" in the portal, the portal CO block and badge, the
  portal Download PDF, the staff PDF, and that the note appears nowhere on customer surfaces.
  Confirm the team inbox got the internal email and the test client inbox got nothing.
- As a MANAGER the button shows; as FINANCE or FIELD_CREW it does not.
- Optional: a Playwright spec on the throwaway CI database covering the dialog, with `afterAll`
  teardown per `docs/TESTING.md`.

**T8. MCP (only if G9 ships)**
- Preview returns a token and writes nothing; confirm with a stale token (CO edited) returns a fresh
  preview; confirm with a valid token approves via the core; unresolvable or non-admin actor refused;
  no send function invoked; `WRITE_TOOLS` contains the tool and `SEND_TOOLS` does not.

**CI facts:** CI runs only on pull requests into `main` and pushes to `main` (`ci.yml:3-7`). A PR
stacked on another branch gets no build, unit, DB, or Playwright run, so open the implementation PR
against `main`. Jobs: `migrations` (throwaway Postgres; migrations, apply scripts, `-db` tests),
`build` (format check non-blocking and `*.md` is prettier-ignored; `npm run test:unit`; `npm run
build`), `Playwright E2E Tests` (throwaway Postgres; mocks for storage, QuickBooks, AI).

**Review:** this is money-path code (signing, billing, notifications). After implementation run the
`codex-reviewer` agent on the diff per the repo's CLAUDE.md money-path rule, then a checker pass
against this spec before merge. Do not merge without the owner's go-ahead.

## Risks

- **Billing double-post.** Mitigated by approving and billing in one transaction under the CO row lock,
  billing's existing idempotent reuse, the stale `expectedUpdatedAt` pin, the sweep filter, and the
  `handleChangeOrderApproved` guard. T4 proves the races on real connections.
- **Customer notified anyway.** Three live leaks exist today (#2 sweep, #3 reminders, #4/#5 receipts).
  G7 closes them; T3 is the owner's acceptance test. The reminder hold must be NULL-safe (see §6) or it
  silently stops reminders for ordinary milestones.
- **QuickBooks side effects.** None from the offline path: no push, no QBO invoice, no QBO email
  (`sendQBInvoice` has no callers). The first QBO invoice for these milestones appears when staff
  sends from the invoice.
- **Auth.** The action is a public server-action endpoint; it must self-gate (AST test) and derive the
  approver from the session, never from input. ADMIN/MANAGER only.
- **Deploy order.** Schema must be applied to prod before merge (auto-deploy on merge) or every CO page
  errors with P2022.
- **Line-number manifests.** `tests/payroll-writer-manifest.test.ts` and
  `tests/payroll-user-writer-manifest.test.ts` key call sites by line in `lib/actions.ts` (for example
  `:3717`, `:8334`, `:15569` ... `:17058`) and `lib/billing-core.ts:1787`. Append the action at the end
  of `actions.ts`, extend import lines in place, keep billing-core edits below `:1787`. If anything
  above a keyed line moves, update the keys in the same PR and re-run the whole list.
- **Refactor of `billChangeOrderCore`.** Extraction must be byte-for-byte behavior-preserving; covered
  by T2/T4 and the Playwright money pipeline.
- **Partial prior payments.** Record Payment settles a whole milestone, and re-splitting an invoice
  with CO billing is blocked (`billing-core.ts:3049-3068`, `:3123`). Practical workflow: before
  marking approved, split the CO payment schedule so one row equals what the customer already paid
  (remember milestones are tax-inclusive), then record that row paid and send the rest. Editing a CO
  milestone amount afterward would make any later re-bill refuse on the exact-amount match
  (`billing-core.ts:2086-2088`); the offline path never re-bills, so this only matters for manual MCP
  use.
- **Time zones.** Date-only input stored as company-local noon; labels formatted server-side in the
  company zone.
- **Transaction timeout.** Approve + bill in one 15 s transaction, same budget as billing today.

## Rollback Plan

- **Code:** revert the implementation PR (auto-deploy ships the revert). The columns are additive and
  nullable; old code ignores them. Leave them in place (no destructive migration).
- **Before reverting,** if any OFFLINE approvals exist with unrequested milestones, set
  `PAYMENT_REMINDERS_DRY_RUN=1` in Vercel (the existing kill switch, `payment-reminders.ts` header and
  `cron/payment-reminders/route.ts:15-20`) until those milestones are sent or paid, because the revert
  removes the reminder hold. The sweep's existing "already billed" check
  (`co-billing-sweep/route.ts:39-49`) keeps it from re-billing those COs. After a revert the portal
  would show those rows with the old "Electronically Signed" wording, so prefer a forward fix.
- **Partial rollback:** hide the button (UI only) and keep the silence guards; they are no-ops for
  data without `approvalSource = "OFFLINE"`.
- **Single mistaken approval (no undo in v1):** delete the unpaid CO milestones from the invoice
  (`deleteInvoiceMilestoneCore`, allowed for Pending rows without a QBO link), then create a new CO if
  needed. The CO stays Approved in the audit trail.

## Open Questions

1. **Role gate.** Spec uses ADMIN + MANAGER (parity with countersign). If the office person who takes
   phone approvals is FINANCE, they cannot use it. Alternative: ADMIN + FINANCE, the stricter money
   gate `canResolveAmbiguousCreate` (`access-rules.ts:39-41`). Recommendation: ADMIN + MANAGER now,
   widen later if needed.
2. **Receipt on recording a prior payment.** Spec suppresses the automatic receipt for unrequested
   offline-CO milestones (owner rule: only explicit pushes). Staff can still click Send Receipt.
   Confirm this is wanted.
3. **Portal line "Recorded by the office. Not signed electronically."** Added for honesty next to the
   brief's "Approved by {staff} on {date} ({method})". Confirm the wording.
4. **No invoice yet.** Spec refuses the approval (atomic approve + bill) with the billing message.
   The alternative (approve now, bill later) would need a separate unbilled-CO recovery path.

Pre-existing smells found while researching (not in scope, worth separate issues):
- `payment-reminders.ts` ignores the requested marker (`qbInvoiceSentAt`) for every milestone, so a
  customer can be reminded about a milestone the portal shows as "Not yet due".
- `billChangeOrderCore` logs its activity row as actor "ChatGPT connector" (`billing-core.ts:2158`)
  even when the portal signature triggered it.
- `sendQBInvoice` (`quickbooks.ts:2415`) has no callers.
- `src/components/ActivityFeed.tsx` is not imported anywhere; its `approved_change_order` config is
  unused.
- `cron/recurring-docs` exists but is not scheduled in `vercel.json`.

Corrections to the original brief (verified in code): `handleChangeOrderApproved` is at
`billing-core.ts:2189-2297` (actions.ts `:9860-9879` is its `after()` call site); the QuickBooks push
happens inside `sendMilestoneInvoicesCore` (`:1270`), not in `billChangeOrderCore`; and
`approveChangeOrderCore` does not check schedule sums (billing does, `:2054-2057`), so the offline
core adds that check up front.
