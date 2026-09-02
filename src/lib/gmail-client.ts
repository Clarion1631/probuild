import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const TOKEN_PATH = path.join(process.cwd(), '.gmail-token.json');

// Drive/Gmail integration uses a DEDICATED OAuth client (own redirect URIs +
// scopes) so it stays independent of the web-login client (GOOGLE_CLIENT_ID,
// owned in a separate Cloud project). Falls back to the login client if the
// dedicated vars aren't set.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

// Support both local dev and production on Vercel
const REDIRECT_URI = process.env.NODE_ENV === 'production'
    ? `https://probuild.goldentouchremodeling.com/api/gmail/callback` 
    : 'http://localhost:3000/api/gmail/callback';

export const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

export function getAuthUrl() {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send',
            // Drive: project folder provisioning + receipts ingestion
            // (re-run the Google connect flow once after deploy to grant this)
            'https://www.googleapis.com/auth/drive'
        ],
        prompt: 'consent' // Forces refresh token generation
    });
}

export function loadToken() {
    try {
        if (fs.existsSync(TOKEN_PATH)) {
            const token = fs.readFileSync(TOKEN_PATH, 'utf-8');
            oauth2Client.setCredentials(JSON.parse(token));
            return true;
        }
        
        // Also check if token was passed via ENV for Vercel production
        if (process.env.GMAIL_REFRESH_TOKEN) {
            oauth2Client.setCredentials({
                refresh_token: process.env.GMAIL_REFRESH_TOKEN
            });
            return true;
        }
    } catch (e) {
        console.error("Error loading gmail token:", e);
    }
    return false;
}

export function saveToken(token: any) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    oauth2Client.setCredentials(token);
}

// Ensure token is loaded when file is imported so backend functions have Auth Context
loadToken();

export const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

/**
 * Where the Drive/Gmail credential actually comes from, in each environment.
 *
 * `loadToken()` is synchronous (it runs at import time) and can therefore only
 * see the local token FILE or `GMAIL_REFRESH_TOKEN`. On Vercel neither exists
 * by default: the filesystem is ephemeral and the env var has to be set by
 * hand. But the admin "connect Google" flow
 * (`/api/gmail/callback`) persists its refresh token to
 * `CompanySettings.googleDriveRefreshToken` — so the connection a human already
 * made was invisible to every Drive call, and connecting again changed nothing.
 * That gap is why a signed-memo probe could never succeed in production no
 * matter how many times somebody clicked connect.
 *
 * This is the async form that closes it: file / env first (cheap, no database),
 * then the stored company credential.
 */
export type DriveAuthSource = "token-file-or-env" | "company-settings" | "none";

export async function ensureDriveAuth(): Promise<{ ok: boolean; source: DriveAuthSource }> {
    if (loadToken()) return { ok: true, source: "token-file-or-env" };
    try {
        const { prisma } = await import("./prisma");
        const settings = await prisma.companySettings.findUnique({
            where: { id: "singleton" },
            select: { googleDriveRefreshToken: true },
        });
        const refreshToken = settings?.googleDriveRefreshToken;
        if (!refreshToken) return { ok: false, source: "none" };
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        return { ok: true, source: "company-settings" };
    } catch (error) {
        // A database we cannot read is not "no credential" — but for the
        // caller's purposes it is the same refusal: we cannot prove we can
        // reach Drive, so nothing may be recorded as verified.
        console.error("[gmail-client] could not read the stored Drive credential",
            error instanceof Error ? error.message : "UnknownError");
        return { ok: false, source: "none" };
    }
}
