"""
scraper.py — Scrape Houzz Pro pages using Playwright (local Chromium).
             No ScrapingBee needed — session cookies authenticate directly.
             Saves HTML, full-page screenshots, and metadata to disk + SQLite.

Setup:
    pip install playwright
    playwright install chromium

Usage:
    python scraper.py                 # scrape all URLs in config.URL_LIST
    python scraper.py --url <url>     # scrape a single URL
    python scraper.py --force         # re-scrape already-done pages
    python scraper.py --headed        # show the browser window (useful for debugging)
"""

import os
import re
import sys
import json
import time
import asyncio
import hashlib
import sqlite3
import logging
import argparse
from urllib.parse import urlparse

from playwright.async_api import async_playwright, Page, BrowserContext

import config

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.FileHandler("scraper.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

# ── Helpers ────────────────────────────────────────────────────────────────────

def page_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def build_playwright_cookies() -> list[dict]:
    """
    Convert config.SESSION_COOKIES (name:value dict) into Playwright cookie
    objects. Cookies are set on both .houzz.com and pro.houzz.com so they're
    sent on every request.
    """
    domains = [".houzz.com", "pro.houzz.com", ".pro.houzz.com"]
    cookies = []
    for name, value in config.SESSION_COOKIES.items():
        if not value:
            continue
        for domain in domains:
            cookies.append({
                "name":     name,
                "value":    value,
                "domain":   domain,
                "path":     "/",
                "secure":   True,
                "httpOnly": False,
                "sameSite": "Lax",
            })
    return cookies


# ── Database ───────────────────────────────────────────────────────────────────

def init_db(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS pages (
            id           TEXT PRIMARY KEY,
            url          TEXT UNIQUE,
            title        TEXT,
            html         TEXT,
            text_content TEXT,
            meta         TEXT,
            status       TEXT DEFAULT 'scraped',
            scraped_at   TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()


def save_to_db(conn: sqlite3.Connection, data: dict):
    conn.execute(
        """INSERT OR REPLACE INTO pages
           (id, url, title, html, text_content, meta, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))""",
        (
            data["id"],
            data["url"],
            data["title"],
            data["html"],
            data["text"],
            json.dumps(data["meta"]),
        ),
    )
    conn.commit()


# ── File storage ───────────────────────────────────────────────────────────────

def save_to_disk(data: dict):
    folder = os.path.join(config.OUTPUT_DIR, "pages", data["id"])
    os.makedirs(folder, exist_ok=True)

    with open(os.path.join(folder, "raw.html"), "w", encoding="utf-8") as f:
        f.write(data["html"])

    with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"url": data["url"], "title": data["title"], "meta": data["meta"]},
            f, indent=2
        )

    with open(os.path.join(folder, "text.txt"), "w", encoding="utf-8") as f:
        f.write(data["text"])

    if data.get("screenshot"):
        with open(os.path.join(folder, "screenshot.png"), "wb") as f:
            f.write(data["screenshot"])


# ── Page scraper ───────────────────────────────────────────────────────────────

async def scrape_page(context: BrowserContext, url: str) -> dict | None:
    page = await context.new_page()

    try:
        log.info(f"  -> Navigating: {url}")

        # Navigate and wait for the network to go quiet (SPA data loaded)
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)

        # Wait for React to mount something meaningful
        try:
            await page.wait_for_selector(
                "main, [class*='IvyApp'], [class*='page-content'], "
                "[class*='PageContainer'], #root > div > div",
                timeout=10000,
            )
        except Exception:
            log.debug(f"  Selector timeout — proceeding anyway for {url}")

        # Wait for network to settle (lazy-loaded data, API calls, etc.)
        try:
            await page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            log.debug(f"  Network idle timeout — proceeding for {url}")

        # Small human-like pause before capturing
        await asyncio.sleep(1.5)

        # ── Capture ───────────────────────────────────────────────────────────
        html  = await page.content()
        title = await page.title()

        screenshot = await page.screenshot(
            full_page=True,
            type="png",
        )

        # Extract meta tags via JS (more reliable than parsing HTML)
        meta = await page.evaluate("""() => {
            const metas = {};
            document.querySelectorAll('meta').forEach(m => {
                const key = m.getAttribute('name') || m.getAttribute('property');
                const val = m.getAttribute('content');
                if (key && val) metas[key] = val;
            });
            return metas;
        }""")

        # Extract visible text content (strips nav/script noise)
        text = await page.evaluate("""() => {
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                { acceptNode: n => {
                    const tag = n.parentElement?.tagName;
                    if (['SCRIPT','STYLE','NOSCRIPT'].includes(tag))
                        return NodeFilter.FILTER_REJECT;
                    return n.textContent.trim()
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                }}
            );
            const parts = [];
            let node;
            while (node = walker.nextNode()) parts.push(node.textContent.trim());
            return parts.join('\\n');
        }""")

        log.info(f"  [OK] Captured: \"{title}\" ({len(html):,} chars, "
                 f"{len(screenshot):,} bytes screenshot)")

        return {
            "id":         page_id(url),
            "url":        url,
            "title":      title,
            "html":       html,
            "text":       text,
            "meta":       meta,
            "screenshot": screenshot,
        }

    except Exception as exc:
        log.error(f"  ✗ Failed [{url}]: {exc}")
        return None

    finally:
        await page.close()


# ── Main runner ────────────────────────────────────────────────────────────────

async def run(urls: list[str], force: bool = False, headed: bool = False):
    os.makedirs(os.path.join(config.OUTPUT_DIR, "pages"), exist_ok=True)

    conn = sqlite3.connect(config.DB_PATH)
    init_db(conn)

    # Resume support
    if not force:
        done = {row[0] for row in conn.execute("SELECT url FROM pages")}
        urls = [u for u in urls if u not in done]
        log.info(f"{len(urls)} pages to scrape (skipping already-done).")
    else:
        log.info(f"{len(urls)} pages to scrape (force mode).")

    if not urls:
        log.info("Nothing to do. Run with --force to re-scrape.")
        conn.close()
        return

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=not headed,
            args=[
                "--disable-blink-features=AutomationControlled",  # hide automation flag
                "--no-sandbox",
            ],
        )

        # Single persistent context = one "user session" with all cookies loaded
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="America/New_York",
        )

        # Inject all session cookies
        await context.add_cookies(build_playwright_cookies())
        log.info(f"Injected {len(config.SESSION_COOKIES)} session cookies.")

        # Hide webdriver flag from JS
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        success = fail = 0

        for i, url in enumerate(urls, 1):
            log.info(f"[{i}/{len(urls)}] {url}")
            data = await scrape_page(context, url)

            if data:
                save_to_db(conn, data)
                save_to_disk(data)
                success += 1
            else:
                fail += 1

            # Human-like delay between pages — randomised so it's not mechanical
            if i < len(urls):
                delay = config.REQUEST_DELAY + (i % 3) * 0.7  # 1.5s – 3.6s
                log.debug(f"  Waiting {delay:.1f}s before next page...")
                await asyncio.sleep(delay)

        await context.close()
        await browser.close()

    conn.close()
    log.info(f"\nDone. {success} scraped, {fail} failed -> {config.OUTPUT_DIR}/")


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape Houzz Pro with Playwright.")
    parser.add_argument("--url",    help="Scrape a single URL")
    parser.add_argument("--force",  action="store_true", help="Re-scrape all pages")
    parser.add_argument("--headed", action="store_true",
                        help="Show the browser window (great for debugging)")
    args = parser.parse_args()

    urls = [args.url] if args.url else config.URL_LIST
    log.info(f"Starting — {len(urls)} URLs, headed={args.headed}")

    asyncio.run(run(urls, force=args.force, headed=args.headed))
