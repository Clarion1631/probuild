import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptObject, decryptObject } from "@/lib/crypto";
import { LEAD_INBOX_ADDRESS, GMAIL_REQUEST_TIMEOUT_MS } from "./constants";
import { safeErrorCategory } from "./error-category";

/**
 * The gtrsupport@ lead-inbox Gmail identity — a SECOND, independent OAuth
 * client from src/lib/gmail-client.ts's `oauth2Client` singleton, so it never
 * shares that mutable, module-level credential state with whatever Drive
 * account is separately connected.
 *
 * v1a is READ-ONLY (docs/plans/SPEED-TO-LEAD-V1A.md: "no gmail.send scope
 * remains") — no send scope, ever. `include_granted_scopes: false` on the
 * auth URL and an exact-match check on `tokens.scope` after exchange both
 * exist so a previously-granted `gmail.send` from THIS PROJECT's earlier
 * OAuth consent (e.g. #557's now-abandoned branch) can never be silently
 * inherited into a v1a credential.
 */
export const LEAD_INBOX_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

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
/** Double-submit cookie set alongside the state redirect and checked back at the callback. */
export const LEAD_INBOX_STATE_COOKIE = "stl_oauth_nonce";

function leadInboxStateSecret(): string {
    return process.env.NEXTAUTH_SECRET ?? "";
}

/**
 * Session-bound, single-use OAuth `state` (CSRF protection, RFC 6749 §10.12).
 * The HMAC payload is `{approverEmail, sid, nonce, issuedAt}` — `sid` is the
 * stable per-sign-in session claim `src/lib/auth.ts`'s `jwt` callback sets,
 * not just the approver's email, because for this single-approver system the
 * email is one fixed, unchanging value: binding to email alone would let a
 * state minted in one browser/tab be redeemed by ANY later request
 * authenticated as Justin (a different browser, a copied URL, ...). A
 * session with no `sid` claim (one issued before this feature shipped) is
 * refused outright rather than treated as a wildcard match — sign out and
 * back in once to pick up the claim.
 *
 * `verifyAndConsumeLeadInboxState` below still ALSO requires the HttpOnly
 * double-submit cookie AND spends the nonce exactly once, so `sid` binding
 * and the cookie are two independent layers, not a replacement for either.
 */
export function mintLeadInboxState(sessionEmail: string, sid: string): string {
    const nonce = randomUUID();
    const issuedAt = Date.now();
    const payload = `${sessionEmail}:${sid}:${nonce}:${issuedAt}`;
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
        return parts.length === 5 ? parts[2] : null;
    } catch {
        return null;
    }
}

/**
 * Verifies the signature, expiry, originating session (email AND `sid`)
 * AND originating BROWSER (the double-submit cookie), then CONSUMES the
 * state so the same authorization redirect can never be replayed: the
 * unique key insert below throws if this exact nonce was already spent.
 *
 * `sid` with no value (empty string, or a session issued before this
 * feature shipped) never matches — there is no wildcard.
 */
export async function verifyAndConsumeLeadInboxState(state: string, sessionEmail: string, sid: string | null | undefined, cookieNonce: string | null): Promise<boolean> {
    if (!isLeadInboxState(state) || !leadInboxStateSecret() || !sid) return false;
    let decoded: string;
    try {
        decoded = Buffer.from(state.slice(LEAD_INBOX_STATE_PREFIX.length), "base64url").toString("utf8");
    } catch {
        return false;
    }
    const parts = decoded.split(":");
    if (parts.length !== 5) return false;
    const [email, stateSid, nonce, issuedAtRaw, sig] = parts;
    if (!cookieNonce || nonce !== cookieNonce) return false;
    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > LEAD_INBOX_STATE_TTL_MS) return false;
    if (email !== sessionEmail || stateSid !== sid) return false;
    const expected = createHmac("sha256", leadInboxStateSecret()).update(`${email}:${stateSid}:${nonce}:${issuedAtRaw}`).digest("hex");
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

export function leadInboxAuthUrl(sessionEmail: string, sid: string): string {
    return newLeadInboxOAuthClient().generateAuthUrl({
        access_type: "offline",
        scope: LEAD_INBOX_SCOPES,
        prompt: "consent",
        // Never silently widen the granted scope with whatever this Google
        // account has previously consented to for ProBuild under some OTHER
        // flow (e.g. the Drive connection, or #557's abandoned send scope).
        include_granted_scopes: false,
        state: mintLeadInboxState(sessionEmail, sid),
    });
}

export interface LeadInboxAuth {
    ok: boolean;
    client?: ReturnType<typeof newLeadInboxOAuthClient>;
    /**
     * Set only when a credential WAS stored but could not be used (decrypt
     * failure, empty token, or a failed/timed-out refresh — including
     * `invalid_grant`). Never set when nothing has been connected yet, so a
     * caller can tell "not yet activated" (quiet) apart from "was working,
     * now broken" (must feed failure/alert accounting — see gmail-poll.ts
     * round-6 finding 1: a broken credential must never fail silently just
     * because no scan has ever completed).
     */
    error?: unknown;
}

/** Races `promise` against a timeout — bounds the OAuth2 client's own token-refresh call, which is a separate HTTP round trip the per-request `{timeout}` option on a later Gmail API call does not cover. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

/**
 * Loads the stored gtrsupport@ refresh token (encrypted at rest via
 * `encryptObject`/`decryptObject`, `src/lib/crypto.ts`) and returns a
 * ready-to-use OAuth client, or `{ ok: false }` if none is connected yet.
 * Takes `db` explicitly rather than reaching for the global `prisma`
 * singleton — a caller running against a disposable test database must
 * never have its poll silently fall through to the REAL configured mailbox
 * credential just because this function forgot to accept the database it
 * was given.
 */
export async function ensureLeadInboxAuth(db: PrismaClient = prisma): Promise<LeadInboxAuth> {
    try {
        const settings = await db.companySettings.findUnique({
            where: { id: "singleton" },
            select: { leadInboxRefreshTokenEnc: true },
        });
        const encrypted = settings?.leadInboxRefreshTokenEnc;
        if (!encrypted) return { ok: false }; // never connected yet — not a failure, nothing to alert on
        let refreshToken: string;
        try {
            const decrypted = decryptObject(encrypted) as { refreshToken?: string } | null;
            refreshToken = decrypted?.refreshToken ?? "";
        } catch (error) {
            console.error("[speed-to-lead] could not decrypt the stored lead-inbox credential");
            return { ok: false, error };
        }
        if (!refreshToken) return { ok: false, error: new Error("stored lead-inbox credential decrypted with no refresh token") };
        const client = newLeadInboxOAuthClient();
        client.setCredentials({ refresh_token: refreshToken });
        // Bounded refresh check — a hung token endpoint must not consume the
        // whole cron invocation's time budget with no result.
        await withTimeout(client.getAccessToken(), GMAIL_REQUEST_TIMEOUT_MS, "lead-inbox token refresh");
        return { ok: true, client };
    } catch (error) {
        console.error("[speed-to-lead] could not load or refresh the stored lead-inbox credential", safeErrorCategory(error));
        return { ok: false, error };
    }
}

/** Encrypts a refresh token for storage — the shape `ensureLeadInboxAuth` decrypts back. */
export function encryptLeadInboxRefreshToken(refreshToken: string): string {
    return encryptObject({ refreshToken });
}

export function gmailClientFor(auth: ReturnType<typeof newLeadInboxOAuthClient>) {
    return google.gmail({ version: "v1", auth });
}

export { LEAD_INBOX_ADDRESS };
