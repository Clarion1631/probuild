# Getting off browser scraping for bank data

Justin, 2026-08-19: *"If that is not logged into the bank website but using
instead some other open source software to pull that data down, that might be
the best solution."*

He is right. The browser path is structurally fragile, and we have measured
every one of these failures in a single day:

| Failure | Cause |
|---|---|
| Session dies when Justin logs in | WTB allows ONE session; a second tab kills the first |
| Agent "loses" the tab | Same thing — the agent's tab is the one that gets killed |
| CDP reads the wrong page | `Target.attachToTarget` ignores `sessionId` in this harness |
| Job silently stops | Unpinned cron + global model drift (`drift_skip`) |
| 2FA | Needs a human, always |

## The answer we already have: QuickBooks

**`scripts/post-qbo-register.mjs` — verified working 2026-08-19, 36 rows
in 7 days, zero browser involvement.**

QuickBooks Online already has a **live bank feed from Washington Trust**.
It carries the same transactions, with better data than the CSV:

```
2026-08-17  -6000.00  UNITED INTERIOR O.   Expense
2026-08-17  -2930.00  RED Point ELECTRIC   Expense
2026-08-18   -233.76  Lowe's Home Improvement Expense
```

The CSV says `MISCELLANEOUS DEBIT ... POS DEB 1106`. QBO says
`Lowe's Home Improvement`. **QBO's version is already normalized.**

It is an OAuth API call. No login page, no tab, no 2FA, no session to lose.
It cannot be killed by Justin opening the bank in another window.

### What QBO does NOT give us

1. **Check and deposit IMAGES.** Only the bank has those, and they are the
   only thing that names a payer on a branch deposit or carries the memo
   line (`HOPPE VANITY CONTRACT 4152`) on a check written.
2. **Same-day settlement.** The QBO feed lags the bank by ~1 day.
3. **Pending items.** QBO shows posted transactions only.

## The plan

**Primary — QBO API, daily, no browser.** `post-qbo-register.mjs` becomes
the main ingest. It is idempotent (74 observations replay as a no-op) and
already peer-reviewed.

**Secondary — the CSV, for control totals.** The bank's own per-day
OPENING/CLOSING LEDGER and TOTAL CREDITS/DEBITS are the arithmetic proof
that nothing is missing. QBO cannot prove completeness; the statement can.
Keep it, but it is no longer the only path.

**Images — the only genuinely browser-bound job.** Low frequency: ~16
deposits and ~10 checks in 94 days. Batch it weekly instead of nightly, so
a bank-session collision costs a retry rather than a day of data.

### Alternatives considered

- **OFX / `ofxtools` direct connect** — the classic open-source route. WTB
  publishes OFX for Quicken/QuickBooks, and the export dialog offers
  "QuickBooks OFX" / "Quicken OFX", which means an OFX server exists.
  Blocked today: PyPI returned repeated 502s on install. Worth revisiting —
  it would give a fully headless bank pull independent of QBO.
- **Plaid** — explicitly deferred in `docs/BANK-REGISTER-PLAN.md` (line 4).
  Costs money, adds a third party to the money path, and QBO already
  carries the same feed.

## Self-healing (built 2026-08-19)

`bank_pipeline_watchdog.py`, 7pm and 9pm daily, script-only:

1. CSV missing → **re-fires the export job automatically** (`hermes cron run`)
2. Still missing after 2 tries → **escalates to Telegram**, no infinite loop
3. Also catches unpinned jobs, `drift_skip`, failed runs, delivery errors

Silence means healthy. Retry counters live in `.wtb_retry_state.json` and
prune after 7 days. 10 tests in `test_bank_watchdog.py`.
