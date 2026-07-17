import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { oauth2Client, saveToken } from "@/lib/gmail-client";

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

export async function GET(req: NextRequest) {
    // Only company admins may (re)connect the Google account - otherwise
    // anyone could swap in their own Drive and siphon lead media.
    if (!(await callerIsAdmin())) {
        return NextResponse.json({ error: "Admin sign-in required" }, { status: 401 });
    }

    const code = req.nextUrl.searchParams.get("code");

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
        console.error("Error exchanging auth code:", error);
        return NextResponse.json({ error: "Failed to exchange auth token" }, { status: 500 });
    }
}
