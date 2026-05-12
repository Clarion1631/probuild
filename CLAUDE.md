# CLAUDE.md — ProBuild Project Context

## What this project is
**ProBuild** — a construction/contractor management platform (competitor to Houzz Pro). Built with Next.js, Prisma, Supabase, deployed on Vercel.

## Key paths & service IDs
| Thing | Value |
|---|---|
| This project (Windows) | `C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site` |
| GitHub | https://github.com/Clarion1631/probuild |
| Production | https://probuild.goldentouchremodeling.com |
| Vercel preview | https://probuild-amber.vercel.app |
| Vercel project ID | `prj_sd7R3WIYZCRMnu5IhAudBdc4vuIL` |
| Supabase project ref | `ghzdbzdnwjxazvmcefbh` |
| Sentry org | `golden-touch-remodeling` (us.sentry.io) |
| Known prod DB project ID | `cmn7tlgiv0001phwqjzwk75or` |

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
- Auto-deploy is **disabled**. Deploy manually via `vercel --prod`

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
2. Make changes on a focused branch or local working tree
3. npm run build          # must pass 0 errors
4. Run the Playwright smoke gate when auth/app flow is touched
5. Ask before pushing, opening/merging PRs, or deploying production
6. Deploy production with the staged deploy script only after user approval
7. Click through affected pages on prod to verify
8. Mark items done in ProbuildTodo.md
```

## AI agent operating rules
AI can automate local diagnosis and repair without a separate push from the user:
- Inspect GitHub/Vercel logs, local `git status`, build output, and downloaded artifacts
- Edit code, tests, docs, and workflow files in the current workspace
- Run local verification: `npm run typecheck`, `npm run build`, and the Playwright smoke suite
- Prepare a commit message, PR description, deploy checklist, or rollback checklist
- Keep generated local artifacts out of git when they are clearly tool output
- Perform a final self-review of its own diff before asking to publish
- Perform a Codex-style peer review before any push, PR-ready state, merge recommendation, or production deploy

AI must ask first before actions that create cost, publish code, or touch production state:
- `git push`, opening/updating/merging/closing PRs, rebasing shared branches, or force pushes
- `vercel --prod`, `vercel promote`, `vercel rollback`, or re-enabling Vercel Git auto-deploy
- Database migrations, seed scripts against production data, or destructive file cleanup
- Running the full Playwright suite (`npm run test:e2e`) unless the user explicitly wants it

Default branch strategy:
- Do not push directly to `main`
- Use one branch/PR per concern: CI/deploy workflow, schedule UI, mobile app, schema changes, etc.
- If an old PR conflicts with current work, inspect it and recommend close/supersede/cherry-pick instead of merging blindly
- Preserve user/other-agent edits already in the worktree; separate them in the final summary

## AI session handoff checklist
At the end of every coding session, the AI should report:
- Files changed, separated into "AI changed" and "pre-existing/user changes"
- Verification run and exact pass/fail result
- Remaining untracked files and whether they should be committed, ignored, or left alone
- Whether the work is ready for PR, ready for staged production deploy, or still local-only

Recommended user prompt when a feature feels done:
```text
Run the ProBuild handoff checklist: review your diff, run the local deploy gate, tell me what changed, and ask before pushing or deploying.
```

Codex-style review is mandatory for ProBuild before publishing or deploying. Review stance:
- Lead with bugs, regressions, missing tests, production risks, deploy safety, and data/security issues
- Cite concrete files/lines when possible
- Keep summaries secondary to findings
- If no issues are found, say so clearly and name residual risk
- Do not proceed to push, mark ready for review, merge, or deploy until review findings are resolved or the user explicitly accepts the risk

Recommended user prompt when you want an extra independent review at any time:
```text
Do a Codex-style peer review before we push: focus on bugs, regressions, missing tests, production risks, and deploy safety.
```

Do not claim peer review happened unless a distinct review pass was explicitly performed. For ProBuild, that review pass is part of the default handoff.

## Cost-safe verification gate
Use this before any production deploy:
```powershell
npm run build
$secret = (Get-Content .env.local | Where-Object { $_ -match '^PLAYWRIGHT_TEST_SECRET=' } | Select-Object -First 1) -replace '^PLAYWRIGHT_TEST_SECRET=', ''
$env:PLAYWRIGHT_TEST_SECRET=$secret
$env:CI='true'
npm run test:e2e:smoke
```

The smoke suite is the normal PR gate. Full E2E, Lighthouse, and visual comparison are manual/targeted tools, not every-push automation.

## Production deploy gate
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-prod.ps1
```
This is the only blessed production deploy path after local verification. It:
1. Creates a staged production Vercel deployment with `--skip-domain`
2. Runs the Playwright smoke gate against the staged deployment URL
3. Promotes that staged deployment to production only if the staged smoke gate passes

Do not run raw `vercel --prod`, `vercel deploy --prod`, or `vercel promote` unless the user explicitly asks to bypass the gate. On this Windows workspace, keep `npm run build` as a top-level terminal command; nested build wrappers can trigger `spawn EPERM`.

**Error diagnosis (Sentry)**
```bash
sentry-cli issues list --org golden-touch-remodeling --project <project> --output json
```

**Stripe webhook testing**
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe --output json
stripe trigger payment_intent.succeeded
```

## Deploying to Vercel (CLI only — auto-deploy is OFF)
```powershell
# Production deploy (from the main repo dir, not a worktree):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-prod.ps1
```
- Auto-deploy was disabled in `vercel.json` to avoid runaway build costs ($250 bill from frequent pushes)
- **Do NOT use `--archive=tgz`** — it triggered a 50-min outage on 2026-05-09. Vercel CLI ran `vercel build` locally with Turbopack (Next.js 16 default), which emits chunks with bracket characters in filenames (`[root-of-the-server]__<hash>._.js`, `[turbopack]_runtime.js`). Those got dropped during Lambda packaging server-side, leaving every page with a `ChunkLoadError: MODULE_NOT_FOUND`. Source files are under Vercel's 15K limit with `.vercelignore`, so the archive flag is unnecessary.
- The build script pins `--webpack` (see `package.json` `build:next`) as a defense-in-depth so future deploys cannot regress to bracket-named chunks.
- `--cwd` points to the main repo — deploy from there, not from worktrees (worktrees lack the `.vercel` link)
- Only deploy when changes are verified locally via `npm run build`
- Do NOT re-enable auto-deploy in vercel.json or the Vercel dashboard

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
3. Regenerate: `powershell -Command "cd 'C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site'; node_modules\.bin\prisma generate"`
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
- Known prod project ID: `cmn7tlgiv0001phwqjzwk75or`
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
