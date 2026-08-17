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

## A migration applied out-of-band still needs to be marked applied

`scripts/apply-*.mjs` writes DDL straight over `DATABASE_URL` (the pooler),
which developer machines CAN reach — it never touches prod's
`_prisma_migrations` table, because that table is written by `migrate deploy`
/ `migrate resolve`, both of which need `DIRECT_URL` (IPv6-only, unreachable
here; see CLAUDE.md, "Schema migrations"). That is the same shape of gap PR
#382 (commit `43b7fcd8`) fixed for the whole migration history: production's
schema and the committed migrations agreed, but nothing had ever recorded that
agreement in `_prisma_migrations`. That commit's own message is explicit that
the production write was **not** bundled into the automated change — "marking
the baseline applied and removing the orphan row... is performed separately"
— and this follows the same split.

**`prisma/migrations/20260815000000_add_change_order_revision`** (adds
`ChangeOrder.revision` and the `termsTax*` customer-terms columns) is applied to
production by `scripts/apply-co-revision-schema.mjs`, the same out-of-band
path. Every statement in that migration is `ADD COLUMN IF NOT EXISTS`, so
leaving `_prisma_migrations` unreconciled is safe, not just tolerated: the
next time `migrate deploy` runs for real against prod from an environment
that can reach `DIRECT_URL` (e.g. a CI runner), it applies as a harmless
no-op and records itself. If a real accounting of `migrate status` is wanted
sooner than that, the deliberate manual step is:

```
npx prisma migrate resolve --applied 20260815000000_add_change_order_revision
```

run from somewhere that can reach `DIRECT_URL`, after confirming
`scripts/apply-co-revision-schema.mjs` has already run against prod (so the
columns actually exist before the migration is marked as having created
them).
