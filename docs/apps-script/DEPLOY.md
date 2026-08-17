# Receipt automation v2 — deploy guide

Four fixes for "receipts go missing," in the `QBO Automation` Apps Script project.

| # | Fix | File |
|---|-----|------|
| 1 | Email receipts read the **right mailbox** (rlord@ now → receipts@ later) and drop into the one intake | `pullReceiptEmails.gs` (new) |
| 2 | **Recursive Shop scan** — nested category folders no longer strand receipts | `runReceiptAutomation.gs` (replace) |
| 3 | **Content dedup** — one purchase books once across photo/email/portal | `runReceiptAutomation.gs` (replace) |
| 4 | **ProBuild hook** — project receipts flow to ProBuild → profitability | `sendToProBuild.gs` (new) + step 5.5 (already in the v2 main file) |

## Apply
1. **Replace** the contents of `runReceiptAutomation.gs` with the v2 file here. (Same trigger, same function name — your existing 10-min trigger keeps working.)
2. **Add** `sendToProBuild.gs` as a new script file (paste).
3. **Add** `pullReceiptEmails.gs` as a new script file (paste). It supersedes the old `processLowesReceipts` — delete that old function so it can't double-save.
4. **Config check:**
   - `GEMINI_API_KEY` in `Config.gs` (unchanged).
   - `SERVICE_ACCOUNT_KEY` in Script Properties (already there for `ServiceAccount.gs`).
   - `RECEIPT_INGEST_SECRET` is set in ProBuild's Vercel env and equals `PROBUILD_INGEST_KEY` in `sendToProBuild.gs`. *(Recommended: move that key out of source into Script Properties.)*
   - The **OAuth2 library** is already added (`ServiceAccount.gs` uses it).

## One-time: domain-wide delegation (so the service account can read rlord@)
The service account reads Gmail by *impersonating* the mailbox. Authorize it once:

1. Get the service account's **numeric Client ID** — Google Cloud console → IAM & Admin → Service Accounts → (the one in `SERVICE_ACCOUNT_KEY`) → "Unique ID". (`client_email` is in the key too.)
2. **admin.google.com** → Security → Access and data control → **API controls** → **Manage Domain-Wide Delegation** → **Add new**:
   - **Client ID:** the numeric Unique ID
   - **OAuth scopes:** `https://www.googleapis.com/auth/gmail.modify`
   - Authorize.
3. In Apps Script, run **`testMailboxAccess`**. Expected log: `✅ Impersonated rlord@… — found N Lowe's message(s)`. If it errors on `unauthorized_client`, the delegation hasn't propagated (wait a few min) or the scope/Client ID is off.

## Turn it on
- Add a **second time-driven trigger**: function `pullReceiptEmails`, every 10 minutes.
- Receipts from `RECEIPT_SENDERS` (Lowe's, Home Depot, Costco, Harbor Freight…) **and** anything you label `Receipts` in the mailbox get pulled into the intake, then the main automation OCRs / QBOs / ProBuilds / archives them. Add vendors to `RECEIPT_SENDERS` as needed.

## When Lowe's is updated in-store
Change one line in `pullReceiptEmails.gs`:
```js
const MAILBOX = "receipts@goldentouchremodeling.com";
```
(`receipts@` is an alias on jadkins@, so its mail lands in jadkins@ — the same impersonation works. You can keep reading rlord@ too by running the pull for both mailboxes.)

## Behavior notes
- **Dedup quarantine:** a duplicate (same `vendor|date|total|invoice`) is moved to `Processed Receipts/_Duplicates` with `duplicateOf` in its description — no second QBO email, no second ProBuild expense. Review/delete those periodically. Dedup is applied **only** when a doc has a reliable discriminator (a real invoice/check number **and** a valid OCR date); a `NoInv`/`CheckNoNum` doc or one whose date couldn't be read is let through (better a visible double-book than a silently dropped real purchase). The claim runs under a `LockService` lock so overlapping 10-min runs can't both win; an unbooked file that gives up to `_Needs Review` releases its claim so a later real copy can still book.
- **Total reconciliation:** OCR usually itemizes pre-tax lines, so the category split is topped up with a **"Tax & Fees"** group for the gap, making the booked expenses sum to the receipt total (tax/shipping no longer drops out of job costs). Overshoot is logged, not silently scaled.
- **Nested Shop categories:** the deepest folder a file sits in is its category. `03 Fleet & Vehicles / 01 Fuel & Oil` → category "Fuel & Oil". Map the nested **leaf names** in QBO/cost codes; two different branches that reuse the same leaf name collapse to one category (by design — a category is a name).
- **Email routing:** a receipt whose PO#/job hint matches a project folder is filed there; **no hint → Shop (overhead); hint present but unmatched → `_Needs Review`** (never silently booked as overhead). Inline images (logos/signatures) and tiny images (<20 KB icons/QR) are ignored — only PDFs and real image attachments are treated as receipts. Email saves are idempotent via a per-message Script-Property marker, so a labeling failure can't cause a re-save.
- **ProBuild is project-only.** Shop/overhead stays QBO-only (`state.probuild = "skipped-shop"`). A folder name that doesn't match a ProBuild project emails an alert and still archives (the QBO copy already went through).
- **`null` archive folder:** pre-existing; holds items archived before date-validation. Worth emptying/reviewing once — not created by v2.
