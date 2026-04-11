import { NextRequest, NextResponse } from "next/server";
import { oauth2Client, saveToken } from "@/lib/gmail-client";

export async function GET(req: NextRequest) {
    const code = req.nextUrl.searchParams.get("code");
    
    if (!code) {
        // Initial request, redirect to Google Auth URL
        const { getAuthUrl } = await import("@/lib/gmail-client");
        return NextResponse.redirect(getAuthUrl());
    }

    try {
        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        
        // Save tokens locally
        saveToken(tokens);
        
        // Log token server-side only — never expose to browser
        if (tokens.refresh_token) {
            console.log("[Gmail OAuth] Refresh token received — store as GMAIL_REFRESH_TOKEN in Vercel env vars");
        }

        return new NextResponse(`
            <html>
                <body>
                    <h2>Gmail Authorization Successful!</h2>
                    <p>The refresh token has been saved server-side. Copy it from the server logs and set it as <code>GMAIL_REFRESH_TOKEN</code> in your Vercel environment variables.</p>
                    <p>You may now close this tab.</p>
                </body>
            </html>
        `, { headers: { 'Content-Type': 'text/html' }});
    } catch (error) {
        console.error("Error exchanging auth code:", error);
        return NextResponse.json({ error: "Failed to exchange auth token" }, { status: 500 });
    }
}
