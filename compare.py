"""
compare.py — Screenshot each page of GoldenTouch Pro and compare side-by-side
             against the scraped Houzz Pro screenshots using Claude Haiku.
             Outputs a self-contained HTML report with diffs.

Usage:
    python compare.py               # compare all mapped pages
    python compare.py --page leads  # compare a single page by key
    python compare.py --no-ai       # screenshot only, skip Claude analysis
    python compare.py --force       # re-screenshot already-captured pages

Output:
    output/report.html
"""

import os
import re
import json
import asyncio
import hashlib
import base64
import logging
import argparse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from playwright.async_api import async_playwright, BrowserContext

import anthropic
from PIL import Image
from pydantic import BaseModel
import io

import config


# ── Response schema ────────────────────────────────────────────────────────────

class Issue(BaseModel):
    severity: str       # "critical" | "major" | "minor"
    area: str
    description: str
    suggestion: str

class DiffResult(BaseModel):
    score: int          # 0-100
    summary: str
    matches: list[str]
    issues: list[Issue]

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[logging.FileHandler("compare.log"), logging.StreamHandler()],
)
log = logging.getLogger(__name__)

# ── Your site config ───────────────────────────────────────────────────────────

YOUR_SITE = "https://probuild.goldentouchremodeling.com"

YOUR_COOKIES = {
    "__Secure-next-auth.session-token": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..YDidKiPDnOol8kvu.BUemfQ7D7-0V9tbkSoQqdSyry-88489OUsnV7KHJAB30RozRmJ76eA3nBgEwrGtUD-c4nZ395GnZzbJYF38ioZkKcQWsI4o19fes6aPso3UzHkRtdWUNG0wZnOS2DyX54lbsRu-DJ-RLr7_d4D9VB6FxXoQKDiy2_ydvGY9ek-7iHItH8Hvwt412Vp80GAhH_lXuoN0tsoBRNnCww6TQFkloZm1B7yQy16oJERzIicELhSlL1zg3eEe3t1dIVN8n74fRD33E54Plzi6MulxJPe7ciKHifqlaj46B2yXZ0tGjW_WX9YQzFXjspTLPId4Cm_q1ls5UabzOlDzt_W4fJT6Sekj6eOquLxaJwYC8_Dh5odoHvVvACMD2Ym5ADdYZxmW-skfZkEG1jRHAUHA.1izopklWK3CvyrfAEetNTg",
    "__Host-next-auth.csrf-token":      "ab734cf73becd41688eb7559fa30936e9af3cab47c41ebcf736f24188e738388%7Cd89e8e21dcf887d0e6f10adfcd433c9036eef41a4ea212e3b4a2eb520d6e68a2",
    "__Secure-next-auth.callback-url":  "https%3A%2F%2Fprobuild.goldentouchremodeling.com%2F",
    "_ga":                              "GA1.1.1853466886.1750206219",
}

# ── URL mapping: Houzz Pro URL → Your App path ────────────────────────────────
# Format: "label": ("houzz_url", "your_path")
# Houzz URLs must exist in output/pages/ from the scrape.
# Add more as you build out more pages.

URL_MAP = {
    # ── Projects ──────────────────────────────────────────────────────────────
    "Projects List":
        ("https://pro.houzz.com/manage/projects",
         "/projects"),

    "Project Overview":
        ("https://pro.houzz.com/manage/projects/2340349/overview",
         "/projects"),  # update with your project ID when ready

    # ── Leads ─────────────────────────────────────────────────────────────────
    "Leads List":
        ("https://pro.houzz.com/manage/leads",
         "/leads"),

    # ── Estimates ─────────────────────────────────────────────────────────────
    "Estimates":
        ("https://pro.houzz.com/manage/d/projects/2340349/estimates",
         "/estimates"),

    # ── Invoices ──────────────────────────────────────────────────────────────
    "Invoices":
        ("https://pro.houzz.com/manage/d/projects/2942703/request-payments",
         "/invoices"),

    # ── Schedule ──────────────────────────────────────────────────────────────
    "Schedule":
        ("https://pro.houzz.com/manage/schedule/projects/2942703",
         "/manager/schedule"),

    # ── Time & Expenses ───────────────────────────────────────────────────────
    "Time & Expenses":
        ("https://pro.houzz.com/manage/projects/2942703/time-and-expenses",
         "/manager/time-entries"),

    # ── Reports ───────────────────────────────────────────────────────────────
    "Reports Overview":
        ("https://pro.houzz.com/manage/reports/",
         "/manager/variance"),

    # ── Settings ──────────────────────────────────────────────────────────────
    "Settings":
        ("https://pro.houzz.com/settings/company-info",
         "/settings"),

    "Company":
        ("https://pro.houzz.com/settings/company-info",
         "/company"),

    # ── Daily Logs ────────────────────────────────────────────────────────────
    "Daily Logs":
        ("https://pro.houzz.com/manage/projects/2942703/daily-logs",
         "/projects"),  # update path when daily logs page exists
}

# ── Screenshot output dir ──────────────────────────────────────────────────────

COMPARE_DIR = os.path.join(config.OUTPUT_DIR, "compare")


# ── Cookie builder ─────────────────────────────────────────────────────────────

def build_your_cookies() -> list[dict]:
    return [
        {
            "name":     name,
            "value":    value,
            "domain":   "probuild.goldentouchremodeling.com",
            "path":     "/",
            "secure":   True,
            "httpOnly": True,
            "sameSite": "Lax",
        }
        for name, value in YOUR_COOKIES.items()
        if value
    ]


# ── Screenshot your site ───────────────────────────────────────────────────────

async def screenshot_your_page(context: BrowserContext, path: str, label: str) -> bytes | None:
    url  = YOUR_SITE + path
    page = await context.new_page()
    try:
        log.info(f"  -> Your site: {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)

        # Wait for Next.js to hydrate
        try:
            await page.wait_for_selector("main, nav, [class*='sidebar'], #__next > div > div", timeout=10000)
        except Exception:
            pass
        try:
            await page.wait_for_load_state("networkidle", timeout=12000)
        except Exception:
            pass

        await asyncio.sleep(1.5)

        screenshot = await page.screenshot(full_page=True, type="png")
        log.info(f"  [OK] Your site captured: {label} ({len(screenshot):,} bytes)")
        return screenshot

    except Exception as exc:
        log.error(f"  [FAIL] Your site failed [{label}]: {exc}")
        return None
    finally:
        await page.close()


# ── Load Houzz screenshot ──────────────────────────────────────────────────────

def load_houzz_screenshot(houzz_url: str) -> bytes | None:
    pid    = hashlib.md5(houzz_url.encode()).hexdigest()
    path   = os.path.join(config.OUTPUT_DIR, "pages", pid, "screenshot.png")
    if not os.path.exists(path):
        log.warning(f"  No Houzz screenshot found for {houzz_url} (id={pid})")
        return None
    with open(path, "rb") as f:
        return f.read()


# ── Claude Haiku diff ──────────────────────────────────────────────────────────

DIFF_PROMPT = """You are a senior UI/UX engineer doing a visual QA comparison.

You are given two screenshots:
  IMAGE 1 = the REFERENCE (Houzz Pro — the target design)
  IMAGE 2 = the IMPLEMENTATION (GoldenTouch Pro — what's been built)

Compare them carefully and return a JSON object with this exact structure:
{
  "score": <0-100 overall similarity score>,
  "summary": "<one sentence overall assessment>",
  "matches": ["<thing that matches well>", ...],
  "issues": [
    {
      "severity": "critical|major|minor",
      "area": "<e.g. Navigation, Header, Table, Button, Color>",
      "description": "<what is wrong or missing>",
      "suggestion": "<how to fix it>"
    },
    ...
  ]
}

Be specific about colors (use hex where possible), spacing, typography, and layout.
Output ONLY the JSON — no markdown, no explanation."""


def run_claude_diff(client: anthropic.Anthropic, houzz_bytes: bytes, yours_bytes: bytes, label: str) -> dict:
    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": base64.b64encode(houzz_bytes).decode(),
                        },
                    },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": base64.b64encode(yours_bytes).decode(),
                        },
                    },
                    {"type": "text", "text": DIFF_PROMPT},
                ],
            }],
        )

        return json.loads(response.content[0].text)

    except Exception as exc:
        log.error(f"  Claude diff failed for [{label}]: {exc}")
        return {
            "score": 0,
            "summary": f"Analysis failed: {exc}",
            "matches": [],
            "issues": [{"severity": "critical", "area": "Analysis",
                        "description": str(exc), "suggestion": "Retry"}]
        }


# ── HTML report builder ────────────────────────────────────────────────────────

def severity_color(s: str) -> str:
    return {"critical": "#dc2626", "major": "#f59e0b", "minor": "#3b82f6"}.get(s, "#6b7280")


def score_color(score: int) -> str:
    if score >= 80: return "#16a34a"
    if score >= 60: return "#f59e0b"
    return "#dc2626"


def img_to_b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def build_report(results: list[dict]) -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    avg_score = int(sum(r["diff"].get("score", 0) for r in results if r["diff"]) /
                    max(1, sum(1 for r in results if r["diff"])))

    cards = ""
    for r in results:
        label      = r["label"]
        houzz_url  = r["houzz_url"]
        your_url   = r["your_url"]
        diff       = r.get("diff") or {}
        houzz_b64  = img_to_b64(r["houzz_img"]) if r.get("houzz_img") else ""
        yours_b64  = img_to_b64(r["yours_img"]) if r.get("yours_img") else ""
        score      = diff.get("score", "?")
        summary    = diff.get("summary", "No analysis available")
        matches    = diff.get("matches", [])
        issues     = diff.get("issues", [])

        matches_html = "".join(f'<li>{m}</li>' for m in matches)
        issues_html  = ""
        for issue in issues:
            sev   = issue.get("severity", "minor")
            color = severity_color(sev)
            issues_html += f"""
            <div class="issue" style="border-left:4px solid {color}">
                <div class="issue-header">
                    <span class="badge" style="background:{color}">{sev.upper()}</span>
                    <strong>{issue.get('area','')}</strong>
                </div>
                <p>{issue.get('description','')}</p>
                <p class="suggestion">Fix: {issue.get('suggestion','')}</p>
            </div>"""

        houzz_img_html = f'<img src="data:image/png;base64,{houzz_b64}" alt="Houzz Pro">' if houzz_b64 else '<div class="no-img">No screenshot</div>'
        yours_img_html = f'<img src="data:image/png;base64,{yours_b64}" alt="Your Site">' if yours_b64 else '<div class="no-img">No screenshot</div>'

        sc = score_color(score if isinstance(score, int) else 0)
        cards += f"""
        <div class="card">
            <div class="card-header">
                <h2>{label}</h2>
                <div class="score" style="background:{sc}">{score}<span>/100</span></div>
            </div>
            <p class="summary">{summary}</p>
            <div class="urls">
                <span>Houzz: <code>{houzz_url}</code></span>
                <span>Yours: <code>{YOUR_SITE}{your_url}</code></span>
            </div>
            <div class="screenshots">
                <div class="shot">
                    <div class="shot-label">Houzz Pro (Reference)</div>
                    {houzz_img_html}
                </div>
                <div class="shot">
                    <div class="shot-label">GoldenTouch Pro (Your Build)</div>
                    {yours_img_html}
                </div>
            </div>
            <div class="analysis">
                {'<div class="matches"><h4>Matching</h4><ul>' + matches_html + '</ul></div>' if matches else ''}
                {'<div class="issues-list"><h4>Issues</h4>' + issues_html + '</div>' if issues else ''}
            </div>
        </div>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GoldenTouch Pro vs Houzz Pro — QA Report</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: #f1f5f9; color: #1e293b; }}
  header {{ background: #1e293b; color: white; padding: 24px 32px;
            display: flex; justify-content: space-between; align-items: center; }}
  header h1 {{ font-size: 20px; font-weight: 700; }}
  header .meta {{ font-size: 13px; opacity: 0.7; text-align: right; }}
  .overall {{ background: white; padding: 20px 32px; border-bottom: 1px solid #e2e8f0;
              display: flex; gap: 32px; align-items: center; }}
  .overall .big-score {{ font-size: 48px; font-weight: 800; }}
  .overall p {{ color: #64748b; font-size: 14px; }}
  .container {{ max-width: 1400px; margin: 0 auto; padding: 24px 32px; }}
  .card {{ background: white; border-radius: 12px; margin-bottom: 32px;
           box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow: hidden; }}
  .card-header {{ display: flex; justify-content: space-between; align-items: center;
                  padding: 20px 24px; border-bottom: 1px solid #f1f5f9; }}
  .card-header h2 {{ font-size: 17px; font-weight: 700; }}
  .score {{ color: white; font-size: 22px; font-weight: 800; padding: 6px 14px;
            border-radius: 8px; }}
  .score span {{ font-size: 13px; opacity: .8; }}
  .summary {{ padding: 12px 24px; color: #475569; font-size: 14px;
              border-bottom: 1px solid #f8fafc; }}
  .urls {{ padding: 8px 24px; font-size: 12px; color: #94a3b8;
           display: flex; gap: 24px; border-bottom: 1px solid #f8fafc; }}
  .urls code {{ background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }}
  .screenshots {{ display: grid; grid-template-columns: 1fr 1fr; gap: 0;
                  border-bottom: 1px solid #f1f5f9; }}
  .shot {{ padding: 16px 24px; }}
  .shot:first-child {{ border-right: 1px solid #f1f5f9; }}
  .shot-label {{ font-size: 12px; font-weight: 600; color: #64748b;
                 text-transform: uppercase; letter-spacing: .05em; margin-bottom: 10px; }}
  .shot img {{ width: 100%; border-radius: 6px; border: 1px solid #e2e8f0;
               cursor: zoom-in; transition: transform .2s; }}
  .shot img:hover {{ transform: scale(1.02); }}
  .no-img {{ height: 200px; background: #f8fafc; border: 2px dashed #cbd5e1;
             border-radius: 6px; display: flex; align-items: center;
             justify-content: center; color: #94a3b8; font-size: 14px; }}
  .analysis {{ display: grid; grid-template-columns: 1fr 2fr; gap: 0; }}
  .matches {{ padding: 16px 24px; border-right: 1px solid #f1f5f9; }}
  .matches h4, .issues-list h4 {{ font-size: 13px; font-weight: 700; color: #64748b;
                                   text-transform: uppercase; letter-spacing: .05em;
                                   margin-bottom: 10px; }}
  .matches ul {{ list-style: none; }}
  .matches li {{ font-size: 13px; color: #16a34a; padding: 3px 0; }}
  .matches li::before {{ content: "OK "; font-weight: 700; }}
  .issues-list {{ padding: 16px 24px; }}
  .issue {{ padding: 10px 14px; border-radius: 6px; margin-bottom: 8px;
            background: #fafafa; }}
  .issue-header {{ display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }}
  .badge {{ color: white; font-size: 10px; font-weight: 700; padding: 2px 7px;
            border-radius: 4px; text-transform: uppercase; letter-spacing: .05em; }}
  .issue p {{ font-size: 13px; color: #475569; margin-bottom: 4px; }}
  .suggestion {{ color: #7c3aed !important; font-style: italic; }}
</style>
</head>
<body>
<header>
  <h1>GoldenTouch Pro — Visual QA Report</h1>
  <div class="meta">
    vs Houzz Pro<br>
    Generated {timestamp}
  </div>
</header>
<div class="overall">
  <div class="big-score" style="color:{score_color(avg_score)}">{avg_score}</div>
  <div>
    <p style="font-size:16px;font-weight:600">Overall Similarity Score</p>
    <p>Across {len(results)} pages compared</p>
  </div>
</div>
<div class="container">
{cards}
</div>
</body>
</html>"""


# ── Main ───────────────────────────────────────────────────────────────────────

async def run(pages: dict, use_ai: bool, force: bool):
    os.makedirs(COMPARE_DIR, exist_ok=True)

    client = None
    if use_ai:
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

    results = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        await context.add_cookies(build_your_cookies())
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        for label, (houzz_url, your_path) in pages.items():
            log.info(f"\n[{label}]")

            cache_path = os.path.join(COMPARE_DIR, hashlib.md5(label.encode()).hexdigest() + ".png")

            # Screenshot your site (use cache unless --force)
            if not force and os.path.exists(cache_path):
                log.info(f"  Using cached screenshot for: {label}")
                with open(cache_path, "rb") as f:
                    yours_bytes = f.read()
            else:
                yours_bytes = await screenshot_your_page(context, your_path, label)
                if yours_bytes:
                    with open(cache_path, "wb") as f:
                        f.write(yours_bytes)

            houzz_bytes = load_houzz_screenshot(houzz_url)

            # Run AI diff
            diff = None
            if use_ai and houzz_bytes and yours_bytes:
                log.info(f"  Running Claude diff for: {label}")
                diff = run_claude_diff(client, houzz_bytes, yours_bytes, label)
                score = diff.get("score", "?")
                log.info(f"  Score: {score}/100 — {diff.get('summary', '')}")

            results.append({
                "label":     label,
                "houzz_url": houzz_url,
                "your_url":  your_path,
                "houzz_img": houzz_bytes,
                "yours_img": yours_bytes,
                "diff":      diff,
            })

            await asyncio.sleep(1.0)

        await context.close()
        await browser.close()

    # Build report
    report_path = os.path.join(config.OUTPUT_DIR, "report.html")
    html = build_report(results)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(html)

    log.info(f"\nReport saved -> {report_path}")
    return report_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare GoldenTouch Pro vs Houzz Pro.")
    parser.add_argument("--page",  help="Compare a single page by label key")
    parser.add_argument("--no-ai", action="store_true", help="Skip Claude analysis, screenshots only")
    parser.add_argument("--force", action="store_true", help="Re-screenshot even if cached")
    args = parser.parse_args()

    if not config.ANTHROPIC_API_KEY:
        raise SystemExit("Set ANTHROPIC_API_KEY in config.py first.")

    if args.page:
        key = args.page
        if key not in URL_MAP:
            raise SystemExit(f"Unknown page key '{key}'. Options: {list(URL_MAP.keys())}")
        pages = {key: URL_MAP[key]}
    else:
        pages = URL_MAP

    report = asyncio.run(run(pages, use_ai=not args.no_ai, force=args.force))
    log.info(f"Done! Open: {report}")
