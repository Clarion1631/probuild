import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { oauth2Client, saveToken } from "@/lib/gmail-client";
import { newLeadInboxOAuthClient, leadInboxAuthUrl, isLeadInboxState, verifyAndConsumeLeadInboxState } from "@/lib/speed-to-lead/gmail-inbox-client";
import { isApprover, DISPATCH_FROM_ADDRESS } from "@/lib/speed-to-lead/constants";

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

/** Never logs the raw OAuth error (it can carry the authorization code or request/response bodies) — only an allowlisted category and status code. */
function safeOAuthErrorCategory(error: unknown): { category: string; status: number | null } {
    const status = (error as { code?: number })?.code ?? (error as { response?: { status?: number } })?.response?.status ?? null;
    return { category: error instanceof Error ? error.name : "UnknownError", status: typeof status === "number" ? status : null };
}

export async function GET(req: NextRequest) {
    const code = req.nextUrl.searchParams.get("code");
    // Speed-to-Lead (PB-leads-001): ?purpose=lead-inbox connects gtrsupport@
    // as a SECOND, independent Gmail identity — see
    // src/lib/speed-to-lead/gmail-inbox-client.ts for why it must not share
    // this route's default (Drive) client's mutable credentials.
    const state = req.nextUrl.searchParams.get("state");
    const isLeadInbox = req.nextUrl.searchParams.get("purpose") === "lead-inbox" || isLeadInboxState(state);

    if (isLeadInbox) {
        // Justin-only (spec Approval "Who") — this connects the mailbox every
        // automated send goes out through, so ADMIN/MANAGER is not enough.
        const session = await getServerSession(authOptions);
        const sessionEmail = session?.user?.email ?? null;
        if (!isApprover(sessionEmail)) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (!code) {
            return NextResponse.redirect(leadInboxAuthUrl(sessionEmail as string));
        }
        if (!state || !(await verifyAndConsumeLeadInboxState(state, sessionEmail as string))) {
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
            let connectedEmail: string | null = null;
            try {
                const { google } = await import("googleapis");
                leadInboxClient.setCredentials(tokens);
                const profile = await google.gmail({ version: "v1", auth: leadInboxClient }).users.getProfile({ userId: "me" });
                connectedEmail = profile.data.emailAddress ?? null;
            } catch {
                connectedEmail = null;
            }
            // Any mailbox (or a failed profile lookup) used to be accepted —
            // dispatch.ts always sends AS gtrsupport@, so a refresh token for
            // any other mailbox would be silently useless at best, or a real
            // account-mixup at worst. Refuse rather than persist on a mismatch
            // or an unverifiable identity.
            if (!connectedEmail || connectedEmail.trim().toLowerCase() !== DISPATCH_FROM_ADDRESS.toLowerCase()) {
                return NextResponse.json(
                    { error: `Connected mailbox must be ${DISPATCH_FROM_ADDRESS}; got ${connectedEmail ?? "unknown (profile lookup failed)"}. Not persisted — sign in to that account and try again.` },
                    { status: 400 },
                );
            }
            await prisma.companySettings.upsert({
                where: { id: "singleton" },
                create: { id: "singleton", leadInboxRefreshToken: tokens.refresh_token, leadInboxEmail: connectedEmail },
                update: { leadInboxRefreshToken: tokens.refresh_token, leadInboxEmail: connectedEmail },
            });
            return new NextResponse(
                `<html><body style="font-family:system-ui;padding:40px;max-width:520px"><h2>Lead inbox connected</h2><p>Lead inbox <b>${connectedEmail}</b> is connected. Speed-to-Lead can now poll it.</p><p>You can close this tab.</p></body></html>`,
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
