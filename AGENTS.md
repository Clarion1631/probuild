# AGENTS.md — ProBuild

**`CLAUDE.md` at the repo root is the authoritative context document.** Read it before
doing anything in this repo. This file exists only because some tools (Codex, in
particular) read `AGENTS.md` automatically and would otherwise start with no context.

## Stack

Next.js 16 (App Router, Server Components, Server Actions) · Prisma 5 · Supabase
(Postgres + Storage) · NextAuth · Tailwind · **npm** · deployed on Vercel.

Application auth is **NextAuth** with Google as the only real provider and Prisma-backed
users — see `src/lib/auth.ts`. (A credentials provider exists but is test-only; it is
installed only when `PLAYWRIGHT_TEST_SECRET` is set.) Supabase hosts Postgres and
Storage; the Supabase client (`src/lib/supabase.ts`) is used for Storage only, and there
are no `supabase.auth` calls anywhere in `src/`.

There is no Clerk, PostHog, Coolify, yarn, Linear, Docker deploy, or Postgres
RLS-context helper layer in this project. If a suggestion depends on one of those, it
does not apply here. shadcn *is* installed (`components.json`, a few `src/components/ui`
primitives), but `DESIGN_SYSTEM.md` is authoritative for new UI — use `hui-*` classes
and the shared components, not stock shadcn.

## Hard rules

- **Schema changes do not go through Prisma's migration commands.** Both `prisma migrate
  dev` and `prisma db push` read `directUrl` from the datasource block and dial
  `DIRECT_URL`, whose host publishes an AAAA record only; this machine has no IPv6 route,
  so both fail fast with `P1001`. (Neither one hangs — that older claim was never
  verified and is wrong.) Apply DDL via the PowerShell SQL script route, then
  `prisma generate` from PowerShell. See "Schema migrations" in `CLAUDE.md` and the
  `probuild-schema-migration` skill.
- **`main` auto-deploys to production.** Merging a PR ships it live to
  `probuild.goldentouchremodeling.com`. Run `npm run build` clean before merging, and
  apply any `scripts/apply-*.mjs` schema script *before* the deploy, not after.
- **`DATABASE_URL` must carry `?pgbouncer=true`.** Supabase's transaction pooler (6543)
  plus Prisma needs it; without it you get `42P05 prepared statement already exists`
  and the site goes down.
- **Never pass `--token` to the `vercel` CLI.** It echoes the value back in its
  "next steps" output, which has leaked the production token three times. The CLI
  authenticates on its own.
- **Data access goes through Prisma** (`src/lib/prisma.ts`), not the Supabase client.
  The Supabase client is for Storage only.
- **Routine E2E must never run against the production database.** CI provisions a
  throwaway `postgres:16` container; a local run uses whatever `DATABASE_URL` your env
  supplies, so you must point it at a disposable database yourself. `e2e/data.setup.ts`
  refuses a Supabase-looking `DATABASE_URL` — but that guard is bypassable by setting
  `ALLOW_PROD_E2E=1`, so treat it as a backstop, not a guarantee.
  The one exception is deliberate and manual: `playwright.config.prod.ts` runs the
  `e2e/qa-*.spec.ts` specs against the live deployment, and some of them create real
  records — those specs must clean up after themselves. Never point the ordinary config
  at prod. See `docs/TESTING.md`.

## Money path

Estimates, invoices, payment schedules, signing, and payment mirrors are the highest-risk
code in this repo. Mirrored milestone pairs are linked by `PaymentSchedule.sourceScheduleId`
and both sides must move together.

Paid-milestone side effects (team email, client receipt, activity log) have exactly **two**
canonical single-writer notifiers in `src/lib/payment-notifications.ts` —
`notifyMilestonePaid()` for invoice schedules and `notifyEstimateMilestonePaid()` for
estimate schedules — and `src/lib/payment-outbox.ts` dispatches to the right one. Route
through the outbox; never add a third writer for a lifecycle event. Duplicate loggers have
shipped this way before.

Changes here need a peer review and a green `e2e/money-pipeline.spec.ts`.

## Other reference docs

- `CLAUDE.md` — project context, workflow, deploy procedure, pitfalls (**start here**)
- `DESIGN_SYSTEM.md` — layout templates, shared components, CSS classes
- `VISION.md` — product direction
- `ProbuildTodo.md` — active build plan
- `docs/TESTING.md` — E2E rules and safety guards
