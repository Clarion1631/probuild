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
