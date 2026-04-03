# CLAUDE.md — houzz-scrape project context

## What this project does
Visual QA pipeline: scrape Houzz Pro → screenshot GoldenTouch Pro → Claude Haiku diffs them → HTML report.

## Key paths
| Thing | Path |
|---|---|
| This project (Windows) | `C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site` |
| This project (WSL) | `/mnt/c/Users/jat00/.gemini/antigravity/workspaces/gtr-probuild-site` |
| compare.py | Run from project root — `python compare.py` |
| Scraped Houzz pages | `output/pages/<md5>/` (107 pages, already done) |
| QA report | `output/report.html` |
| Cached screenshots | `output/compare/` |

## Probuild stack
- Next.js, npm, Prisma, Tailwind
- GitHub: https://github.com/Clarion1631/probuild
- Vercel auto-deploys on push to `main`
- **Deploy workflow:** edit files in probuild repo → `git add` → `git commit` → `git push origin main` → Vercel deploys automatically

## WSL env vars
- `setx` env vars (VERCEL_TOKEN, STRIPE_API_KEY, etc.) are Windows-only — NOT available in WSL
- To check Vercel deploy status from WSL: `gh run list --repo Clarion1631/probuild --limit 5`
- To check latest deploy: `gh api repos/Clarion1631/probuild/actions/runs --jq '.workflow_runs[0] | {status,conclusion,created_at}'`

## Dev server — clean start
```bash
# Kill any zombie processes and start fresh
kill -9 $(lsof -ti tcp:3000,3001,3002) 2>/dev/null; rm -f .next/dev/lock; sleep 2
npm run dev > /tmp/devserver.log 2>&1 &
sleep 15 && curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```
- Always use port 3000 — if it's taken, kill it, don't switch ports
- If still failing, `rm -rf .next && npm run dev`

## Running the pipeline
```bash
# Full fresh comparison (re-screenshots everything)
python compare.py --force

# Single page test
python compare.py --page "Leads List"

# Screenshots only, no AI
python compare.py --no-ai

# Re-scrape Houzz (only if cookies expire or new pages needed)
python scraper.py
```

## API keys (config.py)
- `ANTHROPIC_API_KEY` — Claude Haiku, used by compare.py for visual diffs
- `GEMINI_API_KEY` — Gemini Flash, used by cloner.py only
- `SCRAPINGBEE_API_KEY` — unused

## Active Build Plan
See **ProbuildTodo.md** in this repo root — execute sessions in order (Session 1 → 7).
Current score: ~67/100. Each session has specific files, actions, and compare.py entries.

> **Schema migration:** `npx prisma db push` hangs interactively in WSL. Use:
> `powershell -ExecutionPolicy Bypass -File "C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1"`
> Then regenerate: `"C:\Program Files\Git\bin\bash.exe" -c "cd '/c/Users/jat00/.gemini/antigravity/workspaces/gtr-probuild-site' && ./node_modules/.bin/prisma generate"`

## Last known scores (April 3, 2026 — 67/100 overall)
| Page | Score | Notes |
|---|---|---|
| Company | 75 | Fixed |
| Projects List | 72 | |
| Project Overview | 72 | Fixed (was 404) |
| Leads List | 72 | |
| Estimates | 72 | |
| Time & Expenses | 72 | Fixed (was server error) |
| Settings | 72 | Fixed (was 404) |
| Daily Logs | 72 | Fixed (was unmapped) |
| Reports Overview | 62 | Needs layout sidebar |
| Invoices | 45 | Layout/hierarchy gaps |
| Schedule | 35 | Gantt rebuilt — needs rescore |
| **Overall** | **~67/100** | |

## Production data
- **Never use local DB IDs in compare.py URL_MAP** — local and prod IDs differ
- Query prod project IDs via the live API (cookies already in compare.py):
  ```bash
  curl -s "https://probuild.goldentouchremodeling.com/api/projects" \
    -H "Cookie: __Secure-next-auth.session-token=<token from YOUR_COOKIES in compare.py>" \
    | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); JSON.parse(d).forEach(p=>console.log(p.id, p.name))"
  ```
- Known prod project ID: `cmn7tlgiv0001phwqjzwk75or` (use this in URL_MAP for Project Overview)
- Do NOT try psql, prisma direct connect, or supabase CLI to query prod — use the API

## Common pitfalls

- **ANTHROPIC_API_KEY** is in `config.py` — do not prompt the user for it or look for it in env vars
- **Houzz scraped pages** live at `output/pages/` in this repo — if empty, copy from `/home/jitters/projects/houzz-scrape-new/output/`
- **config.py is gitignored** — never commit it, never push it, it contains secrets
- **compare.py runs from repo root** — never cd elsewhere before running it
- **GoldenTouch Pro URL** is `https://probuild-amber.vercel.app` — that's the live site compare.py screenshots
- **Do not re-scrape Houzz** unless cookies have expired — the 107 pages are already cached in `output/pages/`

## URL_MAP issues to fix (compare.py)
- `Project Overview` → needs real probuild project ID in path
- `Daily Logs` → route doesn't exist yet in probuild
- `Settings` → 404
- `Company` → 404
- `Time & Expenses` → server error

## Cookie expiry
When you see 401/403 or login redirects:
- **Houzz cookies** → re-export from browser → update `SESSION_COOKIES` in `config.py`
- **GoldenTouch cookies** → re-export from browser → update `YOUR_COOKIES` in `compare.py`
- Critical Houzz cookie: `_ivy_session_key`
- Critical GoldenTouch cookie: `__Secure-next-auth.session-token`

## Workflow for fixing UI issues
1. Run `npm run dev` in a separate terminal (keep it running)
2. Run `python compare.py --local --page "Page Name"` to get current diff
3. Read the issue descriptions in the report
4. Make fixes in the repo
5. Re-run `python compare.py --local --page "Page Name"` to verify score improved (--local always forces fresh screenshots)
6. Once happy: `git add . && git commit -m "fix: ..." && git push origin main` → Vercel auto-deploys

## Important
- Always test with `--local` first — instant feedback, no waiting for Vercel
- Only push to main when the local score has improved
- Never test against production to verify fixes — that wastes a deploy cycle
- `--force` is only needed on production runs to bust the screenshot cache

## Coding rules

- **Design system** — use `hui-btn`, `hui-card`, `hui-input` etc. Never raw Tailwind for those elements
- **Server actions** — go in `src/lib/actions.ts` by default; existing split files (client-actions.ts, lead-note-actions.ts, subcontractor-actions.ts) are legacy — don't add new ones
- **Server components by default** — only add `"use client"` when strictly needed (event handlers, hooks, browser APIs)
- **No dummy UI** — every button, link, and form must be fully wired before committing
- **Database** — always use Prisma (`src/lib/prisma.ts`), not direct Supabase client, for data access; Supabase is auth/storage only
- **Schema changes** — do NOT use `npx prisma db push` (hangs in WSL) or `prisma migrate dev` (port 5432 blocked). Instead: apply SQL via `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`, then regenerate client with `./node_modules/.bin/prisma generate` from git bash
- **Auth roles** — ADMIN, MANAGER, FIELD_CREW, FINANCE — check `src/lib/permissions.ts` before adding role-gated UI
- **Toasts** — use `sonner` (already in layout), not any other toast library
- **Existing routes** — api, company, estimates, invoices, leads, login, manager, portal, projects, reports, settings, sub-portal, time-clock — don't duplicate

## Dead buttons / unlinked UI
- While working on any page, audit all buttons, links, and nav items for dead ends
- **Always fix, never remove** — wire to the correct route or server action
- Wiring must be intelligent — a "New Invoice" button should open an invoice form, not just navigate to /invoices
- If the target page/modal doesn't exist yet, build a minimal but real version — not a placeholder
- Keep a running list in HANDOFF.md under "Dead UI" of anything found but not yet fixed in the current session
