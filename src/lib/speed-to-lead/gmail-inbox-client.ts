import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The gtrsupport@ lead-inbox Gmail identity — a SECOND, independent OAuth
 * client from src/lib/gmail-client.ts's `oauth2Client` singleton (spec
 * "Verified code facts": "The Gmail client is one shared module-level OAuth
 * client, so v1 adds a separate one").
 *
 * `gmail-client.ts`'s client is a MODULE-LEVEL singleton whose credentials
 * are mutated in place via `setCredentials()` — safe there because the app
 * only ever needs one Drive/Gmail-send identity at a time. This feature adds
 * a SECOND identity (gtrsupport@) that must never share that mutable state
 * with the first (whatever Drive account is connected), so every call here
 * builds its OWN OAuth2Client instance rather than reaching for a singleton.
 *
 * Least-privilege scopes: read + send only (no drive, no modify/labels — the
 * poll advances its cursor in CompanySettings, not via Gmail labels).
 */
export const LEAD_INBOX_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
];

function clientCredentials() {
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    return { clientId, clientSecret };
}

function redirectUri(): string {
    return process.env.NODE_ENV === "production"
        ? "https://probuild.goldentouchremodeling.com/api/gmail/callback"
        : "http://localhost:3000/api/gmail/callback";
}

export function newLeadInboxOAuthClient() {
    const { clientId, clientSecret } = clientCredentials();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri());
}

const LEAD_INBOX_STATE_PREFIX = "leadinbox.";
const LEAD_INBOX_STATE_TTL_MS = 10 * 60 * 1000;
/** Double-submit cookie set alongside the state redirect and checked back at the callback — see verifyAndConsumeLeadInboxState. */
export const LEAD_INBOX_STATE_COOKIE = "stl_oauth_nonce";

function leadInboxStateSecret(): string {
    return process.env.NEXTAUTH_SECRET ?? "";
}

/**
 * Session-bound, single-use OAuth `state` (CSRF protection, RFC 6749 §10.12).
 * A constant state lets anyone who can trigger a GET here (no token, no
 * session tie) complete the flow for a code an attacker obtained — signing it
 * to the initiating admin's session and a fresh nonce, with a short expiry,
 * closes that. `verifyAndConsumeLeadInboxState` below spends the nonce
 * exactly once.
 */
export function mintLeadInboxState(sessionEmail: string): string {
    const nonce = randomUUID();
    const issuedAt = Date.now();
    const payload = `${sessionEmail}:${nonce}:${issuedAt}`;
    const sig = createHmac("sha256", leadInboxStateSecret()).update(payload).digest("hex");
    return `${LEAD_INBOX_STATE_PREFIX}${Buffer.from(`${payload}:${sig}`).toString("base64url")}`;
}

/** True for any state value minted by this flow — used to recognize the callback before it is verified. */
export function isLeadInboxState(state: string | null): boolean {
    return !!state && state.startsWith(LEAD_INBOX_STATE_PREFIX);
}

/** The nonce embedded in a minted state — used by the route to set the double-submit cookie right after generating the redirect URL, without changing mintLeadInboxState's own return shape. */
export function leadInboxStateNonce(state: string): string | null {
    if (!isLeadInboxState(state)) return null;
    try {
        const decoded = Buffer.from(state.slice(LEAD_INBOX_STATE_PREFIX.length), "base64url").toString("utf8");
        const parts = decoded.split(":");
        return parts.length === 4 ? parts[1] : null;
    } catch {
        return null;
    }
}

/**
 * Verifies the signature, expiry, originating session AND originating
 * BROWSER, then CONSUMES the state so the same authorization redirect can
 * never be replayed: the unique key insert below throws if this exact nonce
 * was already spent.
 *
 * `cookieNonce` binds the state to the browser that started this flow, not
 * just the approver's EMAIL — for this single-approver system the email is
 * one fixed, unchanging value, so email-binding alone means a state minted
 * for one browser/tab is redeemable by ANY later request that happens to be
 * authenticated as Justin (a different browser, a copied URL, ...). The
 * nonce is also written to an HttpOnly cookie when the flow starts
 * (route.ts's `!code` branch); only the browser holding that cookie can ever
 * complete it — the standard double-submit-cookie CSRF pattern.
 */
export async function verifyAndConsumeLeadInboxState(state: string, sessionEmail: string, cookieNonce: string | null): Promise<boolean> {
    if (!isLeadInboxState(state) || !leadInboxStateSecret()) return false;
    let decoded: string;
    try {
        decoded = Buffer.from(state.slice(LEAD_INBOX_STATE_PREFIX.length), "base64url").toString("utf8");
    } catch {
        return false;
    }
    const parts = decoded.split(":");
    if (parts.length !== 4) return false;
    const [email, nonce, issuedAtRaw, sig] = parts;
    if (!cookieNonce || nonce !== cookieNonce) return false;
    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > LEAD_INBOX_STATE_TTL_MS) return false;
    if (email !== sessionEmail) return false;
    const expected = createHmac("sha256", leadInboxStateSecret()).update(`${email}:${nonce}:${issuedAtRaw}`).digest("hex");
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
        // A fresh, never-before-seen key: the unique constraint on
        // AutomationSetting.key makes this create() the single-use gate.
        await prisma.automationSetting.create({ data: { key: `leadInboxOAuthState:${nonce}`, value: "used" } });
    } catch {
        return false; // already consumed — replay
    }
    return true;
}

export function leadInboxAuthUrl(sessionEmail: string): string {
    return newLeadInboxOAuthClient().generateAuthUrl({
        access_type: "offline",
        scope: LEAD_INBOX_SCOPES,
        prompt: "consent",
        state: mintLeadInboxState(sessionEmail),
    });
}

export interface LeadInboxAuth {
    ok: boolean;
    client?: ReturnType<typeof newLeadInboxOAuthClient>;
}

/**
 * Loads the stored gtrsupport@ refresh token and returns a ready-to-use OAuth
 * client, or `{ ok: false }` if none is connected yet (R0). Takes `db`
 * explicitly rather than reaching for the global `prisma` singleton — a
 * caller running against a disposable test database (dispatch.ts's DB tests)
 * must never have its Gmail send/reconcile path silently fall through to the
 * REAL configured mailbox credential just because this one function forgot
 * to accept the database it was given.
 */
export async function ensureLeadInboxAuth(db: PrismaClient = prisma): Promise<LeadInboxAuth> {
    try {
        const settings = await db.companySettings.findUnique({
            where: { id: "singleton" },
            select: { leadInboxRefreshToken: true },
        });
        const refreshToken = settings?.leadInboxRefreshToken;
        if (!refreshToken) return { ok: false };
        const client = newLeadInboxOAuthClient();
        client.setCredentials({ refresh_token: refreshToken });
        return { ok: true, client };
    } catch (error) {
        console.error("[speed-to-lead] could not read the stored lead-inbox credential", error instanceof Error ? error.message : "UnknownError");
        return { ok: false };
    }
}

export function gmailClientFor(auth: ReturnType<typeof newLeadInboxOAuthClient>) {
    return google.gmail({ version: "v1", auth });
}
