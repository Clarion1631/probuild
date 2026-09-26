/**
 * Acceptance test 1 (docs/plans/SPEED-TO-LEAD-V1A.md): v1a sends NOTHING to
 * customers. This is a STATIC proof, not a behavioral one — grepping the
 * actual shipped source is the only way to be sure a send path was never
 * reintroduced, since a behavioral test can only prove the paths it thought
 * to call.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_PATHS = [
    "src/lib/speed-to-lead",
    "src/lib/speed-to-lead-actions.ts",
    "src/app/api/speed-to-lead",
    "src/app/api/cron/speed-to-lead",
    "src/app/api/gmail/callback",
];

const FORBIDDEN_PATTERNS = [
    /messages\.send/,
    /drafts\./,
    // The gmail.send OAUTH SCOPE STRING itself, never a bare "gmail.send"
    // substring — several comments in gmail-inbox-client.ts and the
    // callback route legitimately explain that this scope is NOT granted,
    // which would otherwise false-positive. LEAD_INBOX_SCOPES's own
    // deep-equal test below is the authoritative check for the actual
    // granted scope.
    /auth\/gmail\.send/,
    /buildRawMessage/,
    /Outreach/,
    /\bdispatch\(/,
    // The Resend EMAIL-SENDING SDK/API — never the DKIM selector value
    // `header.s=resend` that a trusted website message legitimately carries
    // (the site's own contact-form emails are sent via Resend; that string
    // is inbound authentication DATA, not an outbound call).
    /from ["']resend["']/,
    /require\(["']resend["']\)/,
    /\bnew Resend\(/,
    /RESEND_API_KEY/,
    /\btwilio\b/i,
];

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

test("no outbound-send code exists anywhere in the shipped Speed-to-Lead v1a surface", () => {
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

test("LEAD_INBOX_SCOPES is exactly gmail.readonly — no send scope, no legacy scope inherited", async () => {
    const { LEAD_INBOX_SCOPES } = await import("../src/lib/speed-to-lead/gmail-inbox-client");
    assert.deepEqual(LEAD_INBOX_SCOPES, ["https://www.googleapis.com/auth/gmail.readonly"]);
});

test("the Prisma schema has no Outreach* or ReadinessRecord model", () => {
    const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
    assert.doesNotMatch(schema, /model\s+Outreach\w*/);
    assert.doesNotMatch(schema, /model\s+ReadinessRecord/);
});
