"""
cloner.py — Feed each scraped Houzz Pro page into Gemini Flash to generate
            a cloned, self-contained HTML file.

Usage:
    python cloner.py                  # clone all scraped pages
    python cloner.py --page <id>      # clone a single page by its hash ID
    python cloner.py --url <url>      # clone a single page by URL
    python cloner.py --force          # re-clone already-cloned pages

Output:
    output/cloned/<page-id>/index.html
"""

import os
import json
import hashlib
import logging
import argparse
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed

from google import genai
from google.genai import types

import config

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.FileHandler("cloner.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

# ── Prompt ─────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an expert frontend developer specializing in pixel-perfect
HTML/CSS recreation. When given a screenshot and source HTML of a webpage, you produce
a self-contained, clean HTML file that visually matches the original as closely as
possible using Tailwind CSS (via CDN).

Rules:
- Output ONLY the complete HTML document. No explanations, no markdown fences.
- Use Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
- For images, use placeholder divs styled with matching background colors and
  dimensions unless the image src is an absolute public URL (then use it directly).
- Preserve ALL text content exactly as it appears.
- Match colors, spacing, font sizes, and layout precisely from the screenshot.
- Make it responsive where the original appears responsive.
- Use semantic HTML5 elements (nav, main, section, aside, footer, etc.).
- Inline any critical CSS that Tailwind can't express via a <style> tag."""

# ── Helpers ────────────────────────────────────────────────────────────────────

def page_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def load_page_data(pid: str) -> dict | None:
    """Load scraped assets for a page from disk."""
    folder = os.path.join(config.OUTPUT_DIR, "pages", pid)
    if not os.path.isdir(folder):
        log.warning(f"No scraped data for page ID: {pid}")
        return None

    data = {"id": pid, "folder": folder}

    meta_path = os.path.join(folder, "meta.json")
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            data.update(json.load(f))

    html_path = os.path.join(folder, "raw.html")
    if os.path.exists(html_path):
        with open(html_path, encoding="utf-8") as f:
            data["html"] = f.read()

    screenshot_path = os.path.join(folder, "screenshot.png")
    data["has_screenshot"] = os.path.exists(screenshot_path)
    data["screenshot_path"] = screenshot_path

    return data


def strip_fences(text: str) -> str:
    """Remove markdown code fences if the model adds them."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        end   = -1 if lines[-1].strip() == "```" else len(lines)
        text  = "\n".join(lines[1:end])
    return text


# ── AI Cloning ─────────────────────────────────────────────────────────────────

def build_prompt(data: dict) -> str:
    html_snippet = data.get("html", "")[:config.MAX_HTML_CHARS]
    meta         = data.get("meta", {})
    return (
        f"Clone this webpage into a complete, self-contained HTML file.\n\n"
        f"URL: {data.get('url', '')}\n"
        f"Title: {data.get('title', '')}\n"
        f"Meta description: {meta.get('description', '')}\n\n"
        f"--- SOURCE HTML (may be truncated to {config.MAX_HTML_CHARS} chars) ---\n"
        f"{html_snippet}"
    )


def clone_page(model: genai.GenerativeModel, pid: str, force: bool = False) -> bool:
    data = load_page_data(pid)
    if not data:
        return False

    out_dir      = os.path.join(config.OUTPUT_DIR, "cloned", pid)
    output_file  = os.path.join(out_dir, "index.html")

    if not force and os.path.exists(output_file):
        log.info(f"Already cloned: {data.get('url')} — skipping.")
        return True

    url = data.get("url", pid)
    log.info(f"Cloning: {url}")

    # Build content parts — image first, then text (Gemini prefers this order)
    parts = []

    if data.get("has_screenshot"):
        try:
            img = Image.open(data["screenshot_path"])
            parts.append(img)
            log.debug(f"  Screenshot loaded ({img.size[0]}×{img.size[1]}px)")
        except Exception as exc:
            log.warning(f"  Could not load screenshot for {pid}: {exc}")

    parts.append(build_prompt(data))

    try:
        response = client.models.generate_content(
            model=config.CLONE_MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                temperature=0.2,
                max_output_tokens=8192,
            ),
        )
        cloned_html = strip_fences(response.text)
    except Exception as exc:
        log.error(f"Gemini API error for {url}: {exc}")
        return False

    if not cloned_html.strip().startswith("<!") and "<html" not in cloned_html[:200]:
        log.warning(f"  Response doesn't look like HTML for {url} — saving anyway.")

    os.makedirs(out_dir, exist_ok=True)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(cloned_html)

    with open(os.path.join(out_dir, "source.json"), "w") as f:
        json.dump({"url": url, "title": data.get("title")}, f, indent=2)

    log.info(f"  ✓ Saved → {output_file}")
    return True


# ── Entry point ────────────────────────────────────────────────────────────────

def get_all_page_ids() -> list[str]:
    pages_dir = os.path.join(config.OUTPUT_DIR, "pages")
    if not os.path.isdir(pages_dir):
        return []
    return [
        d for d in os.listdir(pages_dir)
        if os.path.isdir(os.path.join(pages_dir, d))
    ]


def main():
    parser = argparse.ArgumentParser(description="Clone scraped Houzz Pro pages with Gemini Flash.")
    group  = parser.add_mutually_exclusive_group()
    group.add_argument("--page", help="Clone a single page by hash ID")
    group.add_argument("--url",  help="Clone a single page by URL")
    parser.add_argument("--force", action="store_true",
                        help="Re-clone pages that were already cloned")
    args = parser.parse_args()

    if not config.GEMINI_API_KEY:
        raise SystemExit("ERROR: Set GEMINI_API_KEY in config.py first.")

    client = genai.Client(api_key=config.GEMINI_API_KEY)

    if args.page:
        ids = [args.page]
    elif args.url:
        ids = [page_id(args.url.rstrip("/"))]
    else:
        ids = get_all_page_ids()
        log.info(f"Found {len(ids)} scraped pages to clone.")

    if not ids:
        log.info("No pages found. Run scraper.py first.")
        return

    success = fail = 0

    with ThreadPoolExecutor(max_workers=config.CLONE_CONCURRENCY) as pool:
        futures = {
            pool.submit(clone_page, client, pid, args.force): pid
            for pid in ids
        }
        for future in as_completed(futures):
            if future.result():
                success += 1
            else:
                fail += 1

    log.info(f"\nDone. {success} cloned, {fail} failed → {config.OUTPUT_DIR}/cloned/")


if __name__ == "__main__":
    main()
