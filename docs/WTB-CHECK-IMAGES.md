# WTB check & deposit images — how it actually works

Verified live 2026-08-19 against the real bank UI.

## Session rules (learned the hard way — cost 3 logins)

- **NEVER `goto_url()` a watrust URL.** Navigating an unauthenticated tab to
  a bank URL invalidates the session server-side for EVERY tab. Cookies
  survive, but the session is dead.
- **Attach to the tab Justin logged in on.** Find it via
  `Target.getTargets` → filter `watrust` → `Target.attachToTarget`.
- **Only ONE bank tab may exist.** Two tabs on one session fight and the
  bank kills the older one. That is Justin's "the tab goes away".
- **`el.click()` silently no-ops on this app.** Use real mouse events:
  `Input.dispatchMouseEvent` mousePressed + mouseReleased at the element's
  centre coordinates. In-page nav elements work; URL nav does not.

## Getting to the transactions

1. Click `#gmp-PAYMENTS\\/smbAccountsCenter` (the app's own Accounts link)
2. Click the element whose text matches `x0723`
3. Lands on `/ui/BANK_ACC_INFO/depositAccountsTransactions`

Grid defaults to **Last 7 Days**, 10 rows/page, **paginated** — 5 pages for
a week. Pager: `button.next-page` / `button.prev-page` (real mouse click).

## The image mechanism

Rows that have an image carry:

```html
<button class="image-indicator" data-hook="image-button">
```

Clicking it goes to `/ui/BANK_ACC_INFO/depositAccountImage`, which renders
the document as **base64 JPEG `<img>` tags inline in the page** —
`data:image/jpeg;base64,...`, ~1704x705, front and back. There is NO
separate download endpoint and no second auth. Just read `img.src`,
`base64` decode, write bytes.

Metadata is plain text on that page: `Date`, `Amount`, `Check Number`.
Return to the grid with `a.return-to-workspace` ("Back To Previous Page").

## What the images actually contain

**Checks WRITTEN (money out)** — full customer check image:
payer, payee, amount, date, **memo line**, signature, MICR.
Example: check 1029, $6,000.00, 8-17-26, payee "UNITED INTERIOR",
memo **"MESPLAY INV 3100"** — vendor AND job, straight off the paper.

**Deposits (money in)** — NOT the customer's check. WTB stores a
`SUBSTITUTE IMAGE / VIRTUAL DOCUMENT`: a teller receipt showing branch,
teller ID, drawer/trans #, R/T + account, and the total amount. Reverse is
a bank endorsement stamp.

So a **branch-deposited** check does not yield the payer's name. To learn
WHO paid, use the teller coordinates as the join key instead:
`Branch 350 / Drawer 35002 / Trans 8 / 2026-08-17 15:27` uniquely
identifies the teller transaction, and HIN `972511940000021`.

Mobile/remote-deposit items MAY carry the real check image — untested,
none in the current window.

## Deposits — the filter that matters (Justin, 2026-08-19)

Money IN is found by FILTER, not by the "Checks Paid" saved view:

1. **Filter → Select fields → Transaction Description**
2. Type **`Deposit`**
3. Range **94 Days**; set **Display 100 per page** (bottom right) to get
   every row on one page — no pagination walk needed.

That yields ~16 rows of `OTHER DEPOSITS`, each with an Image. This is the
list that answers "did the customer pay?".

**`Bank Reference` is the stable per-deposit id** (e.g. `26229015021344`)
and is the natural `sourceExternalId` for BankImage idempotency.

`Transaction` column distinguishes `DEPOSIT - ...` (branch) from
`MOBILE D...` (remote deposit). Mobile rows also carry a
`Customer Reference` (e.g. `2343776286`) and are the ones most likely to
hold a REAL check image rather than a teller receipt.

## KNOWN BLOCKER — browser harness target routing (2026-08-19)

After many tab switches the harness wedged: `Target.getTargets` correctly
lists the watrust tabs, but EVERY `Target.attachToTarget` +
`Runtime.evaluate` evaluates against a different page (whatever was focused
last), reporting `location.origin === "https://constructionio.com"` while
claiming to be attached to the bank target. `ensure_real_tab()` did not
clear it; closing the stray `file://` tabs did not clear it; Chrome's
`/json/list` is unavailable because the harness owns the debug port.

**Recovery: restart Chrome, then log in to WTB fresh, and work the bank tab
FIRST before opening any local `file://` previews in the same browser.**
Do local-file screenshots in a separate named browser session
(`session=` arg) so they never share the tab pool with a bank session.

