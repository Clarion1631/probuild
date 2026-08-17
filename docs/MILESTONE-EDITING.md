# Milestone editing — who can change client-visible money, where, and what the client is told

Standing directive (Justin, 2026-08-13, after the Mesplay INV-00171 drift): milestone
editing must be locked down once the client can see the money, and **no milestone edit
may ever send a notification to the customer**. This doc is the map of every edit path
so future work doesn't reopen a trap. Update it in the same PR as any change to these
paths.

## What the client actually sees

| Estimate state | What the client sees |
|---|---|
| Never sent, never invoiced, never viewed | Nothing they've looked at. Edit freely. **Known gap:** `getEstimateForPortal` authorizes any estimate the portal client owns, without checking status or `sentAt` — a client who guesses/follows a portal link CAN open an unsent draft (tracked as a separate fix). The editor lock treats `viewedAt` as client-visible to compensate. |
| Sent / Viewed / Approved, no invoice yet | The **estimate's own** payment schedule, in the portal and on any re-send. |
| Invoiced, invoice has payment rows | The **invoice's** schedule (`Invoice.payments`). Estimate-side edits are invisible to the client and do NOT change what they owe. |

The portal switches to invoice rows on the raw `payments.length`, then hides
"Payment in Full" rows — the editor's divergence panel (#363) compares in that same
order.

## The editor lock (this change)

`EstimateEditor.tsx` locks the whole Payment Schedule section when the money is
client-visible: an invoice exists, `sentAt` or `viewedAt` is set, or status is
Sent/Viewed/Approved/Invoiced/Paid. An estimate that has never been sent, viewed,
or invoiced is never locked — the pre-send workflow is unchanged. (A Draft that
HAS one of those markers — e.g. status manually reset after sending — stays
locked; the markers win over the status label.)

While locked:
- Every milestone input (name, %, amount, due date) is disabled.
- Add milestone / delete / "Add remainder to last milestone" are unavailable, and the
  underlying handlers early-return as defense in depth.
- The `[total]` recalc effect is skipped — opening the editor or editing line items
  can never mutate a locked schedule, not even its percentage-driven rows.
- AI generate/import merges items but leaves the schedule untouched (a payload that
  carries its own milestones gets a toast saying they were not applied).
- Record Payment, receipts, and Undo payment still work — those are payment
  lifecycle, not schedule editing. Record Payment and Undo confirm via their own
  modals; Send/Resend Receipt fires directly from the row button.

"Locked — unlock to edit" (header of the schedule section) opens a confirm dialog and
unlocks until the page is left. Nothing is persisted about the unlock. After unlock,
edits behave exactly like a draft, including the container-blur autosave — the unlock
confirm is the deliberate step that makes that acceptable.

## Every milestone-mutation path, audited 2026-08-13

**Invariant: none of these may ever email/notify the client.** The only paths that
email are the explicit Send button, the explicit receipt buttons, and the
payment-settlement outbox (`enqueueMilestonePaid` → `src/lib/payment-notifications.ts`),
which fires on *payments*, never on edits.

| Path | Where | Notifies client? |
|---|---|---|
| Estimate save (editor autosave + Save) | `saveEstimate`, `src/lib/actions.ts` (paymentSchedules upsert in the save transaction) | No |
| Send estimate | `sendEstimateToClient`, `src/lib/actions.ts` | Sends the estimate email deliberately. Since #362 it does **not** rewrite milestones — a schedule whose unpaid sum differs from balance due by more than one cent **blocks the send** with an error (the 1¢ tolerance absorbs rounding). |
| Invoice "Edit amounts" | `updatePendingMilestoneAmountsCore`, `src/lib/billing-core.ts` | No (QB re-staging only) |
| Split invoice milestones | `splitInvoiceMilestonesCore`, `src/lib/billing-core.ts` | No |
| Add invoice milestone | `addInvoiceMilestone`, `src/lib/actions.ts` | No |
| Delete invoice milestone | `deleteInvoiceMilestoneCore`, `src/lib/billing-core.ts` | No |
| Payment settle | `recordPayment`, `recordEstimatePayment`, Stripe webhook, portal payment, QB sync | Yes — by design, via the single-writer outbox (`enqueueMilestonePaid`). This is payment lifecycle, not editing. |
| Payment unsettle (undo) | `unrecordPayment` / `unrecordEstimatePayment` | No — both mirrors are released, but no notification is enqueued. |

If you add a new milestone-mutating path: it must not notify, it must respect the
mirror invariant (`PaymentSchedule.sourceScheduleId` pairs update together), and it
gets a row in this table.

## History of the editor traps (why this exists)

- **#362** — `recalcMilestoneAmounts` only touches percentage-driven rows now; a
  hand-typed dollar amount is never overwritten. The old "last unpaid absorbs the
  residual" rewrite (editor + send path) reverted Mesplay's hand-corrected amounts on
  every blur and autosaved the revert. Send now blocks on mismatch instead.
- **#363** — divergence panel: the editor warns row-by-row when the estimate schedule
  differs from what the client sees on the invoice.
- **Scroll-wheel trap** — the % field is `type="text"` on purpose: a number input
  turns wheel/arrow events into onChange, silently promoting the derived (italic)
  percentage into a stored one and converting a fixed-dollar row to percentage-driven.
- **This change** — the lock above, plus the `[total]` effect and AI-import gates.
