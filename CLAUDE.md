# CLAUDE.md — ProBuild Project Context

## What this project is
**ProBuild** — a construction/contractor management platform (competitor to Houzz Pro). Built with Next.js, Prisma, Supabase, deployed on Vercel.

## Key paths & service IDs
| Thing | Value |
|---|---|
| This project (Windows) | `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site` |
| GitHub | https://github.com/Clarion1631/probuild |
| Production | https://probuild.goldentouchremodeling.com |
| Vercel preview | https://probuild-amber.vercel.app |
| Vercel project ID | `prj_sd7R3WIYZCRMnu5IhAudBdc4vuIL` |
| Supabase project ref | `ghzdbzdnwjxazvmcefbh` |
| Sentry org | `golden-touch-remodeling` (us.sentry.io) |
| Prod test project ("Shop") | `cmpd6xca1009x1iizdf4suln3` |

## Vercel env vars (already configured)
`STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DATABASE_URL`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
`RESEND_API_KEY`, `GEMINI_API_KEY`,
`NEXTAUTH_SECRET`, `NEXTAUTH_URL`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`NEXT_PUBLIC_APP_URL`,
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`

## Stack
- Next.js 16 (App Router, Server Components, Server Actions), npm, Prisma 5, Tailwind
- Supabase (PostgreSQL, auth, storage) — project ref: `ghzdbzdnwjxazvmcefbh`
- Auto-deploy is **ON** — pushes build previews, merges to `main` ship to prod. See "Deploying to Vercel"

## Room Studio (3D room designer)
- Lives in `src/components/studio/` + `src/lib/studio/` (react-three-fiber). The legacy `room-designer` modules are gone — don't recreate them.
- Document model: `RoomDesign.layoutJson` holds a v2 `DesignDoc` (`lib/studio/doc.ts`); placed items mirror into `RoomAsset` rows. v1 layouts upgrade on load.
- Catalog/finishes/templates are code-seeded (`lib/studio/catalog.ts`, `materials.ts`, `templates.ts`) — no GLTF downloads, all meshes procedural (`components/studio/canvas/builders-*.tsx`).
- Perf contract: nothing writes to the zustand store per-frame; drags mutate three.js objects and commit on pointerup. No postprocessing. Keep it that way.
- LiDAR intake: `POST /api/rooms/scan-import` (RoomPlan JSON or simplified corners). Mobile capture screen: gtr-probuild-mobile `apps/mobile/app/room-scan.tsx`.
- Client sharing: `/share/room/[token]` (public route in AppLayout) + portal Designs tab lists share-enabled rooms.

## Product Vision
See **VISION.md** — AI-first remodeling platform. Every feature should ask: "What can AI do here so the human doesn't have to?"

## Design System
See **DESIGN_SYSTEM.md** — standardized colors, typography, page layouts, and components. Every new page must follow one of the 4 layout templates (List, Form, Editor, Full-Width Tool). Use shared components: StatCard, TabButton, EmptyState, StatusBadge.

## Active Build Plan
See **ProbuildTodo.md** — execute sessions in order (Sessions 3–7 remain).
Sessions 1–2 + Gantt polish are complete. Each session lists specific files, actions, and schema changes.

## Development workflow
```
1. Pick next session from ProbuildTodo.md
2. Make changes
3. npm run build          # must pass 0 errors
4. Schema changed? Run the branch's scripts/apply-*.mjs against prod NOW, before main moves (see "Deploying to Vercel")
5. git push origin main   # auto-deploy is ON — this ships to prod
6. Shipping ahead of a merge? vercel --prod --token $env:VERCEL_TOKEN
7. Click through affected pages on prod to verify
8. Mark items done in ProbuildTodo.md
```

**Error diagnosis (Sentry)**
```bash
sentry-cli issues list --org golden-touch-remodeling --project <project> --output json
```

**Stripe webhook testing**
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe --output json
stripe trigger payment_intent.succeeded
```

## Deploying to Vercel (manual CLI deploy — note auto-deploy also ships `main`)
```powershell
# Production deploy (from the main repo dir, not a worktree):
vercel --prod --token $env:VERCEL_TOKEN --yes --cwd "C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site"
# add --archive=tgz only as a fallback if the source upload stalls (see notes below)
```
This builds a **new** production deployment. To make an existing staged deployment live instead, use `vercel promote <deployment-url>` — `--prod` does not re-promote.
**Pre-deploy checklist (in order):**
1. `npm run build` passes locally with 0 errors
2. **Schema changed?** If the branch edits `prisma/schema.prisma` and ships a `scripts/apply-*.mjs`, run it against prod BEFORE deploying (`node scripts/apply-<name>.mjs`). These scripts are additive + idempotent (`IF NOT EXISTS`, guarded FKs) and safe while the old build is live — but the new build's Prisma client selects the new columns immediately, so any page querying them throws P2022 "column does not exist" until the script runs. (2026-07-20: the company-schedule deploy went out before `apply-company-schedule-schema.mjs` ran; project pages hit the route error boundary until it was applied.)
3. Deploy with the command above, then click through the affected pages on prod

- **Git auto-deploy is ON, despite older notes here.** It is not disabled in `vercel.json` (that file holds only `crons` — there is no `git.deploymentEnabled` key), and the project carries no `deploymentEnabled` override, so Vercel's default `true` applies. Verified 2026-08-10: recent production deployments off `main` report `source: "git"`, `readySubstate: "PROMOTED"`, and hold `probuild.goldentouchremodeling.com`. Branch pushes build previews the same way
- Consequence: **merging a PR ships it live.** Run the pre-deploy checklist before merging, not just before running the CLI
- To turn it off, set it in the Vercel dashboard (Settings → Git) or add `git.deploymentEnabled` to `vercel.json` — it is not currently set in either. Note that disabling Git deploys still leaves dashboard redeploy/promote, Deploy Hooks, the REST API, and CI able to ship
- No checked-in config throttles build volume (no `ignoreCommand`, no Ignored Build Step in the repo); dashboard/team spend controls were not checked. An older note attributes a ~$250 bill to frequent builds, so keep pushes deliberate
- `--archive=tgz` is **optional, not required** — with the current `.vercelignore` the CLI source upload measures ~1,389 files (2026-08-10), far under Vercel's 15,000-file cap. That cap counts uploaded source files, not build output. Archive mode bundles everything into one tarball, which negates per-file upload caching and can make repeat deploys slower, so add it only if an upload actually stalls
- `--cwd` points to the main repo — deploy from there, not from worktrees (worktrees lack the `.vercel` link)
- Only deploy when changes are verified locally via `npm run build`

## E2E testing — never against the live DB
See **docs/TESTING.md**. E2E creates leads/estimates/invoices, so:
- CI runs e2e in a throwaway Postgres container (`.github/workflows/ci.yml`)
- `e2e/data.setup.ts` refuses to run when DATABASE_URL looks like Supabase (override: `ALLOW_PROD_E2E=1`)
- Specs that create data must tear it down in `afterAll` (see `qa-lead-estimate-invoice.spec.ts`)
- History: QA runs against prod once filled /leads with "Master Bath Renovation - Henderson" junk (cleaned 2026-06-11)

## Dev server — clean start
```bash
kill -9 $(lsof -ti tcp:3000,3001,3002) 2>/dev/null; rm -f .next/dev/lock; sleep 2
npm run dev > /tmp/devserver.log 2>&1 &
sleep 15 && curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```
- Always use port 3000 — if it's taken, kill it, don't switch ports
- If still failing, `rm -rf .next && npm run dev`

## Schema migrations
> `npx prisma db push` hangs interactively. `prisma migrate dev` fails (port 5432 blocked on free tier).

**Working approach:**
1. Edit SQL in `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`
2. Run: `powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"`
3. Regenerate: `powershell -Command "cd 'C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site'; node_modules\.bin\prisma generate"`
4. Update `prisma/schema.prisma` to match the SQL changes

## Critical database config
- **DATABASE_URL must include `?pgbouncer=true`** — Supabase transaction pooler (port 6543) + Prisma requires this. Without it: `42P05 prepared statement already exists` and the site goes down.
- Correct format: `postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
- DIRECT_URL uses port 5432 on `db.ghzdbzdnwjxazvmcefbh.supabase.co` (for migrations only)

## compare.py (optional — QA tool, not daily workflow)
Legacy Houzz Pro visual comparison tool. Useful for quarterly sanity checks only.
```bash
python compare.py --force     # full production comparison
python compare.py --local --page "Page Name"   # single page local test
```
- `config.py` has API keys (gitignored) — ANTHROPIC_API_KEY, GEMINI_API_KEY
- Do not run compare.py as part of normal development — use ProbuildTodo.md as the roadmap instead

## Production data
- Prod test project ("Shop"): `cmpd6xca1009x1iizdf4suln3` — the sanctioned job for clicking through prod
- Do NOT try psql, prisma direct connect, or supabase CLI to query prod — use the API

## Messaging component
`src/components/ClientMessaging.tsx` is the single canonical messaging component used by both lead pages (`/leads/[id]`) and project pages (`/projects/[id]/messages`). It accepts a swappable `headerContent` slot for per-context headers. `LeadMessaging.tsx` was deleted in commit `363b70c`.

## Common pitfalls
- **config.py is gitignored** — never commit it, it contains secrets
- **GoldenTouch Pro URL** is `https://probuild-amber.vercel.app` — that's the live Vercel deployment
- **WSL env vars** — `setx` vars (VERCEL_TOKEN, STRIPE_API_KEY, etc.) are Windows-only, NOT available in WSL

## UI: hover-reveal buttons must support no-hover devices
ProBuild is used across different browsers, OS configs, and pointer types (some users may be on Chromebooks or devices where CSS `:hover` doesn't fire reliably). **Any button hidden via `opacity-0 group-hover:opacity-100` MUST also include `[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto`** so it stays visible on devices without reliable hover. This was discovered when Richard's browser silently hid all Add Sub-item / Add Category / delete buttons on the estimate editor.

Pattern to use:
```
className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition"
```

## Feature Decision Rule
Before building anything, answer: **"What remodeling problem does this solve, for which role, and can AI automate it?"**
If a feature doesn't map to a real workflow step for a real role (estimator, PM, field crew, bookkeeper, owner, client, sub), don't build it. No redundancy.

## Coding rules

- **Design system** — follow `DESIGN_SYSTEM.md`. Use `hui-btn`, `hui-card`, `hui-input`, shared components (StatCard, TabButton, EmptyState, StatusBadge). Every page follows one of the 4 layout templates.
- **Server actions** — go in `src/lib/actions.ts` by default; existing split files (client-actions.ts, lead-note-actions.ts, subcontractor-actions.ts) are legacy — don't add new ones
- **Server components by default** — only add `"use client"` when strictly needed (event handlers, hooks, browser APIs)
- **No dummy UI** — every button, link, and form must be fully wired before committing
- **Database** — always use Prisma (`src/lib/prisma.ts`), not direct Supabase client, for data access; Supabase is auth/storage only
- **Schema changes** — do NOT use `npx prisma db push` (hangs in WSL) or `prisma migrate dev` (port 5432 blocked). Instead: apply SQL via `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`, then regenerate client via **PowerShell** (never Git Bash — Git Bash triggers `copyEngine: false` which breaks the local dev engine)
- **DATABASE_URL must include `?pgbouncer=true`** — Supabase transaction pooler (port 6543) + Prisma requires this flag. Without it you get `42P05 prepared statement already exists` and the site goes down. Correct format: `postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
- **Auth roles** — ADMIN, MANAGER, FIELD_CREW, FINANCE — check `src/lib/permissions.ts` before adding role-gated UI
- **Toasts** — use `sonner` (already in layout), not any other toast library
- **Existing routes** — api, company, estimates, invoices, leads, login, manager, portal, projects, reports, settings, sub-portal, time-clock — don't duplicate
- **Money-path changes** (payments, signing, payment mirrors, notifications) — estimate/invoice milestones are mirrored pairs linked by `PaymentSchedule.sourceScheduleId`; settling or unsettling either side must update both. ALL paid-milestone side effects (team email, client receipt, activity log) flow through `notifyMilestonePaid()` in `lib/payment-notifications.ts` — never add a second writer for a lifecycle event (two duplicate loggers shipped that way before the June 2026 audit caught them). After touching these paths: run codex-peer-review on the diff and keep `e2e/money-pipeline.spec.ts` green (PR CI runs it — it guards the sign→convert→invoice chain, mirror links, undo restore, and exactly-once activity writers).

## Efficiency rules (token management)
- **Full context, minimum tokens** — read the 4 reference docs (CLAUDE.md, VISION.md, DESIGN_SYSTEM.md, ProbuildTodo.md) for context, then build. Don't explore the codebase unless you're editing a file you haven't seen.
- **Use CLIs with `--json` flags** — `gh --json`, `vercel --json`, `supabase` CLI. Not MCPs.
- **Use Sonnet for implementation** — only use Opus for complex architecture/planning decisions
- **Run parallel sub-agents** for independent work (e.g. building 3 report pages simultaneously in separate agents)
- **Don't re-read large files** — if you already know the structure, reference it. GanttChart.tsx is 17k tokens — don't read it unless editing it.
- **Batch tool calls** — make independent reads/greps/globs in parallel, not sequential
- **Auth is already configured** — gh (keyring), vercel ($VERCEL_TOKEN), supabase ($SUPABASE_ACCESS_TOKEN), stripe ($STRIPE_API_KEY), sentry ($SENTRY_AUTH_TOKEN). Don't re-authenticate or verify credentials unless something fails.

## Dead buttons / unlinked UI
- While working on any page, audit all buttons, links, and nav items for dead ends
- **Always fix, never remove** — wire to the correct route or server action
- Wiring must be intelligent — a "New Invoice" button should open an invoice form, not just navigate to /invoices
- If the target page/modal doesn't exist yet, build a minimal but real version — not a placeholder
