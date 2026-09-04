# Applying schema changes to production

`.github/workflows/db-push.yml` was removed on 2026-08-14. It was a
`workflow_dispatch` job that ran **`prisma db push --accept-data-loss` against
the production secrets**. That command makes the database match
`schema.prisma` by whatever means necessary, including dropping tables and
columns. Until PR #370, one click would have proposed dropping 10 tables and 41
columns of live data — and GitHub's runners *can* reach the IPv6-only
`DIRECT_URL` host that developer machines cannot, so the connection problem that
protects us locally was never protecting that path.

It was deleted rather than converted to `migrate deploy`, because:

- nothing used it; the real path for this project is the PowerShell SQL script
  and the `scripts/apply-*.mjs` scripts (see CLAUDE.md, "Schema migrations")
- `migrate deploy` executes whatever SQL is committed under `prisma/migrations/`,
  so a manually dispatchable, unapproved, any-branch job pointed at production
  is still arbitrary-DDL-on-demand — a smaller gun, not a safe one
- there is no protected GitHub environment or approval gate on this repo to put
  in front of it

If a CI-driven migration path is wanted later, it needs an approval gate and a
main-branch guard first. Until then, apply schema changes locally and
deliberately.

## Recording applied migrations in prod's `_prisma_migrations`

Prod is written by `scripts/apply-*.mjs`; CI's throwaway database is built from
`prisma/migrations/`. Nothing runs `migrate deploy` against prod, so prod's
history table only learns about a migration when someone records it by hand.
That is a deliberate one-off step, done **after** the DDL is verified present
in prod and **after** the migration file is on `main`:

```powershell
# From a worktree checked out at origin/main. Both URLs are the SESSION pooler
# (port 5432, no ?pgbouncer=true) — DIRECT_URL's real host is IPv6-only here.
$env:DIRECT_URL = "<DATABASE_URL from .env.production.local, :6543 -> :5432, ?pgbouncer=true removed>"
$env:DATABASE_URL = $env:DIRECT_URL
npx prisma migrate resolve --applied <migration_folder_name>
npx prisma migrate status   # no local migration may remain "not yet applied"; a DB-side row
                            # with no local folder (e.g. PR #469's until it merges) is expected
                            # and makes the command exit non-zero anyway
```

`resolve --applied` only inserts a history row (name + checksum of the file);
it runs no SQL. Never record a migration whose DDL you have not confirmed in
prod with an `information_schema` / `pg_indexes` / `pg_constraint` query — a
false row keeps `migrate status` and every later audit misleading until someone
repairs the history table by hand.

Two limits worth knowing. A migration whose name sorts *before* rows already
recorded is still pending: Prisma never infers application from timestamps, and
a `migrate deploy` run first would execute its SQL and self-record it. And
`IF NOT EXISTS` DDL cannot repair a partially created table, so recording such a
migration is only safe once the *full* shape has been verified in prod.

### 2026-09-04 reconciliation

Three weeks after the baseline the history had fallen behind again: prod held
7 rows, `main` held 14 migrations. A read-only `migrate diff` also showed new
drift in the other direction. The audit (PR #470) found:

| Migration on `main` | DDL in prod? | Action |
|---|---|---|
| `20260826000000_bank_image_schema_history` | yes (`apply-bank-image.mjs`) | record |
| `20260827000000_inspection_schema_history` | yes (`apply-inspections-schema.mjs`) | record |
| `20260829020000_time_meal_breaks_bank_image_extraction` | yes | record |
| `20260829190000_qbo_purchase_classification_updated_at_default` | **no** — `apply-qbo-purchase-classification.mjs` ran before #411 added the `SET DEFAULT` | re-run that script, then record |
| `20260901000000_percent_complete` | yes | record |
| `20260902000000_deposit_sweep` | yes | record |
| `20260903000000_deposit_sweep_fingerprint` | yes | record |
| `20260817000000_add_change_order_revision`, `20260817000001_add_change_order_automation_jobs` | yes (PR #402's `apply-co-revision-schema.mjs` ran against prod on 2026-08-17 without merging) | adopted onto `main` verbatim by PR #470; record after it merges |

Objects prod has that `main` still does not model — `PayrollPeriod`,
`HelpSubmissionQuota`, `HelpRequest.submissionId`/`provider*`,
`User.payType`/`lastRateSyncAt`, `TimeEntry_startTime_idx`, and the
`TimeEntry` user/project FKs as `ON DELETE RESTRICT` — all belong to PR #441
(`scripts/apply-payroll-phase5.mjs`), which was mergeable and CI-green at the
time, so they were left for that PR rather than adopted twice. Its script has
to be re-run before its deploy anyway: prod lacks `User.payrollRevision` and
RLS on `TimeEntry`/`HelpRequest`, which later rounds of that script add.
