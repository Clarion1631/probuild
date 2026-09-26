import { google } from "googleapis";
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

export function leadInboxAuthUrl(): string {
    return newLeadInboxOAuthClient().generateAuthUrl({
        access_type: "offline",
        scope: LEAD_INBOX_SCOPES,
        prompt: "consent",
        state: "purpose=lead-inbox",
    });
}

export interface LeadInboxAuth {
    ok: boolean;
    client?: ReturnType<typeof newLeadInboxOAuthClient>;
}

/** Loads the stored gtrsupport@ refresh token and returns a ready-to-use OAuth client, or `{ ok: false }` if none is connected yet (R0). */
export async function ensureLeadInboxAuth(): Promise<LeadInboxAuth> {
    try {
        const settings = await prisma.companySettings.findUnique({
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
