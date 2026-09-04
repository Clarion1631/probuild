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
- Supabase hosts Postgres and Storage — project ref: `ghzdbzdnwjxazvmcefbh`. Application auth is **NextAuth** (`src/lib/auth.ts`, Prisma-backed users), not Supabase Auth — GoogleProvider in production, plus a test-only CredentialsProvider registered only when `PLAYWRIGHT_TEST_SECRET` is set
- Auto-deploy is **ON** — pushes build previews, merges to `main` ship to prod. See "Deploying to Vercel"

## Code map — read before exploring (saves tokens)
- Start at `C:\Users\jat00\workspaces\vaults\Workspace\Projects\ProBuild\ProBuild Code Map.md`, then the one `PB <Domain>.md` note that owns the path you're touching. Only then open source files. Do not grep the whole tree for orientation.
- Generated nightly beside the Code Map (`_generated\gtr-probuild-site\`): `Routes.md` (every API route + method), `Symbol Index.md` (exports + line numbers for every file over 1,500 lines), `Prisma Models.md` (model → line range), `Hot Files.md`, `Modules.md`.
- AST graph of `origin/main` (rebuilt 01:30, no LLM): `C:\Users\jat00\workspaces\_shared\probuild-graph\gtr-probuild-site\code\graphify-out\graph.json` — `/graphify query "<q>" --graph <that path>` for "what calls what". The `code\` folder next to it is a read-only snapshot of main; this checkout is often on a feature branch.

## Token hygiene — execution rules
Context is the scarce resource in this repo. These are hard rules, not preferences.
- **Never Read `src/lib/actions.ts` (15K lines) or `prisma/schema.prisma` (3K lines) whole.** Look the symbol or model up in `Symbol Index.md` / `Prisma Models.md`, then Read with `offset` + `limit` (40–80 lines). Same for any file over ~1,500 lines (`EstimateEditor.tsx`, `schedule-core.ts`, `ScheduleBoard.tsx`, `billing-core.ts`, the MCP route).
- **Checks go through the quiet scripts:** `npm run check:quiet` (typecheck + lint + unit tests), or `npm run typecheck:quiet` / `lint:quiet` / `test:quiet`. Targeted tests: `node scripts/quiet-check.mjs test tests/foo.test.ts`. They print one summary line per step plus the first 15 failures; full output lands in `.quiet-check/<step>.log` — grep that, don't rerun the raw command. Never run bare `tsc`, `eslint`, `next build`, or `tsx --test` in the main session.
- **Builds and test runs belong in the checker subagent** (Sonnet) when verifying a worker's change: it runs `check:quiet`, reads the logs, and reports PASS/FAIL with `path:line` evidence. Only that verdict enters the main context.
- **Dev server, Playwright, `vercel logs`, `prisma migrate`:** run in the background with output redirected to a file, then `grep`/`tail` the file. Never stream them into the conversation.
- **git:** `git diff --stat` and `git log --oneline -n 10` first; open a full diff only for the files you need. Never `git diff` the whole branch.
- **Shell output:** anything that can exceed ~50 lines gets `| tail -40` or a `grep` filter. If you need the whole thing, write it to a file and Read selectively.
- **Delegate exploration** ("where is X used", "does Y exist") to the Explore agent — it reads excerpts, and only the conclusion comes back.

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
6. Shipping ahead of a merge? Use the command in "Deploying to Vercel" verbatim. NEVER pass --token.
7. Click through affected pages on prod to verify
8. Mark items done in ProbuildTodo.md
```

**Error diagnosis (Sentry)**
```bash
sentry-cli issues list --org golden-touch-remodeling --project <project> --query "is:unresolved"
```

**Stripe webhook testing**
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe --format JSON
stripe trigger payment_intent.succeeded
```

## Deploying to Vercel (manual CLI deploy — note auto-deploy also ships `main`)
```powershell
# Production deploy (from the main repo dir, not a worktree):
vercel --prod --yes --cwd "C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site"
# add --archive=tgz only as a fallback if the source upload stalls (see notes below)
```
This builds a **new** production deployment. To make an existing staged deployment live instead, use `vercel promote <deployment-url>` — `--prod` does not re-promote.

> **NEVER pass `--token` to any `vercel` command.** On success the CLI prints a "next steps"
> block that reconstructs follow-up commands for you, copying your global flags through verbatim —
> so the token value lands straight in the terminal and the session transcript. That has leaked the
> production token **three times** (PR-209, 2026-08-09, and again 2026-08-10), each time forcing a
> rotation. The flag is unnecessary: the CLI
> already authenticates on its own. Precedence is `--token` → a **non-empty** `VERCEL_TOKEN` in the
> environment → the persisted login at `%APPDATA%\com.vercel.cli\Data\auth.json` (from
> `vercel login`). The latter two are read silently and never echoed. This applies to every
> *authenticating* subcommand (`deploy`, `env`, `logs`, `inspect`), not just `--prod`.
>
> A stale `VERCEL_TOKEN` fails every *authenticated* command with *"The token provided via
> VERCEL_TOKEN environment variable is not valid"* — an invalid explicit credential does **not**
> fall back to the persisted login. (Local-only commands like `vercel --version` still work, so
> don't use those to test auth; use `vercel whoami`, which prints `jadkins-4713`.)
>
> **Rotating the token — never put the value on a command line.** `setx VERCEL_TOKEN "<value>"`
> is the same leak class this rule exists to prevent: it lands the secret in argv, shell history,
> and any agent transcript. Justin sets it himself, in his own terminal, one of these two ways:
> - Windows GUI: Settings → *Edit environment variables for your account* → edit `VERCEL_TOKEN`.
> - PowerShell, value read from a prompt rather than argv. It **must** be `-AsSecureString`: a bare
>   `Read-Host` echoes the pasted token to the screen and into terminal scrollback, and PowerShell
>   5.1 (this machine) has no `-MaskInput`.
>   ```powershell
>   $s = Read-Host 'Paste token' -AsSecureString
>   $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
>   try {
>     [Environment]::SetEnvironmentVariable('VERCEL_TOKEN', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b), 'User')
>   } finally {
>     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
>   }
>   ```
>
> Either way it only affects **new** shells, and is Windows-only — WSL needs its own copy. Confirm
> in a fresh shell with `vercel whoami`. Claude must never be given the token value.

**Pre-deploy checklist (in order):**
1. `npm run build` passes locally with 0 errors
2. **Schema changed?** If the branch edits `prisma/schema.prisma` and ships a `scripts/apply-*.mjs`, run it against prod BEFORE deploying (`node scripts/apply-<name>.mjs`). These scripts are additive + idempotent (`IF NOT EXISTS`, guarded FKs) and safe while the old build is live — but the new build's Prisma client selects the new columns immediately, so any page querying them throws P2022 "column does not exist" until the script runs. (2026-07-20: the company-schedule deploy went out before `apply-company-schedule-schema.mjs` ran; project pages hit the route error boundary until it was applied.) These scripts are inert on import — all side effects sit inside `main()` or inside the `if (isMainModule)` block — because on 2026-09-02 importing one to inspect its exports executed it against prod. `tests/apply-scripts-inert-on-import.test.ts` checks the guard shape (`const isMainModule = ...;` then one `if (isMainModule) { ... }` ending in exactly one unconditional `main()` call), allows only allowlisted imports, function declarations, and inert declarations at module scope (no dotenv, PrismaClient, raw SQL, unguarded top-level await, or exit on import), and imports each script with DATABASE_URL pointed at a dummy listener that must see no connection. Keep new scripts in that shape; never `import` one to look at it, read it as text. Run scripts by their real path: through a symlink or junction the guard sees a different path and the script exits without doing anything (no `applied` lines in the output).
3. Deploy with the command above, then click through the affected pages on prod

- **Git auto-deploy is ON, despite older notes here.** It is not disabled in `vercel.json` (that file holds only `crons` — there is no `git.deploymentEnabled` key), and the project carries no `deploymentEnabled` override, so Vercel's default `true` applies. Verified 2026-08-10: recent production deployments off `main` report `source: "git"`, `readySubstate: "PROMOTED"`, and hold `probuild.goldentouchremodeling.com`. Branch pushes build previews the same way
- Consequence: **merging a PR ships it live.** Run the pre-deploy checklist before merging, not just before running the CLI
- To turn it off, set it in the Vercel dashboard (Settings → Git) or add `git.deploymentEnabled` to `vercel.json` — it is not currently set in either. Note that disabling Git deploys still leaves dashboard redeploy/promote, Deploy Hooks, the REST API, and CI able to ship
- No checked-in config throttles build volume (no `ignoreCommand`, no Ignored Build Step in the repo); dashboard/team spend controls were not checked. An older note attributes a ~$250 bill to frequent builds, so keep pushes deliberate
- `--archive=tgz` is **optional, not required** — with the current `.vercelignore` the CLI source upload measures ~1,389 files (2026-08-10), far under Vercel's 15,000-file cap. That cap counts uploaded source files, not build output. Archive mode bundles everything into one tarball, which negates per-file upload caching and can make repeat deploys slower, so add it only if an upload actually stalls
- **Do NOT try `vercel build` + `vercel deploy --prebuilt` from Windows to "save build minutes."** Verified broken 2026-08-18, two ways. (1) Next.js emits ~354 SYMLINKS under `.vercel/output/functions/**` (e.g. `_global-error.segments/__PAGE__.segment.rsc.func -> ../_global-error.rsc.func`); the Windows prebuilt upload does not preserve them, so `/v2/files` returns a bogus HTML `Internal Server Error` (looks like a Vercel outage — it is not) and, once past that, the builder dies with `ENOENT ... .segment.rsc.func`. (2) Dereferencing those symlinks into real copies clears the ENOENT but inflates `_middleware` from ~40mb to **304mb**, over Vercel's 250mb uncompressed function limit. Use the normal cloud build above; a single manual deploy is cheap — the historical $250 bill came from auto-deploy firing on every push, not from one deploy.
- `--cwd` points to the main repo — deploy from there, not from worktrees (worktrees lack the `.vercel` link)
- Only deploy when changes are verified locally via `npm run build`
- A `PreToolUse` guard (`~/.claude/hooks/block-vercel-token.mjs`, wired in `~/.claude/settings.json`) blocks `vercel` commands carrying `--token`/`-t`/an inline `VERCEL_TOKEN=`. If you hit it, drop the flag — don't work around it. It is defence-in-depth, not enforcement: it only covers Claude's Bash/PowerShell calls **on this machine**, and does nothing for a manual terminal, CI, Codex, or another machine. The rule above is still the actual control
  - It matches the command actually being **invoked**, not the text of the line, so quoting the pattern as prose is fine: a `gh pr create --body`, `git commit -m`, heredoc, or here-string that shows `vercel --prod --token …` as a documentation example is allowed. (#343's body had to be written to a file and passed via `--body-file` because an earlier version split on newlines without tracking quotes, so a doc example on its own line parsed as a real command. That workaround is no longer needed.) Regions that genuinely execute — `$(…)`, backticks, `<(…)`, `bash -c "…"`, `eval` — are still checked, and an unparseable line falls back to blocking. The flag is matched against resolved **argv**, not raw text, so shell-level quoting or escaping of it (`--to"ken"`, `--to\ken`, PowerShell `--to`` ken`) is still caught. Tests: `node ~/.claude/hooks/block-vercel-token.test.mjs` (115 cases, exits nonzero on failure)
- Other secrets-in-argv / secrets-on-disk paths this rule does **not** cover: `--env KEY=VALUE` and `--build-env KEY=VALUE` put values in argv; `vercel env pull` and `vercel pull` write every production env var in plaintext to `.env*` / `.vercel/.env.production.local` (gitignored, but readable by any tool or backup). Treat those files as live secrets

## E2E testing — never against the live DB
See **docs/TESTING.md**. E2E creates leads/estimates/invoices, so:
- CI runs e2e in a throwaway Postgres container (`.github/workflows/ci.yml`)
- `e2e/data.setup.ts` refuses to run when DATABASE_URL looks like Supabase (override: `ALLOW_PROD_E2E=1`)
- Specs that create data must tear it down in `afterAll` (see `qa-lead-estimate-invoice.spec.ts`)
- History: QA runs against prod once filled /leads with "Master Bath Renovation - Henderson" junk (cleaned 2026-06-11)

## Dev server — clean start
Prefer the Browser pane's `preview_start`. For a raw clean start, follow the
`probuild-dev-server` skill (`.claude/skills/probuild-dev-server/SKILL.md`) — that is the
canonical recipe, kept in one place so a second copy here can't drift from it.
- Always use port 3000 — if it's taken, kill the holder, don't switch ports
- Verify the new server actually answers (assert the kill worked, then match ProBuild's own markup) — a bare HTTP 200 can come from the surviving process while Next falls back to 3001
- If still failing, `rm -rf .next && npm run dev`

## Schema migrations
> `npx prisma db push` does **not** hang — it fails for the same reason `migrate dev` does, because
> when the datasource sets `directUrl` that is the URL `db push` connects over too. Both dial `DIRECT_URL`,
> whose host `db.ghzdbzdnwjxazvmcefbh.supabase.co` publishes an **AAAA record only** (IPv6-only without
> Supabase's IPv4 add-on) and this machine has no IPv6 default route. **5432 is not a blocked port** and
> the free tier is not the cause — the shared session pooler listens on 5432 too and completes a TCP
> handshake over IPv4. Full evidence table in the `probuild-schema-migration` skill.
>
> **Repointing `DIRECT_URL` at the session pooler does not rescue them** (tested 2026-08-13). The
> pooler authenticates fine and read-only Prisma CLI commands work over it, but prod's schema and
> migration history had drifted from the repo: `migrate diff` showed `db push` would propose 10
> `DROP TABLE` and 41 `DROP COLUMN` against production, and `migrate status` reported no common
> migration, which left `migrate dev` no useful work either. Neither mutating command was run
> against prod, so those are the diffs they would have faced, not observed outcomes.
>
> **The schema half of that is fixed (#370) and the history half is fixed (#382).** `schema.prisma`
> now describes prod, and `prisma/migrations/` now holds a real baseline
> (`20260814000000_baseline_production`), marked applied in prod's `_prisma_migrations` by a
> deliberate one-off step that is gated on CI being green — it is NOT done by merging.
> `migrate dev` still is not usable from this machine (it needs `DIRECT_URL`, still IPv6-only), so
> the PowerShell script below remains the local write path. What changed is that the committed
> migrations are now *true*: CI's `migrations` job builds a throwaway Postgres from them and asserts
> it reproduces prod, so a fresh dev/CI database finally matches production.

### Baseline facts worth knowing before touching `prisma/migrations/`
- The baseline was generated **from production** (`migrate diff --from-empty --to-schema-datasource`),
  not from `schema.prisma` — Prisma's own documented baselining flow. It records what prod *is*, so
  `migrate resolve --applied` is a true statement rather than a wish.
- `schema.prisma` was deliberately a little **ahead** of prod when the baseline was taken (seven
  foreign keys and three indexes it declared that prod never had). That gap was checked in verbatim
  at `prisma/EXPECTED_SCHEMA_GAP.sql`; `20260814120000_missing_fk_indexes` closed it and the file is
  gone. If a gap is ever reopened, record it the same way — a real migration plus deleting the
  file — and never by editing the baseline.
- **Prisma's diff engine cannot represent partial indexes and silently drops them.** Prod has seven,
  three of them UNIQUE constraints carrying real invariants. They are appended by hand at the end of
  the baseline. If you ever regenerate that file, re-append the block, or CI's
  `scripts/check-migrations-match.mjs` will fail (which is the point).
- **Never edit or regenerate the baseline.** It is marked applied in prod and its checksum is
  recorded there; changing the file breaks `migrate status`. Corrections go in a new migration.
- Some diff output is permanent and must never be applied — `prisma/PRISMA_PHANTOM_DIFF.sql`
  explains the one current case (prod's partial unique index on `ClientMessage.twilioMessageSid`,
  which Prisma cannot see and so proposes recreating forever).
- `.github/workflows/db-push.yml` was deleted; see `docs/DB-MIGRATE-WORKFLOW.md`.

**Working approach (local SQL writes):**
1. Edit SQL in `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`
2. Run: `powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"`
3. Regenerate: `powershell -Command "cd 'C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site'; node_modules\.bin\prisma generate"`
4. Update `prisma/schema.prisma` to match the SQL changes

## Critical database config
- **DATABASE_URL must include `?pgbouncer=true`** — Supabase transaction pooler (port 6543) + Prisma requires this. Without it: `42P05 prepared statement already exists` and the site goes down.
- Correct format: `postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
- DIRECT_URL uses port 5432 on `db.ghzdbzdnwjxazvmcefbh.supabase.co` (used by the Prisma CLI operations needing a direct connection — `migrate`, `db push`, Studio — not the app at runtime)

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
- **Database** — always use Prisma (`src/lib/prisma.ts`), not the direct Supabase client, for data access; the Supabase client (`src/lib/supabase.ts`) is Storage-only (there are no `supabase.auth` calls anywhere in `src/`)
- **Schema changes** — do NOT use `npx prisma db push` or `prisma migrate dev`. Both connect over `DIRECT_URL` (yes, `db push` too — a datasource `directUrl` overrides `url` as the connection target), whose host is IPv6-only and unreachable here; 5432 itself is fine, and neither command hangs on this machine — see "Schema migrations". Repointing `DIRECT_URL` at the session pooler fixes the connection but not the commands — prod has drifted from `schema.prisma`, so `db push` would propose dropping 10 tables and 41 columns. Instead: apply SQL via `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`, then regenerate client via **PowerShell** (never Git Bash — Git Bash triggers `copyEngine: false` which breaks the local dev engine)
- **DATABASE_URL must include `?pgbouncer=true`** — Supabase transaction pooler (port 6543) + Prisma requires this flag. Without it you get `42P05 prepared statement already exists` and the site goes down. Correct format: `postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
- **Auth roles** — ADMIN, MANAGER, FIELD_CREW, FINANCE — check `src/lib/permissions.ts` before adding role-gated UI
- **Toasts** — use `sonner` (already in layout), not any other toast library
- **Existing routes** — api, company, estimates, invoices, leads, login, manager, portal, projects, reports, settings, sub-portal, time-clock — don't duplicate
- **Money-path invariants** (canonical — reviewers and plan reviews read these here, not just in `.claude/skills/codex-code-review/checklist.md`):
  - **`markupPercent` is GROSS MARGIN ON SELL PRICE, not markup on cost.** `sell = baseCost / (1 - markupPercent/100)`; `cost = sell * (1 - markupPercent/100)`. The field name is legacy and misleading. Helpers live in `src/lib/budget-math.ts` (`sellFromMargin`, `costFromMargin`, `derivedMarginPct`) — use them, don't hand-roll the formula. `baseCost` + `unitCost` are authoritative; `markupPercent` is derived from them. `EstimateItem` is the field this describes and the one canonicalized in #324 (with #328/#329 as follow-ups: a constant collision and its backfill). `EstimateTemplateItem` copies the value verbatim to and from estimate lines, so it carries the same semantic. `ChangeOrderItem` may hold costing metadata copied from an estimate, but the current CO editor and billing paths neither maintain nor read it — fixed-price CO totals come from `unitCost`/`total`. Don't reason about CO margin from that column.
    - Two deliberate exceptions, both already documented in place: `ChangeOrder.markupPercent` (COST_PLUS) is a **true markup on actuals**; and the AI takeoff prompt/preview (`api/takeoffs/ai-estimate`, `takeoffs/TakeoffsClient.tsx`) speaks **true markup**, converted to margin at `api/takeoffs/convert-to-estimate`. Don't "unify" either one.
  - **`Estimate.totalAmount` is not a bare subtotal — check the tax mode before reconciling against it.** Editor saves compute `totalAmount = subtotal + tax + processingFee`. Once a rate is chosen the stored total is tax-INCLUSIVE. A null `taxRatePercent` does NOT reliably mean "no tax in the total": legacy and MCP paths store a bare subtotal there and approval grosses it up once by the default rate (`lib/gpt-estimate.ts`, `ensureProjectAndDepositInvoiceForEstimate`), and a takeoff-converted estimate used to carry tax inside the total as a `99-TAX` line while still leaving `taxRatePercent` null, letting approval apply default tax on top. Since #372 the conversion folds the tax line into `taxRatePercent` (milestones rebalanced to match); the legacy shape can still appear only when `splitTakeoffTax` bails out on an underivable rate, and a 2026-08-13 prod audit found zero estimates carrying it (Takeoff table empty). Still: read the items before assuming the mode. Any recomputation must preserve the current tax mode and the processing fee, or milestones and variance will not tie out. QBO is the deliberate exception: `lib/quickbooks.ts` sends pre-tax lines and lets QBO compute its own tax (its processing-fee handling is a known open gap).
  - **Section headers are not billable.** Roll children up; never add a header's own amount on top of its children (see the Aug 2026 double-count sweep, #315/#320/#321/#325/#326).
  - **`Estimate.status` cannot answer "has the client seen this?" — its column default is `"Sent"`.** An estimate created and never sent already reads as Sent, so any *negative* status check (`status != 'Draft'`) is fail-open. Prod held 13 rows in exactly that shape. Whether a portal client may see an estimate is decided in exactly one place, `portalVisibleEstimateWhere()` in `src/lib/estimate-portal-visibility.ts` (#384): visible only if `privacy != "Private"` AND sharing is *positively* evidenced — `sentAt`, `approvedAt`, an invoice exists, or a status only a post-send transition produces. Compose that predicate; never hand-roll a status check, and never add an in-memory twin of it (SQL treats `privacy <> 'Private'` as false for a NULL, so a JS `!== "Private"` copy disagrees on day one). It gates the detail fetch, the sequential-`number` lookup, `markEstimateViewed`, the portal project list, the client-message attachment queries, and the scheduled-message cron — the list and the detail route must never disagree again. Note the staff branch of `getEstimateForPortal` bypasses this entirely, so an ADMIN-session test proves nothing about it: cover it as a real client (`e2e/portal-estimate-access.spec.ts`).
- **Money-path changes** (payments, signing, payment mirrors, notifications) — milestone edit surfaces, the client-visibility rules, and the editor lock are mapped in `docs/MILESTONE-EDITING.md`; no milestone EDIT path may ever notify the client (only payment settlement and the explicit Send/receipt buttons do). Estimate/invoice milestones are mirrored pairs linked by `PaymentSchedule.sourceScheduleId`; settling or unsettling either side must update both. Paid-milestone lifecycle side effects (team email, client receipt, activity log) have exactly **two** canonical single-writer notifiers in `src/lib/payment-notifications.ts` — `notifyMilestonePaid()` for invoice schedules and `notifyEstimateMilestonePaid()` for estimate schedules — and `src/lib/payment-outbox.ts` dispatches to the right one. A settle path that should notify must enqueue via `enqueueMilestonePaid()` inside the settle transaction rather than calling a notifier directly — some paths deliberately don't notify (progress-billing settlement, the Stripe backfill's `enqueueNotification: false`), so read the call site before copying it. Never add a third writer for a lifecycle event (two duplicate loggers shipped that way before the June 2026 audit caught them). The manual `send*PaymentReceiptOnly()` helpers and the `test-team-notify` debug action are deliberate non-lifecycle exceptions, not a precedent. After touching these paths: run codex-peer-review on the diff and keep `e2e/money-pipeline.spec.ts` green (PR CI runs it — it guards the sign→convert→invoice chain, mirror links, undo restore, and exactly-once activity writers).

## Efficiency rules (token management)
- **Full context, minimum tokens** — read the 4 reference docs (CLAUDE.md, VISION.md, DESIGN_SYSTEM.md, ProbuildTodo.md) for context, then build. Don't explore the codebase unless you're editing a file you haven't seen.
- **Use CLIs with `--json` flags** — `gh --json`, `vercel --json`, `supabase` CLI. Not MCPs.
- **Use Sonnet for implementation** — only use Opus for complex architecture/planning decisions
- **Run parallel sub-agents** for independent work (e.g. building 3 report pages simultaneously in separate agents)
- **Don't re-read large files** — if you already know the structure, reference it. GanttChart.tsx is 17k tokens — don't read it unless editing it.
- **Batch tool calls** — make independent reads/greps/globs in parallel, not sequential
- **Auth is already configured** — gh (keyring), vercel ($VERCEL_TOKEN), supabase ($SUPABASE_ACCESS_TOKEN), stripe ($STRIPE_API_KEY), sentry ($SENTRY_AUTH_TOKEN). Don't re-authenticate or verify credentials unless something fails. **One exception:** run `vercel whoami` before a production deploy — a stale `VERCEL_TOKEN` fails mid-deploy and does not fall back to the persisted login, so checking first is cheaper than a half-shipped release.

## Dead buttons / unlinked UI
- While working on any page, audit all buttons, links, and nav items for dead ends
- **Always fix, never remove** — wire to the correct route or server action
- Wiring must be intelligent — a "New Invoice" button should open an invoice form, not just navigate to /invoices
- If the target page/modal doesn't exist yet, build a minimal but real version — not a placeholder
