# Fix: PortalPayButton "Total to Pay" shows wrong amount (Prisma Decimal string concatenation)

## Context

The estimate payment modal shows **$272,078.88** as "Total to Pay" when it should be **$2,798.88** ($2,720.00 milestone + $78.88 fee). Root cause: Prisma `Decimal` fields arrive as **strings** after server-to-client serialization, and JavaScript's `+` operator concatenates strings instead of adding numbers.

Screenshot evidence: Milestone Amount correctly shows $2,720.00, Processing Fee correctly shows $78.88, but Total to Pay shows $272,078.88 — classic `"2720" + 78.88 = "272078.88"` string concatenation.

**This bug affects both invoice and estimate payments** anywhere `PortalPayButton` is used with `passProcessingFee` enabled.

## Root Cause

`src/components/PortalPayButton.tsx` lines 26-33:

```js
const rate = settings?.cardProcessingRate ?? 2.9;   // "2.9" (string from Decimal)
const flat = settings?.cardProcessingFlat ?? 0.30;   // "0.30" or 0 (depends on DB)

const feeAmount = (passFee && isFeeMethod) ? ((amount * (rate / 100)) + flat) : 0;
const totalAmount = amount + feeAmount;  // BUG: string + number = string concatenation
```

- `amount` prop typed as `number` but arrives as string from Prisma Decimal serialization
- `rate / 100` works (division coerces to number), `amount * 0.029` works (multiplication coerces)
- But `amount + feeAmount` uses `+`, which concatenates if either operand is a string

The server-side `create-session/route.ts` is **already safe** — uses `Number()` on all Decimal fields (lines 62-64, 86, 143-145, 167).

## Fix

**File:** `src/components/PortalPayButton.tsx`

3 lines changed — add `Number()` coercion to all Decimal-sourced values:

```js
// Line 27-28: coerce Decimal settings
const rate = Number(settings?.cardProcessingRate ?? 2.9);
const flat = Number(settings?.cardProcessingFlat ?? 0.30);

// Line 32-33: coerce amount prop + ensure totalAmount is arithmetic
const feeAmount = (passFee && isFeeMethod) ? ((Number(amount) * (rate / 100)) + flat) : 0;
const totalAmount = Number(amount) + feeAmount;
```

## Verification

1. Edit `PortalPayButton.tsx` — apply the 3-line fix
2. `npm run build` — must pass with 0 errors
3. Open estimate portal -> click Pay Now on a milestone -> verify:
   - Milestone Amount: $2,720.00
   - Processing Fee (2.9%): $78.88
   - **Total to Pay: $2,798.88** (not $272,078.88)
4. Test with ACH selected (no fee) — Total should equal Milestone Amount exactly
5. Click "Continue to Checkout" — verify Stripe charges the correct amount

---

# Issue 2: "An error occurred with our connection to Stripe. Request was retried 2 times."

## Context

After the Total to Pay fix, clicking "Continue to Checkout" throws a `StripeConnectionError`. The Stripe SDK (v20.4.1) retried the `checkout.sessions.create()` call 2 times and all attempts failed at the network level.

## Diagnosis

The `create-session/route.ts` logic is sound — same code path works for invoice payments. The error is NOT a code bug but an infrastructure issue. Likely causes ranked by probability:

1. **Stripe API version mismatch** — `src/lib/stripe.ts` uses `apiVersion: "2024-12-18.acacia"` but the installed Stripe SDK v20.4.1 expects `2026-02-25.clover`. While Stripe is backwards-compatible, the SDK may have internal validation that causes connection issues with very old versions.

2. **Stale Stripe key on Preview** — `STRIPE_SECRET_KEY` was updated on Production 4h ago but the Preview/Development key is 12 days old. If the old key was revoked during rotation, Preview deployments fail.

3. **Transient Vercel cold start** — first invocation of the serverless function can timeout connecting to Stripe. Retry once and it works.

## Fix

**File:** `src/lib/stripe.ts`

Update the API version to match the installed SDK:

```ts
export const stripe = new Stripe(stripeKey, {
    apiVersion: "2026-02-25.clover" as any,
    appInfo: {
        name: "ProBuild",
        version: "0.1.0",
    },
});
```

**Also:** Sync the Preview `STRIPE_SECRET_KEY` with Production if the key was rotated:

```bash
vercel env rm STRIPE_SECRET_KEY preview --token $VERCEL_TOKEN
vercel env add STRIPE_SECRET_KEY preview --token $VERCEL_TOKEN
```

## Verification

1. Update `src/lib/stripe.ts` API version
2. `npm run build`
3. Push to main
4. Open estimate portal → Pay Now → should redirect to Stripe Checkout without connection error
5. If error persists, check Vercel function logs: `vercel logs --token $VERCEL_TOKEN`
