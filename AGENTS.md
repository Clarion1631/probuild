# AGENTS.md — ProBuild

**`CLAUDE.md` at the repo root is the authoritative context document.** Read it before
doing anything in this repo. This file exists only because some tools (Codex, in
particular) read `AGENTS.md` automatically and would otherwise start with no context.

## Stack

Next.js 16 (App Router, Server Components, Server Actions) · Prisma 5 · Supabase
(Postgres + auth + storage) · NextAuth · Tailwind · **npm** · deployed on Vercel.

There is no Clerk, PostHog, shadcn, Coolify, yarn, Linear, Docker deploy, or Postgres
RLS-context helper layer in this project. If a suggestion depends on one of those,
it does not apply here.

## Hard rules

- **Schema changes do not go through Prisma's migration commands.** `prisma migrate dev`
  dials `DIRECT_URL`, whose host publishes an AAAA record only, and this machine has no
  IPv6 route; `prisma db push` hangs interactively. Apply DDL via the PowerShell SQL
  script route, then `prisma generate` from PowerShell. See "Schema migrations" in
  `CLAUDE.md` and the `probuild-schema-migration` skill.
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
  Supabase is auth and storage only.
- **E2E never runs against the production database.** See `docs/TESTING.md`.

## Money path

Estimates, invoices, payment schedules, signing, and payment mirrors are the highest-risk
code in this repo. Mirrored milestone pairs are linked by `PaymentSchedule.sourceScheduleId`
and both sides must move together. All paid-milestone side effects flow through
`notifyMilestonePaid()` in `src/lib/payment-notifications.ts` — never add a second writer
for a lifecycle event. Changes here need a peer review and a green
`e2e/money-pipeline.spec.ts`.

## Other reference docs

- `CLAUDE.md` — project context, workflow, deploy procedure, pitfalls (**start here**)
- `DESIGN_SYSTEM.md` — layout templates, shared components, CSS classes
- `VISION.md` — product direction
- `ProbuildTodo.md` — active build plan
- `docs/TESTING.md` — E2E rules and safety guards
