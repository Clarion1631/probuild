# Read-only bank conflict inventory

GET /api/integrations/bank-ledger/conflict-inventory requires the existing CRON_SECRET bearer and accepts no query parameters. It fetches fresh configured-account GL for the rolling 60-day window, then reads canonical QBO_REGISTER observations whose date is in that window OR whose sourceLineId occurs anywhere in that fresh GL. Thus an old stored date outside the window is still compared to its current source. At most 2,000 GL rows and 2,000 stored rows; overflow, stale/failed clearance source or read failure is unavailable with unknown/null counts. All responses are no-store.

It compares exact canonical converter output for date, descriptor, cents and check number. Changed linked rows are separate. Duplicate IDs, missing source identity, missing observations, unconvertible rows, stored-only in-window rows and unsupported types (including unchanged unsupported types) are explicit. Missing GL identity rows include their row index/type/date/cents. Counts are source-specific and categories may describe overlapping evidence; do not sum them into a business denominator. The scope is parsed QBO GL, not complete bank eligibility or bank-side evidence. No row is classified safe to repair; no write, source entity read, job or notification occurs.

## Validation

Run the focused inventory and converter/diagnostic regressions:

```sh
npx tsx --test tests/bank-register-conflict-inventory.test.ts tests/bank-register-pull.test.ts tests/bank-conflict-diagnostic.test.ts
```

Run the standard unit suite and production build before deployment. Inventory is included in the standard unit runner. An authenticated GET verifies the deployed read path; it does not execute a refresh or financial job. Inspect `status`, source timestamps, coverage and every exception category before selecting a separately reviewed repair.
