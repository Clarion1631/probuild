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

## Running an `scripts/apply-*.mjs` against production

`APPLY_EXPECT_PROJECT_REF` is **mandatory** and there is no default. Unset is a
refusal, not a skip — an unset variable is the default state of any shell, so a
guard that treated it as "no expectation" would be opt-in and therefore not a
guard. The production Supabase project ref is `ghzdbzdnwjxazvmcefbh`:

```bash
APPLY_EXPECT_PROJECT_REF=ghzdbzdnwjxazvmcefbh node scripts/apply-qb-sync-marker.mjs --target prod
```

Why the variable exists: the Supabase **pooler hostname is shared by every
project in the region**, `current_database()` is `postgres` on all of them, and
a staging clone restored from a production dump carries the baseline migration
row too. The only part of the connection string that says *which* project this
is, is the username — `postgres.<project-ref>` — so the script compares that
against what you told it to expect and refuses everything else.

The connection string itself is read only from `.env.production.local`, with
`override: true`, so an ambient `DATABASE_URL` left over from a test run cannot
quietly redirect the DDL. Run `vercel env pull` first if that file is missing.
(`vercel env pull` writes live secrets to disk — treat the file accordingly.)

The script prints its target, redacted, before the first statement, and then
what it verified:

```
target: postgresql://postgres.ghzdbzdnwjxazvmcefbh@aws-0-us-west-2.pooler.supabase.com:6543/postgres (project ghzdbzdnwjxazvmcefbh)
verified: project ghzdbzdnwjxazvmcefbh, postgres on aws-0-us-west-2.pooler.supabase.com:6543, baselined
```

Those lines show the **port** on purpose — 6543 is the transaction pooler, 5432
is the IPv6-only direct host this machine cannot reach. The guard itself
compares the *hostname* without the port; comparing `host` was a real bug
(Codex round 50), and it rejected the only URL the script is meant to accept.
The decision is `productionGuardProblems()` in
`scripts/apply-qb-sync-marker.mjs`, covered by `tests/qbo-marker-grammar.test.ts`.
