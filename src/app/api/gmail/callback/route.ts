import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { oauth2Client, saveToken } from "@/lib/gmail-client";
import {
    newLeadInboxOAuthClient, leadInboxAuthUrl, isLeadInboxState, verifyAndConsumeLeadInboxState,
    leadInboxStateNonce, LEAD_INBOX_STATE_COOKIE, LEAD_INBOX_SCOPES, encryptLeadInboxRefreshToken,
} from "@/lib/speed-to-lead/gmail-inbox-client";
import { isApprover, LEAD_INBOX_ADDRESS } from "@/lib/speed-to-lead/constants";

// Google OAuth capture for the company integrations (Gmail + Drive scopes).
// Visit /api/gmail/callback signed in as an ADMIN: no code -> redirect to the
// Google consent screen; with code -> exchange and persist the refresh token
// to CompanySettings (survives deploys; lead Drive folders use it).

async function callerIsAdmin(): Promise<boolean> {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return false;
    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { role: true },
    });
    return user?.role === "ADMIN" || user?.role === "MANAGER";
}

/** The only error.name values this route ever logs — a genuinely finite allowlist, not "whatever the thrower named their error". */
const OAUTH_ERROR_CATEGORIES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "GaxiosError", "AggregateError"]);

/** Never logs the raw OAuth error (it can carry the authorization code or request/response bodies) — only an allowlisted category and status code. `error.name` is copied through ONLY when it is one of the finite categories above; anything else falls back to "UnknownError". */
function safeOAuthErrorCategory(error: unknown): { category: string; status: number | null } {
    const status = (error as { code?: number })?.code ?? (error as { response?: { status?: number } })?.response?.status ?? null;
    const name = error instanceof Error ? error.name : null;
    const category = name && OAUTH_ERROR_CATEGORIES.has(name) ? name : "UnknownError";
    return { category, status: typeof status === "number" ? status : null };
}

export async function GET(req: NextRequest) {
    const code = req.nextUrl.searchParams.get("code");
    // Speed-to-Lead (PB-leads-001): ?purpose=lead-inbox connects gtrsupport@
    // as a SECOND, independent, READ-ONLY Gmail identity — see
    // src/lib/speed-to-lead/gmail-inbox-client.ts for why it must not share
    // this route's default (Drive) client's mutable credentials.
    const state = req.nextUrl.searchParams.get("state");
    const isLeadInbox = req.nextUrl.searchParams.get("purpose") === "lead-inbox" || isLeadInboxState(state);

    if (isLeadInbox) {
        // Justin-only (v1a's single approver) — this connects the mailbox the
        // whole feature reads through.
        const session = await getServerSession(authOptions);
        const sessionEmail = session?.user?.email ?? null;
        if (!isApprover(sessionEmail)) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        // `sid` is the stable per-sign-in session claim src/lib/auth.ts's
        // `jwt` callback sets — read directly off the JWT (getServerSession's
        // `session` object never exposes it) since this feature's OAuth state
        // must bind to the actual signed-in session, not just Justin's fixed,
        // always-the-same email address.
        const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
        const sid = typeof token?.sid === "string" ? token.sid : null;
        if (!sid) {
            return NextResponse.json({ error: "This session has no session id claim — sign out and back in once, then retry." }, { status: 401 });
        }

        if (!code) {
            const authUrl = leadInboxAuthUrl(sessionEmail as string, sid);
            const nonce = leadInboxStateNonce(new URL(authUrl).searchParams.get("state") ?? "");
            const redirect = NextResponse.redirect(authUrl);
            if (nonce) {
                redirect.cookies.set(LEAD_INBOX_STATE_COOKIE, nonce, {
                    httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/gmail/callback",
                });
            }
            return redirect;
        }
        const cookieNonce = req.cookies.get(LEAD_INBOX_STATE_COOKIE)?.value ?? null;
        if (!state || !(await verifyAndConsumeLeadInboxState(state, sessionEmail as string, sid, cookieNonce))) {
            return NextResponse.json({ error: "Invalid, expired, or already-used state" }, { status: 400 });
        }
        try {
            const leadInboxClient = newLeadInboxOAuthClient();
            const { tokens } = await leadInboxClient.getToken(code);
            if (!tokens.refresh_token) {
                return new NextResponse(
                    `<html><body style="font-family:system-ui;padding:40px;max-width:520px"><h2>Lead inbox not connected</h2><p>Google replied without a refresh token (already connected once?). Revoke ProBuild at myaccount.google.com/permissions and connect again.</p></body></html>`,
                    { headers: { "Content-Type": "text/html" } },
                );
            }
            // Never a wider scope than requested — including a stale
            // gmail.send grant inherited from an EARLIER OAuth consent for
            // this project (e.g. #557's abandoned send-capable connection).
            const grantedScopes = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
            const exactlyReadonly = grantedScopes.size === LEAD_INBOX_SCOPES.length && LEAD_INBOX_SCOPES.every(s => grantedScopes.has(s));
            if (!exactlyReadonly) {
                return NextResponse.json({ error: "Granted scope was not exactly gmail.readonly. Not persisted — revoke ProBuild at myaccount.google.com/permissions and connect again." }, { status: 400 });
            }
            let connectedEmail: string | null = null;
            try {
                const { google } = await import("googleapis");
                leadInboxClient.setCredentials(tokens);
                const profile = await google.gmail({ version: "v1", auth: leadInboxClient }).users.getProfile({ userId: "me" });
                connectedEmail = profile.data.emailAddress ?? null;
            } catch {
                connectedEmail = null;
            }
            if (!connectedEmail || connectedEmail.trim().toLowerCase() !== LEAD_INBOX_ADDRESS.toLowerCase()) {
                return NextResponse.json(
                    { error: `Connected mailbox must be ${LEAD_INBOX_ADDRESS}; got ${connectedEmail ?? "unknown (profile lookup failed)"}. Not persisted — sign in to that account and try again.` },
                    { status: 400 },
                );
            }
            const encrypted = encryptLeadInboxRefreshToken(tokens.refresh_token);
            await prisma.companySettings.upsert({
                where: { id: "singleton" },
                create: { id: "singleton", leadInboxRefreshTokenEnc: encrypted, leadInboxEmail: connectedEmail },
                update: { leadInboxRefreshTokenEnc: encrypted, leadInboxEmail: connectedEmail },
            });
            return new NextResponse(
                `<html><body style="font-family:system-ui;padding:40px;max-width:520px"><h2>Lead inbox connected</h2><p>Lead inbox <b>${connectedEmail}</b> is connected, read-only. Speed-to-Lead can now poll it.</p><p>You can close this tab.</p></body></html>`,
                { headers: { "Content-Type": "text/html" } },
            );
        } catch (error) {
            console.error("[speed-to-lead] error exchanging lead-inbox auth code", safeOAuthErrorCategory(error));
            return NextResponse.json({ error: "Failed to exchange auth token" }, { status: 500 });
        }
    }

    // Only company admins may (re)connect the Google account - otherwise
    // anyone could swap in their own Drive and siphon lead media.
    if (!(await callerIsAdmin())) {
        return NextResponse.json({ error: "Admin sign-in required" }, { status: 401 });
    }

    if (!code) {
        const { getAuthUrl } = await import("@/lib/gmail-client");
        return NextResponse.redirect(getAuthUrl());
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);

        // Local dev convenience (file) - ignore failures on read-only hosts.
        try {
            saveToken(tokens);
        } catch {
            // Vercel: fs is not writable; the DB copy below is what matters.
        }

        let connectedEmail: string | null = null;
        if (tokens.refresh_token) {
            // Who did we just connect? (drive.about works with the drive scope)
            try {
                const { google } = await import("googleapis");
                oauth2Client.setCredentials(tokens);
                const about = await google
                    .drive({ version: "v3", auth: oauth2Client })
                    .about.get({ fields: "user(emailAddress)" });
                connectedEmail = about.data.user?.emailAddress ?? null;
            } catch {
                connectedEmail = null;
            }

            await prisma.companySettings.upsert({
                where: { id: "singleton" },
                create: {
                    id: "singleton",
                    googleDriveRefreshToken: tokens.refresh_token,
                    googleDriveEmail: connectedEmail,
                },
                update: {
                    googleDriveRefreshToken: tokens.refresh_token,
                    googleDriveEmail: connectedEmail,
                },
            });
        }

        const note = tokens.refresh_token
            ? `Google account${connectedEmail ? ` <b>${connectedEmail}</b>` : ""} is connected. Lead Drive folders are live.`
            : "Google replied without a refresh token (already connected once?). If Drive uploads fail, revoke ProBuild at myaccount.google.com/permissions and connect again.";

        return new NextResponse(
            `<html><body style="font-family:system-ui;padding:40px;max-width:520px">
                <h2>Google connected</h2>
                <p>${note}</p>
                <p>You can close this tab.</p>
            </body></html>`,
            { headers: { "Content-Type": "text/html" } },
        );
    } catch (error) {
        console.error("[gmail] error exchanging auth code", safeOAuthErrorCategory(error));
        return NextResponse.json({ error: "Failed to exchange auth token" }, { status: 500 });
    }
}
