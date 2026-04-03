# CLAUDE.md — ProBuild Project Context

## What this project is
**ProBuild** — a construction/contractor management platform (competitor to Houzz Pro). Built with Next.js, Prisma, Supabase, deployed on Vercel.

## Key paths
| Thing | Path |
|---|---|
| This project (Windows) | `C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site` |
| GitHub | https://github.com/Clarion1631/probuild |
| Production | https://probuild.goldentouchremodeling.com |
| Vercel preview | https://probuild-amber.vercel.app |
| Known prod project ID | `cmn7tlgiv0001phwqjzwk75or` |

## Stack
- Next.js 16 (App Router, Server Components, Server Actions), npm, Prisma 5, Tailwind
- Supabase (PostgreSQL, auth, storage) — project ref: `ghzdbzdnwjxazvmcefbh`
- Vercel auto-deploys on push to `main`

## Product Vision
See **VISION.md** — AI-first remodeling platform. Every feature should ask: "What can AI do here so the human doesn't have to?"

## Active Build Plan
See **ProbuildTodo.md** — execute sessions in order (Sessions 3–7 remain).
Sessions 1–2 + Gantt polish are complete. Each session lists specific files, actions, and schema changes.

## Development workflow
```
1. Pick next session from ProbuildTodo.md
2. Make changes
3. npm run build          # must pass 0 errors
4. git push origin main   # triggers Vercel deploy
5. Click through affected pages on prod to verify
6. Mark items done in ProbuildTodo.md
```

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
3. Regenerate: `"C:\Program Files\Git\bin\bash.exe" -c "cd '/c/Users/jat00/.gemini/antigravity/workspaces/gtr-probuild-site' && ./node_modules/.bin/prisma generate"`
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

## Common pitfalls
- **config.py is gitignored** — never commit it, it contains secrets
- **GoldenTouch Pro URL** is `https://probuild-amber.vercel.app` — that's the live Vercel deployment
- **WSL env vars** — `setx` vars (VERCEL_TOKEN, STRIPE_API_KEY, etc.) are Windows-only, NOT available in WSL

## Coding rules

- **Design system** — use `hui-btn`, `hui-card`, `hui-input` etc. Never raw Tailwind for those elements
- **Server actions** — go in `src/lib/actions.ts` by default; existing split files (client-actions.ts, lead-note-actions.ts, subcontractor-actions.ts) are legacy — don't add new ones
- **Server components by default** — only add `"use client"` when strictly needed (event handlers, hooks, browser APIs)
- **No dummy UI** — every button, link, and form must be fully wired before committing
- **Database** — always use Prisma (`src/lib/prisma.ts`), not direct Supabase client, for data access; Supabase is auth/storage only
- **Schema changes** — do NOT use `npx prisma db push` (hangs in WSL) or `prisma migrate dev` (port 5432 blocked). Instead: apply SQL via `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`, then regenerate client with `./node_modules/.bin/prisma generate` from git bash
- **DATABASE_URL must include `?pgbouncer=true`** — Supabase transaction pooler (port 6543) + Prisma requires this flag. Without it you get `42P05 prepared statement already exists` and the site goes down. Correct format: `postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
- **Auth roles** — ADMIN, MANAGER, FIELD_CREW, FINANCE — check `src/lib/permissions.ts` before adding role-gated UI
- **Toasts** — use `sonner` (already in layout), not any other toast library
- **Existing routes** — api, company, estimates, invoices, leads, login, manager, portal, projects, reports, settings, sub-portal, time-clock — don't duplicate

## Dead buttons / unlinked UI
- While working on any page, audit all buttons, links, and nav items for dead ends
- **Always fix, never remove** — wire to the correct route or server action
- Wiring must be intelligent — a "New Invoice" button should open an invoice form, not just navigate to /invoices
- If the target page/modal doesn't exist yet, build a minimal but real version — not a placeholder
- Keep a running list in HANDOFF.md under "Dead UI" of anything found but not yet fixed in the current session
