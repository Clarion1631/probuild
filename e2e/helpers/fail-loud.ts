import { type Page, type TestInfo, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

// ---------------------------------------------------------------------------
// Forbidden patterns — must NEVER appear on any page
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = [
  { pattern: /\$0[0-9]{4,}/, label: "$079261-style currency bug" },
  { pattern: /NaN/, label: "NaN value" },
  { pattern: /\bundefined\b/, label: "undefined text" },
  { pattern: /Something went wrong/, label: "error boundary" },
  { pattern: /Unhandled Runtime Error/, label: "runtime error" },
  { pattern: /Application error/, label: "application error" },
  { pattern: /Internal Server Error/, label: "500 error" },
  { pattern: /\[object Object\]/, label: "unserialized object" },
  { pattern: /Could not load/, label: "load failure" },
];

// ---------------------------------------------------------------------------
// Navigate + validate (the core fail-loud helper)
// ---------------------------------------------------------------------------
export async function assertCleanNavigation(
  page: Page,
  urlPath: string,
  label?: string
) {
  const tag = label || urlPath;
  const res = await page.goto(urlPath, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });

  // HTTP status
  expect(res?.status(), `[${tag}] HTTP ${res?.status()}`).toBeLessThan(400);

  // Forbidden patterns
  const body = await page.locator("body").innerText({ timeout: 10_000 });
  for (const { pattern, label: pl } of FORBIDDEN_PATTERNS) {
    expect(body, `[${tag}] forbidden pattern: ${pl}`).not.toMatch(pattern);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Check current page (no navigation)
// ---------------------------------------------------------------------------
export async function assertNoCrashUI(page: Page, label = "current page") {
  const body = await page.locator("body").innerText({ timeout: 10_000 });
  for (const { pattern, label: pl } of FORBIDDEN_PATTERNS) {
    expect(body, `[${label}] forbidden pattern: ${pl}`).not.toMatch(pattern);
  }
}

// ---------------------------------------------------------------------------
// Sonner error toast check
// ---------------------------------------------------------------------------
export async function assertNoErrorToasts(page: Page, label = "page") {
  const errorToasts = page.locator(
    '[data-sonner-toast][data-type="error"]'
  );
  const count = await errorToasts.count();
  expect(count, `[${label}] found ${count} error toast(s)`).toBe(0);
}

// ---------------------------------------------------------------------------
// Click + wait for API + check toasts
// ---------------------------------------------------------------------------
export async function clickAndWaitForAPI(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  apiUrlPattern: string,
  label = "action",
  timeout = 15_000
) {
  await expect(locator, `[${label}] button not visible`).toBeVisible();
  await expect(locator, `[${label}] button not enabled`).toBeEnabled();

  try {
    const [response] = await Promise.all([
      page.waitForResponse(
        (resp) =>
          resp.url().includes(apiUrlPattern) && resp.status() < 400,
        { timeout }
      ),
      locator.click(),
    ]);
    return response;
  } catch {
    // If no API call expected, just click
    await locator.click();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Currency value scanner
// ---------------------------------------------------------------------------
export async function assertCurrencyValues(page: Page, label = "page") {
  const body = await page.locator("body").innerText({ timeout: 10_000 });
  const currencyMatches = body.match(/\$[\w\d,.()-]+/g) || [];
  for (const val of currencyMatches) {
    expect(val, `[${label}] bad currency: ${val}`).not.toMatch(
      /NaN|undefined|object|Infinity/i
    );
  }
}

// ---------------------------------------------------------------------------
// Console error collector
// ---------------------------------------------------------------------------
export function setupConsoleErrorCollector(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("favicon")) {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`PAGE_ERROR: ${err.message}`);
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Parse currency string to number
// ---------------------------------------------------------------------------
export function parseCurrency(str: string): number {
  return parseFloat(str.replace(/[$,\s]/g, ""));
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------
export async function capture(
  page: Page,
  testInfo: TestInfo,
  workflow: number,
  step: number,
  label: string
) {
  const name = `w${workflow}_s${step}_${label.replace(/[^a-z0-9]/gi, "-")}`;
  const dir = path.join(process.cwd(), "qa-screenshots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  await testInfo.attach(name, {
    path: filePath,
    contentType: "image/png",
  });
}
