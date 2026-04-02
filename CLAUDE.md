# CLAUDE.md — houzz-scrape project context

## What this project does
Visual QA pipeline: scrape Houzz Pro → screenshot GoldenTouch Pro → Claude Haiku diffs them → HTML report.

## Key paths
| Thing | Path |
|---|---|
| This project | `C:\Users\jat00\OneDrive\Documents\Claude\houzz-scrape` |
| Probuild repo | `C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site` |
| Scraped Houzz pages | `output/pages/<md5>/` (107 pages, already done) |
| QA report | `output/report.html` |
| Cached screenshots | `output/compare/` |

## Probuild stack
- Next.js, npm, Prisma, Tailwind
- GitHub: https://github.com/Clarion1631/probuild
- Vercel auto-deploys on push to `main`
- **Deploy workflow:** edit files in probuild repo → `git add` → `git commit` → `git push origin main` → Vercel deploys automatically

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

## Last known scores (April 2, 2026 — 42/100 overall)
| Page | Score | Root cause |
|---|---|---|
| Projects List | 65 | Missing summary cards, wrong columns |
| Invoices | 65 | Nav structure, filter UI |
| Estimates | 55 | Missing right-hand summary panel |
| Schedule | 45 | Missing onboarding wizard |
| Leads List | 45 | Missing tabbed views, columns |
| Daily Logs | 40 | Route not mapped (showing /projects) |
| Reports | 35 | Wrong view, sidebar |
| Project Overview | 35 | Showing list instead of detail |
| Company | 15 | 404 — route not built |
| Settings | 5 | 404 — route not built |
| Time & Expenses | 0 | Server exception |

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
1. Run `python compare.py --page "Page Name"` to get current diff
2. Read the issue descriptions in the report
3. Make fixes in the probuild repo
4. `git add . && git commit -m "fix: ..." && git push origin main`
5. Wait ~60s for Vercel to deploy
6. Re-run `python compare.py --page "Page Name" --force` to verify score improved
