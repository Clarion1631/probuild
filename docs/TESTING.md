# E2E Testing — Test Grounds & Ground Rules

> **The one rule: e2e tests never write to the live database.**
> The suite creates leads, estimates, and invoices. Pointed at prod, it fills
> real screens with junk.

## Why this doc exists (the Henderson-lead incident, June 2026)

`e2e/qa-lead-estimate-invoice.spec.ts` creates a lead named
**"Master Bath Renovation - Henderson"** (client *Mike Henderson*) on every
run. Until June 2026 the CI Playwright job pointed `DATABASE_URL` at the
**production** Supabase DB, and automated PRs (Bolt/Sentinel/Palette/
Dependabot) triggered it almost daily. Result: 12 junk leads + 31 empty
estimates accumulated in the live `/leads` list before anyone noticed. They
were cleaned up by hand on 2026-06-11.

Three safeguards now exist — keep all three intact:

1. **CI uses a throwaway Postgres service container.**
   `.github/workflows/ci.yml` (playwright job) spins up `postgres:16`, runs
   `npx prisma db push` to create the schema, and points
   `DATABASE_URL`/`DIRECT_URL` at it. No Supabase secret is exposed to the
   e2e job. The DB dies with the runner.

2. **`e2e/data.setup.ts` refuses to run against the live DB.**
   It aborts if `DATABASE_URL` (env or `.env`) looks like Supabase, unless
   `ALLOW_PROD_E2E=1` is explicitly set. Local `.env` points at prod, so a
   bare `npx playwright test` on a dev machine fails fast by design.

3. **Specs tear down what they create.**
   `qa-lead-estimate-invoice.spec.ts` has a `test.afterAll` that deletes the
   created lead/estimates (plus any strays matching the exact test signature)
   and the auto-created client. New specs that create data MUST follow the
   same pattern: track created IDs, delete dependents then parents in
   `afterAll`, and keep fill values in shared constants so the cleanup
   signature can't drift.

## Seeded fixtures (created by `e2e/data.setup.ts`, idempotent upserts)

| Fixture | ID / key |
|---|---|
| Admin user (credentials login) | `jadkins@goldentouchremodeling.com` |
| Test client | `test-client-do-not-delete` |
| Test project | `cmml6vt3y000lpwrh0p9p3k12` |
| Baseline estimate | `cmml6vtx7001dpwrh8n65xzy6` |

Auth uses the NextAuth credentials provider that only activates when
`PLAYWRIGHT_TEST_SECRET` is set (see `src/lib/auth.ts`).

## Running e2e locally (safe path)

```powershell
# 1. Disposable Postgres (Docker)
docker run --rm -d --name probuild-e2e -p 5433:5432 -e POSTGRES_PASSWORD=probuild postgres:16

# 2. Create schema + run tests against it
# (pgbouncer=true is mandatory — src/lib/prisma.ts refuses URLs without it;
#  on vanilla Postgres it just disables prepared statements)
$env:DATABASE_URL = "postgresql://postgres:probuild@localhost:5433/postgres?pgbouncer=true"
$env:DIRECT_URL   = "postgresql://postgres:probuild@localhost:5433/postgres"
$env:PLAYWRIGHT_TEST_SECRET = "any-local-secret"
npx prisma db push --skip-generate
npx playwright test
```

The dev server started by Playwright inherits these env vars, so app writes
land in the container too.

## Prod smoke QA (`playwright.config.prod.ts`)

`npx playwright test --config=playwright.config.prod.ts` runs the `qa-*`
specs against the **live** deployment on purpose (read-mostly smoke checks).
Know what you're doing before running it: the lead spec will create and then
tear down a real lead in prod. Teardown connects via the local `.env`
`DATABASE_URL`, which must therefore match the deployment being tested.

## QA agent runs (QA_AGENT_PROMPT.md)

If an agent executes the manual QA workflows against a live URL, it must end
the session by deleting everything listed under "Test Data Created" in its
report — the report section is not decorative.
