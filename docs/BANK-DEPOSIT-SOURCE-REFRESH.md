# Deposit source descriptor refresh

POST `/api/integrations/bank-ledger/deposit-source-refresh` requires the existing CRON_SECRET bearer. It accepts no query parameters, an 8KB maximum body, and exactly one numeric QBO Deposit ID. Responses are no-store.

```json
{"mode":"dry-run","items":[{"qbTxnId":"6531"}]}
```

Review the returned plan and digest. Apply requires the exact digest from that review:

```json
{"mode":"apply","items":[{"qbTxnId":"6531","expectedDigest":"<64-character dry-run digest>"}]}
```

The supported policy is `qbo-linked-deposit-descriptor/1`: one fresh configured-account GL Deposit, one direct USD Deposit line linked to one full Payment, a reciprocal Payment-to-Deposit link, one full Invoice allocation, zero unapplied amount, matching party/memo/method, and unchanged positive cents/date/check/account. Payment's undeposited-funds source account is recorded separately from Deposit's destination account. The fixture IDs are examples, not production allowlist entries.

Exactly one unlinked canonical observation must exist, with no canonical BankLine, Expense, or receipt intake for this source ID. Its prior descriptor must be the exact whitespace-normalized legacy `<party> Deposit` form, or already match the current converter. Grouped deposits, partial payments, cash back, tax details, missing source evidence and other unsupported shapes remain blocked. Existing financial allocations are evidence only and are never changed.

Dry-run writes nothing. Apply rereads fresh external sources, verifies the digest, then rereads local evidence under the existing receipt-evidence, QBO-ID and bank-identity locks. A full-observation compare-and-set changes only the descriptor (the same date is retained), with an epoch increment and private audit in the same transaction. A failure rolls back the transaction. It never updates a Deposit, Payment, Invoice, Expense, receipt association, financial balance or freshness marker, and does not send messages or run a business job.

Plans explicitly carry `legacy-descriptor-only` and `HISTORICAL_FIELD_HISTORY_MISSING`. Current source agreement does not establish historical field-change timing. The digest includes source versions and allowlisted identity/line evidence, the exact GL row and old observation; fetch timing is excluded. Audit `fetchedAt` is the observation time after the direct reads, while `registerCapturedAt` comes from the register result. Raw payment processor responses are excluded. Success means the source descriptor correction committed, not bank reconciliation or affidavit completion.

The handler has a 90-second guard, the route a 120-second limit, source token acquisition and each typed GET share a 10-second deadline, and the local transaction is bounded to at most 15 seconds. No force option exists. A retry should obtain a new dry-run digest; an already-canonical plan is a no-op and writes no audit.

## Validation

```sh
npx tsx --test tests/bank-deposit-source-refresh.test.ts tests/bank-source-refresh.test.ts tests/bank-register-conflict-inventory.test.ts
```

Include the Deposit test in the standard unit runner and run the production build before deployment. Production dry-run must independently establish eligibility before any reviewed apply.
