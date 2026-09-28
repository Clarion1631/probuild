/**
 * Front Desk v1 acceptance test 39: a static no-send proof. Grepping the
 * shipped source is the only way to be sure a customer-facing send path was
 * never reintroduced — mirrors tests/speed-to-lead-no-outbound.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_PATHS = [
    "src/lib/front-desk",
    "src/app/api/front-desk",
    "src/lib/front-desk-actions.ts",
];

/**
 * Matched against real usage shapes (an object key, a property access, a
 * path segment) — never a bare word match, so a comment explaining that a
 * field is deliberately NEVER sent (which necessarily has to name that
 * field) does not trip its own guard.
 */
const FORBIDDEN_PATTERNS = [
    /@\/lib\/sms/,
    /messages\.create/,
    /calls\.create/,
    /\bnew Resend\(/,
    /require\(["']resend["']\)/,
    /RESEND_API_KEY/,
    /\bgmail\b/i,
    /text_reminder_number\s*[:=]/,
    /event_guests\s*[:=]/,
    /\/scheduled_events\/.*\/cancellation/,
];

/** The only outbound hosts this surface may reach: Calendly, and the existing v1a alert senders (which live outside the scanned paths, so this is belt-and-braces). */
const ALLOWED_HOST_PATTERN = /api\.calendly\.com|ntfy\.sh|SPEED_TO_LEAD_NTFY_BASE_URL|SPEED_TO_LEAD_CHAT_WEBHOOK_URL/;
const HOST_LITERAL_PATTERN = /https?:\/\/([a-z0-9.-]+)/gi;

function collectFiles(entryPath: string): string[] {
    const full = path.join(root, entryPath);
    const st = statSync(full);
    if (st.isFile()) return [full];
    const out: string[] = [];
    for (const entry of readdirSync(full, { withFileTypes: true })) {
        const childRel = path.join(entryPath, entry.name);
        if (entry.isDirectory()) out.push(...collectFiles(childRel));
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path.join(root, childRel));
    }
    return out;
}

test("no outbound-send code exists anywhere in the shipped Front Desk v1 surface", () => {
    const offenders: string[] = [];
    for (const scanned of SCANNED_PATHS) {
        for (const file of collectFiles(scanned)) {
            const text = readFileSync(file, "utf8");
            for (const pattern of FORBIDDEN_PATTERNS) {
                if (pattern.test(text)) offenders.push(`${path.relative(root, file)} matches ${pattern}`);
            }
        }
    }
    assert.deepEqual(offenders, []);
});

test("every literal https:// host in the Front Desk surface is an allowed one", () => {
    const offenders: string[] = [];
    for (const scanned of SCANNED_PATHS) {
        for (const file of collectFiles(scanned)) {
            const text = readFileSync(file, "utf8");
            for (const match of text.matchAll(HOST_LITERAL_PATTERN)) {
                if (!ALLOWED_HOST_PATTERN.test(match[0])) offenders.push(`${path.relative(root, file)}: ${match[0]}`);
            }
        }
    }
    assert.deepEqual(offenders, []);
});

test("the Calendly invitee POST body object literal has no text_reminder_number, event_guests or questions_and_answers key", () => {
    const text = readFileSync(path.join(root, "src/lib/front-desk/calendly.ts"), "utf8");
    const bodyLiteral = text.slice(text.indexOf("const body = {"), text.indexOf("let res: Response;"));
    assert.doesNotMatch(bodyLiteral, /text_reminder_number/);
    assert.doesNotMatch(bodyLiteral, /event_guests/);
    assert.doesNotMatch(bodyLiteral, /questions_and_answers/);
});
