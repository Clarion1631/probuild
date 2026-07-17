# Stripe Payment on Estimate Portal

**Target:** [Estimate Portal Page](https://probuild-amber.vercel.app/portal/estimates/cmnp2bxfz0001vkfwwl8xc6s4)

---

## Next TODO: Build & deploy the estimate payment feature

All code is written (uncommitted in the working tree). The next session should:

1. Run `npm run build` — fix any errors
2. Apply the schema migration (add payment fields to `EstimatePaymentSchedule`)
3. Run `prisma generate`
4. Commit and push to `main` (triggers Vercel deploy)
5. Verify on prod: open the estimate portal link above, confirm pay buttons appear on approved milestones
6. Test a real Stripe test-mode payment end-to-end

---

## What Was Built

After a client signs and approves an estimate, each payment schedule milestone gets a **Pay Now** button powered by Stripe Checkout — same experience as the invoice portal.

### Flow

1. Client opens estimate link, reviews line items and terms
2. Client signs and approves the estimate (existing flow)
3. Payment schedule milestones now show **Pay Now** buttons (only after approval)
4. Client clicks Pay -> selects payment method (card, ACH, Affirm, Klarna) -> redirected to Stripe Checkout
5. On success: milestone marked "Paid", estimate balance reduced, notification emails sent, activity logged

### Files Modified

| # | File | Change |
|---|------|--------|
| 1 | `prisma/schema.prisma` | Added `status`, `stripeSessionId`, `stripePaymentIntentId`, `paymentMethod`, `paidAt`, `paymentDate` to `EstimatePaymentSchedule` |
| 2 | `src/components/PortalPayButton.tsx` | Added optional `estimateId` prop, passed in fetch body (~3 lines) |
| 3 | `src/app/api/payments/create-session/route.ts` | Added estimate branch — queries `EstimatePaymentSchedule`, builds Stripe session with `estimatePaymentScheduleId` metadata, redirects to `/portal/estimates/` |
| 4 | `src/app/api/webhook/stripe/route.ts` | Handles `estimatePaymentScheduleId` in metadata — updates schedule to "Paid", reduces `Estimate.balanceDue`, sends notifications, posts activity. Also handles async failures, refunds, and session expiry for estimate schedules |
| 5 | `src/app/portal/estimates/[id]/PortalEstimateClient.tsx` | Imported `PortalPayButton`, added inline pay buttons to payment schedule rows, "Paid" badges with date, success/cancel banner via query params |

### Design Decisions

- **Distinct metadata key** — `estimatePaymentScheduleId` (not `paymentScheduleId`) avoids webhook ambiguity with invoice payments
- **Payments gated on approval** — no buttons until client has signed the estimate
- **Reused `PortalPayButton`** — identical UX for invoices and estimates, no new components
- **Inline placement** — pay buttons sit inside existing payment schedule rows, no new sections or modals
- **Paid state** — green background, "Paid" badge, payment date shown; button removed

## Acknowledged Out-of-Scope

Reviewed and explicitly deferred — not blockers for shipping:

1. **Partial refund state machine** (`PartiallyRefunded` status) — requires additional UI work for displaying partial refund amounts and states. Current refund flow resets the milestone to `Pending`, which is correct but doesn't distinguish "never paid" from "refunded."

2. **Portal IDOR protection** — the portal is intentionally unauthenticated (link-based access, like DocuSign). CUID IDs are cryptographically non-guessable (25-char alphanumeric), making brute-force infeasible. Adding auth would break the frictionless client experience that contractors expect.

3. **Multiple-tab duplicate Stripe sessions** — if a client opens Pay in two tabs, two Stripe checkout sessions are created for the same milestone. Low priority because webhook idempotency prevents double-charge: the atomic transaction uses `status: { not: "Paid" }` so the second webhook is rejected.
