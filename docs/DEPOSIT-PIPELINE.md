# Customer Deposit Pipeline — Reference

How a customer's check goes from a photo to being recorded in ProBuild **and** QuickBooks, with no customer emails and no double counting. Built August 2026 after the Berg late-recording incident.

## The one habit that drives everything

> **Deposit a check → same day, drop a photo of it into that project's folder inside the "New Receipts & Checks" Drive intake.**
> Email alternative: send it to the receipts address with `PO#<project>` in the subject.
> No project folder → the deposit parks for review instead of being guessed at.

## End-to-end flow

```mermaid
flowchart TD
    A["Check deposited at Washington Trust"] --> B["Photo into project folder<br/>in 'New Receipts & Checks' Drive intake"]
    B --> C["Receipts bot (Apps Script 'QBO Automation')<br/>runs every 10 min"]
    C --> D{"Gemini classifies"}
    D -- "receipt / outgoing check" --> E["Existing expense flow<br/>(QBO email + ProBuild expense)"]
    D -- "customer_payment<br/>(check made out TO Golden Touch)" --> F["Extract payer, amount,<br/>check date, check number"]
    F --> G["POST /api/payments/deposit-ingest<br/>(secret-authed, idempotent by Drive file id)"]
    G --> H{"Strict match:<br/>exactly 1 project AND<br/>exactly 1 pending milestone<br/>at the exact amount?"}
    H -- "yes" --> I["QuickBooks: create/settle payment<br/>with real check date + number"]
    I --> J["ProBuild: milestone marked Paid<br/>same date + check number"]
    J --> K["Photo archived to<br/>Processed Receipts/…/Deposits"]
    K --> L["Vanessa: record a Deposit selecting<br/>the associated payment(s) — the bank<br/>feed line then matches it"]
    H -- "no / ambiguous" --> M["NO money moves"]
    M --> N["Photo parked in '_Needs Review'<br/>+ card on the /tasks board<br/>+ alert email to the team"]
```

## Guardrails (why it can't double-pay or surprise a client)

```mermaid
flowchart LR
    subgraph Refuses["The endpoint refuses and files a review card when…"]
        R1["Project name matches 0 or 2+ projects"]
        R2["0 or 2+ pending milestones at that amount"]
        R3["Missing check number or date"]
        R4["Payer name conflicts with the project's client"]
        R5["Another deposit already claimed that milestone"]
    end
    subgraph Emails["Email rules"]
        E1["Client receipt: SUPPRESSED when the payment date<br/>is more than 3 days old — Send Receipt button<br/>still works for a deliberate send"]
        E2["Team alert: one email per payment<br/>(Settings → Notifications → Payment Received)"]
        E3["Creating a QuickBooks invoice never emails anyone —<br/>only the explicit Send buttons do"]
    end
    subgraph Money["Money rules"]
        M1["One Drive file = one payment, ever<br/>(retries and crashes can't duplicate)"]
        M2["QuickBooks payments land in Undeposited Funds —<br/>record a Deposit selecting the payment(s), then match<br/>the bank feed line to it. Never re-add the income.<br/>(A single-check deposit can also match the payment<br/>directly — QBO creates the deposit for you.)"]
        M3["Amounts must match to the cent"]
    end
```

## Where each piece lives

| Piece | Where |
|---|---|
| Endpoint (matching + money writes) | `src/app/api/payments/deposit-ingest/route.ts` |
| State machine table | `DepositIngest` (schema: `scripts/apply-deposit-ingest-schema.mjs`) |
| QuickBooks payment helpers | `src/lib/quickbooks.ts` (`buildQBPaymentRequest` / `sendQBPaymentCreateRequest`) |
| ProBuild settle core | `src/lib/quickbooks-payments.ts` (`settleMilestoneFromQBPayment`), `src/lib/payment-record-core.ts` |
| Back-dated receipt suppression | `src/lib/payment-date.ts` + guards in `src/lib/payment-notifications.ts` |
| Bot (classify + route) | Apps Script project **"QBO Automation"** (owner jadkins@) — `runReceiptAutomation.gs`, deposit branch v3.7 |
| Bot secret | Script Property `DEPOSIT_INGEST_SECRET` (matches the Vercel env var) |
| Tests | `e2e/deposit-ingest.spec.ts` (25 cases, QBO mocked) + bot harness `test-deposits.js` |
| Team alert toggle | ProBuild → Settings → Notifications → "Payment Received" |

## Manual fallback (what Vanessa/we do if the bot is down)

1. Find the deposit in the Washington Trust site — the deposit row's **Image → View** shows the actual check (payer, number, memo).
2. ProBuild: open the project invoice → milestone → **Record Payment** with the check's real date + number. Back-dated recordings do not email the client.
3. QuickBooks: receive the payment against the milestone invoice (create the invoice first from ProBuild's "QuickBooks Link" button if it doesn't exist; if the invoice is dated more than ~30 days after the deposit, edit its invoice date or QBO won't offer the match). Then per Vanessa's workflow: **record a Deposit selecting the associated payment(s)** — until the deposit is recorded, QuickBooks won't allow the bank-feed match. Single-check deposits can also be matched straight to the payment from the feed.

## State machine (endpoint internals, for debugging)

```mermaid
stateDiagram-v2
    [*] --> processing : bot POSTs a file
    processing --> applied : matched + settled (terminal)
    processing --> unmatched : ambiguous — review card filed (terminal)
    processing --> qbo_unknown : QBO call sent, response lost
    qbo_unknown --> qbo_created : replay confirms payment exists
    qbo_created --> applied : ProBuild settled
    processing --> failed : pre-money error (retries next run)
    failed --> processing : next bot run
    processing --> reconcile : retries exhausted / conflict — human resolves (terminal)
    qbo_unknown --> reconcile
    qbo_created --> reconcile
```
