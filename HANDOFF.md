# Houzz Scrape — Project Handoff

## What This Project Does

Three-script pipeline:
1. **`scraper.py`** — Playwright (local Chromium) crawls 107 Houzz Pro pages using session cookies, saves HTML + full-page screenshots + metadata to disk and SQLite
2. **`compare.py`** — Screenshots GoldenTouch Pro (live Vercel), compares each page side-by-side against the Houzz Pro screenshots using Claude Haiku vision, outputs `output/report.html`
3. **`cloner.py`** — Feeds each Houzz Pro page into Gemini Flash to generate a cloned standalone HTML file (optional — use if you want AI-generated page templates)

## Sites

| Site | URL |
|---|---|
| Houzz Pro (reference) | https://pro.houzz.com |
| GoldenTouch Pro (your build) | https://probuild.goldentouchremodeling.com |
| GoldenTouch Pro repo | https://github.com/Clarion1631/probuild |
| Local repo (DO NOT TOUCH without asking) | `C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site` |

## API Keys (in config.py)

- `ANTHROPIC_API_KEY` — Claude Haiku for visual diffs in compare.py
- `GEMINI_API_KEY` — Gemini Flash for HTML cloning in cloner.py
- `SCRAPINGBEE_API_KEY` — Not used (replaced by Playwright)

## Current State

### Scraping — DONE
- **107/107 Houzz Pro pages** scraped with no failures
- All saved to `output/pages/<md5-hash>/`
  - `screenshot.png` — full-page screenshot
  - `raw.html` — full rendered HTML
  - `meta.json` — URL, title, meta tags
  - `text.txt` — visible text content
- SQLite index at `output/pages.db`

### Comparison — WORKING
Last run scores (Claude Haiku, April 2, 2026):

| Page | Score | Key Issue |
|---|---|---|
| Projects List | 65/100 | Missing summary cards, wrong data columns |
| Invoices | 65/100 | Nav structure, filter UI, data formatting |
| Estimates | 55/100 | Missing right-hand summary panel, status badges |
| Schedule | 45/100 | Missing onboarding wizard, component styling |
| Leads List | 45/100 | Missing tabbed views, data columns |
| Daily Logs | 40/100 | Route not mapped (showing projects list) |
| Reports | 35/100 | Sidebar styling, showing wrong view |
| Project Overview | 35/100 | Showing list instead of project detail |
| Company | 15/100 | 404 — route not built |
| Settings | 5/100 | 404 — route not built |
| Time & Expenses | 0/100 | Server exception — broken page |

**Overall: ~42/100**

## How to Run

```bash
# Install deps (one time)
pip install -r requirements.txt
playwright install chromium

# Re-scrape Houzz Pro (only needed if cookies expire or new pages added)
python scraper.py

# Run visual QA comparison (generates output/report.html)
python compare.py

# Compare a single page
python compare.py --page "Estimates"

# Re-screenshot everything fresh
python compare.py --force

# AI-clone Houzz pages to standalone HTML (optional)
python cloner.py
```

## URL Mapping (compare.py)

The `URL_MAP` dict in `compare.py` maps Houzz Pro URLs to GoldenTouch Pro paths.
Currently mapped pages + paths to fix/add:

```python
# These need correct paths updated:
"Project Overview"  → /projects/[your-project-id]   # needs real ID
"Daily Logs"        → /projects/[id]/daily-logs      # route doesn't exist yet
"Settings"          → /settings                       # 404 - fix route
"Company"           → /company                        # 404 - fix route
"Time & Expenses"   → /manager/time-entries           # server error - fix bug
```

## Cookie Expiry

Session cookies for both sites will expire. When you see 401/403 or login redirects:

**Houzz Pro cookies** → Re-export from browser → update `SESSION_COOKIES` in `config.py`

**GoldenTouch Pro cookies** → Re-export from browser → update `YOUR_COOKIES` in `compare.py`

The critical Houzz cookie is `_ivy_session_key`.
The critical GoldenTouch cookie is `__Secure-next-auth.session-token`.

## File Structure

```
houzz-scrape/
  config.py          # all API keys, cookies, URLs, settings
  scraper.py         # Playwright crawler for Houzz Pro
  compare.py         # visual QA diff tool (Playwright + Claude Haiku)
  cloner.py          # AI page cloner (Gemini Flash)
  requirements.txt
  scraper.log
  compare.log
  output/
    pages.db         # SQLite index of all scraped pages
    report.html      # latest QA comparison report
    pages/           # scraped Houzz Pro pages (107 folders)
    compare/         # cached GoldenTouch Pro screenshots
    cloned/          # AI-cloned HTML files (if cloner.py has been run)
```

## Next Priorities (based on QA results)

1. Fix server exception on `/manager/time-entries`
2. Fix 404 on `/settings` and `/company` routes
3. Add right-hand financial summary panel to Estimates page
4. Add summary cards to top of Projects List
5. Build `/daily-logs` route
6. Update URL_MAP in compare.py with real project/lead IDs for dynamic route testing
